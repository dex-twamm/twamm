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
    }

    //@notice initialize state
    function initialize(
        LongTermOrders storage self,
        uint256 lastVirtualOrderBlock,
        uint256 orderBlockInterval
    ) internal {
        self.lastVirtualOrderBlock = lastVirtualOrderBlock;
        self.orderBlockInterval = orderBlockInterval;
    }

    //@notice adds long term swap to order pool
    function _addLongTermSwap(
        LongTermOrders storage self,
        address owner,
        uint256 from,
        uint256 to,
        uint256 amount,
        uint256 numberOfBlockIntervals,
        uint256[] memory balances
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        //update virtual order state
        executeVirtualOrdersUntilCurrentBlock(self, balances);

        //determine the selling rate based on number of blocks to expiry and total amount
        uint256 orderExpiry = Math.add(
            Math.mul(self.orderBlockInterval, Math.add(numberOfBlockIntervals, 1)),
            Math.sub(block.number, Math.mod(block.number, 10))
        );
        uint256 sellingRate = amount.divDown(Math.sub(orderExpiry, block.number).fromUint());

        //add order to correct pool
        self.orderPoolMap[from].depositOrder(self.orderId, sellingRate, orderExpiry);

        //add to order map
        self.orderMap[self.orderId] = Order(self.orderId, orderExpiry, sellingRate, owner, from, to);

        // transfer sale amount to contract
        _addToLongTermOrdersBalance(self, from, amount);

        uint256 amountAIn = from == 0 ? amount : 0;
        uint256 amountBIn = from == 1 ? amount : 0;

        return (Math.add(self.orderId, 1), amountAIn, amountBIn);
    }

    function performLongTermSwap(
        LongTermOrders storage self,
        address owner,
        bytes memory orderData,
        uint256[] memory balances
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        (
            uint256 sellTokenIndex,
            uint256 buyTokenIndex,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        ) = WeightedPoolUserData.placeLongTermOrder(orderData);

        return _addLongTermSwap(self, owner, sellTokenIndex, buyTokenIndex, amountIn, numberOfBlockIntervals, balances);
    }

    //@notice cancel long term swap, pay out unsold tokens and well as purchased tokens
    function cancelLongTermSwap(
        LongTermOrders storage self,
        address sender,
        uint256 orderId,
        uint256[] memory balances
    ) internal returns (uint256 purchasedAmount, uint256 unsoldAmount) {
        Order storage order = self.orderMap[orderId];
        require(order.owner == sender, "sender must be order owner");

        OrderPoolLib.OrderPool storage orderPool = self.orderPoolMap[order.sellTokenIndex];
        (unsoldAmount, purchasedAmount) = orderPool.cancelOrder(orderId);

        require(unsoldAmount > 0 || purchasedAmount > 0, "no proceeds to withdraw");

        //update LongTermOrders balances
        _removeFromLongTermOrdersBalance(self, order.buyTokenIndex, purchasedAmount);
        _removeFromLongTermOrdersBalance(self, order.sellTokenIndex, unsoldAmount);
    }

    //@notice withdraw proceeds from a long term swap (can be expired or ongoing)
    function withdrawProceedsFromLongTermSwap(
        LongTermOrders storage self,
        address sender,
        uint256 orderId,
        uint256[] memory balances
    ) internal returns (uint256 proceeds) {
        Order storage order = self.orderMap[orderId];
        require(order.owner == sender, "sender must be order owner");

        OrderPoolLib.OrderPool storage orderPool = self.orderPoolMap[order.sellTokenIndex];
        require(orderPool.orderExpiry[orderId] <= block.number, "Order not expired yet");

        proceeds = orderPool.withdrawProceeds(orderId);

        require(proceeds > 0, "no proceeds to withdraw");
        //update long term order balances
        _removeFromLongTermOrdersBalance(self, order.sellTokenIndex, proceeds);
    }

    //@notice executes all virtual orders between current lastVirtualOrderBlock and blockNumber also handles
    //orders that expire at end of final block. This assumes that no orders expire inside the given interval
    function _executeVirtualTradesAndOrderExpiries(
        LongTermOrders storage self,
        uint256[] memory balances,
        uint256 blockNumber
    ) private {
        //amount sold from virtual trades
        uint256 blockNumberIncrement = Math.sub(blockNumber, self.lastVirtualOrderBlock).fromUint();
        uint256 tokenASellAmount = self.orderPoolMap[0].currentSalesRate.mulDown(blockNumberIncrement);
        uint256 tokenBSellAmount = self.orderPoolMap[1].currentSalesRate.mulDown(blockNumberIncrement);

        //initial amm balance
        uint256 tokenAStart = balances[0];
        uint256 tokenBStart = balances[1];

        //updated balances from sales
        (uint256 tokenAOut, uint256 tokenBOut) = _computeVirtualBalances(
            tokenAStart,
            tokenBStart,
            tokenASellAmount,
            tokenBSellAmount
        );

        //update balances reserves
        _addToLongTermOrdersBalance(self, 0, tokenAOut.sub(tokenASellAmount));
        _addToLongTermOrdersBalance(self, 1, tokenBOut.sub(tokenBSellAmount));

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
    }

    //@notice executes all virtual orders until current block is reached.
    function executeVirtualOrdersUntilCurrentBlock(LongTermOrders storage self, uint256[] memory balances) internal {
        uint256 nextExpiryBlock = Math.sub(
            self.lastVirtualOrderBlock,
            Math.add(Math.mod(self.lastVirtualOrderBlock, self.orderBlockInterval), self.orderBlockInterval)
        );
        //iterate through blocks eligible for order expiries, moving state forward
        while (nextExpiryBlock < block.number) {
            _executeVirtualTradesAndOrderExpiries(self, balances, nextExpiryBlock);
            nextExpiryBlock = Math.add(nextExpiryBlock, self.orderBlockInterval);
        }
        //finally, move state to current block if necessary
        if (self.lastVirtualOrderBlock != block.number) {
            _executeVirtualTradesAndOrderExpiries(self, balances, block.number);
        }
    }

    //@notice computes the result of virtual trades by the token pools
    function _computeVirtualBalances(
        uint256 tokenAStart,
        uint256 tokenBStart,
        uint256 tokenAIn,
        uint256 tokenBIn
    ) private pure returns (uint256 tokenAOut, uint256 tokenBOut) {
        //if no tokens are sold to the pool, we don't need to execute any orders
        if (tokenAIn == 0 && tokenBIn == 0) {
            tokenAOut = 0;
            tokenBOut = 0;
        }
        //in the case where only one pool is selling, we just perform a normal swap
        else if (tokenAIn == 0) {
            //constant product formula
            tokenAOut = tokenAStart.mulDown(tokenBIn).divDown(tokenBStart.add(tokenBIn));
            tokenBOut = 0;
        } else if (tokenBIn == 0) {
            tokenAOut = 0;
            //contant product formula
            tokenBOut = tokenBStart.mulDown(tokenAIn).divDown(tokenAStart.add(tokenAIn));
        }
        //when both pools sell, we use the TWAMM formula
        else {
            //signed, fixed point arithmetic
            int256 aIn = tokenAIn.toInt();
            int256 bIn = tokenBIn.toInt();
            int256 aStart = tokenAStart.toInt();
            int256 bStart = tokenBStart.toInt();

            int256 k = aStart.mulUp(bStart);

            int256 c = _computeC(aStart, bStart, aIn, bIn);
            int256 endA = _computeAmmEndTokenA(aIn, bIn, c, k, aStart, bStart);
            int256 endB = aStart.divDown(endA).mulDown(bStart);

            int256 outA = aStart.add(aIn).sub(endA);
            int256 outB = bStart.add(bIn).sub(endB);

            return (outA.toUint(), outB.toUint());
        }
    }

    //helper function for TWAMM formula computation, helps avoid stack depth errors
    function _computeC(
        int256 tokenAStart,
        int256 tokenBStart,
        int256 tokenAIn,
        int256 tokenBIn
    ) private pure returns (int256 c) {
        // TODO fix this
        int256 c1 = tokenAStart.mulDown(tokenBIn);
        int256 c2 = tokenBStart.mulDown(tokenAIn);
        int256 cNumerator = c1.sub(c2);
        int256 cDenominator = c1.add(c2);
        c = cNumerator.divDown(cDenominator);
    }

    //helper function for TWAMM formula computation, helps avoid stack depth errors
    function _computeAmmEndTokenA(
        int256 tokenAIn,
        int256 tokenBIn,
        int256 c,
        int256 k,
        int256 aStart,
        int256 bStart
    ) private pure returns (int256 ammEndTokenA) {
        //rearranged for numerical stability
        // TODO fix this
        // int256 eNumerator = PRBMathSD59x18.fromInt(4).mul(tokenAIn).mul(tokenBIn).sqrt();
        // int256 eDenominator = aStart.sqrt().mul(bStart.sqrt()).inv();
        // int256 exponent = eNumerator.mul(eDenominator).exp();
        // int256 fraction = (exponent + c).div(exponent - c);
        // int256 scaling = k.div(tokenBIn).sqrt().mul(tokenAIn.sqrt());
        // ammEndTokenA = fraction.mul(scaling);

        int256 eNumerator = 1;
        int256 eDenominator = aStart * bStart;
        int256 exponent = eNumerator * eDenominator;
        int256 fraction = (exponent + c) / (exponent - c);
        int256 scaling = (k / (tokenBIn)) * (tokenAIn);
        ammEndTokenA = fraction * scaling;
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
            self.balanceA = self.balanceA.add(balance);
        } else if (tokenIndex == 1) {
            self.balanceB = self.balanceB.add(balance);
        }
    }

    function getTokenBalanceFromLongTermOrder(LongTermOrders storage self, uint8 tokenIndex)
        internal
        returns (uint256 balance)
    {
        return tokenIndex == 0 ? self.balanceA : self.balanceB;
    }
}
