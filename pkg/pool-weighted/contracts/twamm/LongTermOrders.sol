//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;

import "hardhat/console.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/SignedFixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";
import "./OrderPool.sol";
import "../WeightedPoolUserData.sol";

//@notice This library handles the state and execution of long term orders.
library LongTermOrdersLib {
    using FixedPoint for uint256;
    using SignedFixedPoint for int256;
    using OrderPoolLib for OrderPoolLib.OrderPool;

    //@notice information associated with a long term order
    struct Order {
        uint256 id;
        uint256 expirationBlock;
        uint256 saleRate;
        address owner;
        uint256 sellTokenIndex;
        uint256 buyTokenIndex;
    }

    //@notice structure contains full state related to long term orders
    struct LongTermOrders {
        //@notice minimum block interval between order expiries
        uint256 orderBlockInterval;
        //@notice last virtual orders were executed immediately before this block
        uint256 lastVirtualOrderBlock;
        uint256 balanceA;
        uint256 balanceB;
        //@notice mapping from token address to pool that is selling that token
        //we maintain two order pools, one for each token that is tradable in the AMM
        mapping(uint256 => OrderPoolLib.OrderPool) orderPoolMap;
        //@notice incrementing counter for order ids
        uint256 orderId;
        //@notice mapping from order ids to Orders
        mapping(uint256 => Order) orderMap;
        uint256 maxltoOrderAmountToAmmBalanceRatio;
        uint256 minltoOrderAmountToAmmBalanceRatio;
    }

    //@notice initialize state
    function initialize(
        LongTermOrders storage self,
        uint256 lastVirtualOrderBlock,
        uint256 orderBlockInterval
    ) internal {
        self.lastVirtualOrderBlock = lastVirtualOrderBlock;
        self.orderBlockInterval = orderBlockInterval;

        self.maxltoOrderAmountToAmmBalanceRatio = 1e17;
        self.minltoOrderAmountToAmmBalanceRatio = 1e14;
    }

    function performLongTermSwap(
        LongTermOrders storage self,
        address owner,
        uint256[] memory balances,
        uint256 sellTokenIndex,
        uint256 buyTokenIndex,
        uint256 amountIn,
        uint256 numberOfBlockIntervals
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        executeVirtualOrdersUntilCurrentBlock(self, balances);

        _require(
            amountIn > balances[sellTokenIndex].mulUp(self.minltoOrderAmountToAmmBalanceRatio),
            Errors.LONG_TERM_ORDER_AMOUNT_TOO_LOW
        );
        _require(
            amountIn < balances[sellTokenIndex].mulUp(self.maxltoOrderAmountToAmmBalanceRatio),
            Errors.LONG_TERM_ORDER_AMOUNT_TOO_LARGE
        );

        return _addLongTermSwap(self, owner, sellTokenIndex, buyTokenIndex, amountIn, numberOfBlockIntervals);
    }

    //@notice adds long term swap to order pool
    function _addLongTermSwap(
        LongTermOrders storage self,
        address owner,
        uint256 from,
        uint256 to,
        uint256 amount,
        uint256 numberOfBlockIntervals
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        //determine the selling rate based on number of blocks to expiry and total amount
        uint256 orderExpiry = _getOrderExpiry(self, numberOfBlockIntervals);
        uint256 sellingRate = amount.divDown(Math.sub(orderExpiry, block.number).fromUint());

        //add order to correct pool
        self.orderPoolMap[from].depositOrder(self.orderId, sellingRate, orderExpiry);

        //add to order map
        self.orderMap[self.orderId] = Order(self.orderId, orderExpiry, sellingRate, owner, from, to);

        // transfer sale amount to contract
        _addToLongTermOrdersBalance(self, from, amount);

        uint256 amountAIn = from == 0 ? amount : 0;
        uint256 amountBIn = from == 1 ? amount : 0;

        uint256 orderId = self.orderId;

        self.orderId = self.orderId + 1;

        return (orderId, amountAIn, amountBIn);
    }

    //@notice cancel long term swap, pay out unsold tokens and well as purchased tokens
    function cancelLongTermSwap(
        LongTermOrders storage self,
        address sender,
        uint256 orderId
    )
        internal
        returns (
            uint256 purchasedAmount,
            uint256 unsoldAmount,
            Order memory order
        )
    {
        order = self.orderMap[orderId];
        _require(order.owner == sender, Errors.CALLER_IS_NOT_OWNER);

        OrderPoolLib.OrderPool storage orderPool = self.orderPoolMap[order.sellTokenIndex];
        (unsoldAmount, purchasedAmount) = orderPool.cancelOrder(orderId, self.lastVirtualOrderBlock);

        //update LongTermOrders balances
        _removeFromLongTermOrdersBalance(self, order.buyTokenIndex, purchasedAmount);
        _removeFromLongTermOrdersBalance(self, order.sellTokenIndex, unsoldAmount);

        // clean up order data
        delete self.orderMap[orderId];
    }

    //@notice withdraw proceeds from a long term swap (can be expired or ongoing)
    function withdrawProceedsFromLongTermSwap(
        LongTermOrders storage self,
        address sender,
        uint256 orderId
    ) internal returns (uint256 proceeds, Order memory order) {
        order = self.orderMap[orderId];
        _require(order.owner == sender, Errors.CALLER_IS_NOT_OWNER);

        OrderPoolLib.OrderPool storage orderPool = self.orderPoolMap[order.sellTokenIndex];
        _require(orderPool.orderExpiry[orderId] <= block.number, Errors.LONG_TERM_ORDER_ORDER_NOT_COMPLETED);

        proceeds = orderPool.withdrawProceeds(orderId, self.lastVirtualOrderBlock);

        _require(proceeds > 0, Errors.NO_PROCEEDS_TO_WITHDRAW);
        //update long term order balances
        _removeFromLongTermOrdersBalance(self, order.buyTokenIndex, proceeds);

        // clean up order data
        delete self.orderMap[orderId];
    }

    //@notice executes all virtual orders until current block is reached.
    function executeVirtualOrdersUntilCurrentBlock(LongTermOrders storage self, uint256[] memory balances)
        internal
        returns (uint256 ammTokenA, uint256 ammTokenB)
    {
        ammTokenA = balances[0];
        ammTokenB = balances[1];

        uint256 nextExpiryBlock = Math.add(
            Math.sub(self.lastVirtualOrderBlock, Math.mod(self.lastVirtualOrderBlock, self.orderBlockInterval)),
            self.orderBlockInterval
        );
        //iterate through blocks eligible for order expiries, moving state forward
        while (nextExpiryBlock < block.number) {
            (ammTokenA, ammTokenB) = _executeVirtualTradesAndOrderExpiries(self, ammTokenA, ammTokenB, nextExpiryBlock);
            nextExpiryBlock = Math.add(nextExpiryBlock, self.orderBlockInterval);
        }
        //finally, move state to current block if necessary
        if (self.lastVirtualOrderBlock != block.number) {
            (ammTokenA, ammTokenB) = _executeVirtualTradesAndOrderExpiries(self, ammTokenA, ammTokenB, block.number);
        }
    }

    //@notice executes all virtual orders between current lastVirtualOrderBlock and blockNumber also handles
    //orders that expire at end of final block. This assumes that no orders expire inside the given interval
    function _executeVirtualTradesAndOrderExpiries(
        LongTermOrders storage self,
        uint256 tokenAStart,
        uint256 tokenBStart,
        uint256 blockNumber
    ) private returns (uint256, uint256) {
        //amount sold from virtual trades
        uint256 blockNumberIncrement = Math.sub(blockNumber, self.lastVirtualOrderBlock).fromUint();
        uint256 tokenASellAmount = self.orderPoolMap[0].currentSalesRate.mulDown(blockNumberIncrement);
        uint256 tokenBSellAmount = self.orderPoolMap[1].currentSalesRate.mulDown(blockNumberIncrement);

        //updated balances from sales
        (uint256 tokenAOut, uint256 tokenBOut, uint256 ammEndTokenA, uint256 ammEndTokenB) = _computeVirtualBalances(
            tokenAStart,
            tokenBStart,
            tokenASellAmount,
            tokenBSellAmount
        );

        //update balances reserves
        _addToLongTermOrdersBalance(self, 0, tokenAOut.toSignedFixedPoint().sub(tokenASellAmount.toSignedFixedPoint()));
        _addToLongTermOrdersBalance(self, 1, tokenBOut.toSignedFixedPoint().sub(tokenBSellAmount.toSignedFixedPoint()));

        //distribute proceeds to pools
        OrderPoolLib.OrderPool storage orderPoolA = self.orderPoolMap[0];
        OrderPoolLib.OrderPool storage orderPoolB = self.orderPoolMap[1];

        orderPoolA.distributePayment(tokenBOut);
        orderPoolB.distributePayment(tokenAOut);

        //handle orders expiring at end of interval
        orderPoolA.updateStateFromBlockExpiry(blockNumber);
        orderPoolB.updateStateFromBlockExpiry(blockNumber);

        //update last virtual trade block
        self.lastVirtualOrderBlock = blockNumber;

        return (ammEndTokenA, ammEndTokenB);
    }

    //@notice computes the result of virtual trades by the token pools
    function _computeVirtualBalances(
        uint256 tokenAStart,
        uint256 tokenBStart,
        uint256 tokenAIn,
        uint256 tokenBIn
    )
        private
        pure
        returns (
            uint256 tokenAOut,
            uint256 tokenBOut,
            uint256 ammEndTokenA,
            uint256 ammEndTokenB
        )
    {
        //if no tokens are sold to the pool, we don't need to execute any orders
        if (tokenAIn == 0 && tokenBIn == 0) {
            tokenAOut = 0;
            tokenBOut = 0;
            ammEndTokenA = tokenAStart;
            ammEndTokenB = tokenBStart;
        }
        //in the case where only one pool is selling, we just perform a normal swap
        else if (tokenAIn == 0) {
            //constant product formula
            tokenBOut = 0;
            ammEndTokenB = tokenBStart.add(tokenBIn);
            tokenAOut = tokenAStart.mulDown(tokenBIn).divDown(ammEndTokenB);
            ammEndTokenA = tokenAStart.sub(tokenAOut);
        } else if (tokenBIn == 0) {
            tokenAOut = 0;
            ammEndTokenA = tokenAStart.add(tokenAIn);
            tokenBOut = tokenBStart.mulDown(tokenAIn).divDown(ammEndTokenA);
            ammEndTokenB = tokenBStart.sub(tokenBOut);
        }
        //when both pools sell, we use the TWAMM formula
        else {
            ammEndTokenA = _computeAmmEndTokenA(tokenAIn, tokenBIn, tokenAStart, tokenBStart);
            ammEndTokenB = tokenAStart.divDown(ammEndTokenA).mulDown(tokenBStart);
            tokenAOut = tokenAStart.add(tokenAIn).sub(ammEndTokenA);
            tokenBOut = tokenBStart.add(tokenBIn).sub(ammEndTokenB);
        }
    }

    //helper function for TWAMM formula computation, helps avoid stack depth errors
    function _computeAmmEndTokenA(
        uint256 tokenAIn,
        uint256 tokenBIn,
        uint256 aStart,
        uint256 bStart
    ) private pure returns (uint256 ammEndTokenA) {
        uint256 k = aStart.mulUp(bStart);
        int256 c = _computeC(tokenAIn, tokenBIn, aStart, bStart);
        uint256 ePow = FixedPoint.fromUint(4).mulDown(tokenAIn).mulDown(tokenBIn).divDown(k).sqrt();
        int256 exponent = (ePow.exp()).toSignedFixedPoint();
        int256 fraction = (exponent.add(c)).divDown(exponent.sub(c));
        uint256 scaling = k.divDown(tokenBIn).sqrt().mulDown(tokenAIn.sqrt());

        ammEndTokenA = fraction.toFixedPoint().mulDown(scaling);
    }

    function _computeC(
        uint256 tokenAIn,
        uint256 tokenBIn,
        uint256 aStart,
        uint256 bStart
    ) private pure returns (int256 c) {
        uint256 c1 = aStart.mulDown(tokenBIn).sqrt();
        uint256 c2 = bStart.mulDown(tokenAIn).sqrt();
        int256 cNumerator = c1.toSignedFixedPoint().sub(c2.toSignedFixedPoint());
        uint256 cDenominator = c1.add(c2);

        c = cNumerator.divDown(cDenominator.toSignedFixedPoint());
    }

    function _addToLongTermOrdersBalance(
        LongTermOrders storage self,
        uint256 tokenIndex,
        int256 balance
    ) internal {
        if (tokenIndex == 0) {
            self.balanceA = Math.add(self.balanceA.toSignedFixedPoint(), balance).toFixedPoint();
        } else if (tokenIndex == 1) {
            self.balanceB = Math.add(self.balanceB.toSignedFixedPoint(), balance).toFixedPoint();
        }
    }

    function _addToLongTermOrdersBalance(
        LongTermOrders storage self,
        uint256 tokenIndex,
        uint256 balance
    ) internal {
        if (tokenIndex == 0) {
            self.balanceA = Math.add(self.balanceA, balance);
        } else if (tokenIndex == 1) {
            self.balanceB = Math.add(self.balanceB, balance);
        }
    }

    function _removeFromLongTermOrdersBalance(
        LongTermOrders storage self,
        uint256 tokenIndex,
        uint256 balance
    ) internal {
        if (tokenIndex == 0) {
            self.balanceA = self.balanceA.sub(balance);
        } else if (tokenIndex == 1) {
            self.balanceB = self.balanceB.sub(balance);
        }
    }

    function getTokenBalanceFromLongTermOrder(LongTermOrders storage self, uint8 tokenIndex)
        internal
        view
        returns (uint256 balance)
    {
        return tokenIndex == 0 ? self.balanceA : self.balanceB;
    }

    function _getOrderExpiry(LongTermOrders storage self, uint256 numberOfBlockIntervals)
        internal
        view
        returns (uint256)
    {
        return
            Math.add(
                Math.mul(self.orderBlockInterval, Math.add(numberOfBlockIntervals, 1)),
                Math.sub(block.number, Math.mod(block.number, self.orderBlockInterval))
            );
    }
}
