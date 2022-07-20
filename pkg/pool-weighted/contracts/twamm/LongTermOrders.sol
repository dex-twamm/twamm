//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ILongTermOrders.sol";
import "./OrderPool.sol";
import "./SignedFixedPoint.sol";
import "../WeightedPoolUserData.sol";

import "hardhat/console.sol";

//@notice This library handles the state and execution of long term orders.
contract LongTermOrders is ILongTermOrders, Ownable {
    using FixedPoint for uint256;
    using SignedFixedPoint for int256;
    using OrderPoolLib for OrderPoolLib.OrderPool;

    //@notice structure contains full state related to long term orders
    struct LongTermOrdersStruct {
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
        uint256 lastOrderId;
        //@notice mapping from order ids to Orders
        mapping(uint256 => Order) orderMap;
        uint256 maxltoOrderAmountToAmmBalanceRatio;
        uint256 minltoOrderAmountToAmmBalanceRatio;
    }

    LongTermOrdersStruct public longTermOrders;

    constructor(uint256 _orderBlockInterval) Ownable() {
        longTermOrders.lastVirtualOrderBlock = block.number;
        longTermOrders.orderBlockInterval = _orderBlockInterval;

        longTermOrders.maxltoOrderAmountToAmmBalanceRatio = 1e17;
        longTermOrders.minltoOrderAmountToAmmBalanceRatio = 1e14;
    }

    function performLongTermSwap(
        address owner,
        uint256[] memory balances,
        uint256 sellTokenIndex,
        uint256 buyTokenIndex,
        uint256 amountIn,
        uint256 numberOfBlockIntervals
    )
        external
        override
        onlyOwner
        returns (
            Order memory,
            uint256,
            uint256
        )
    {
        _require(
            amountIn > balances[sellTokenIndex].mulUp(longTermOrders.minltoOrderAmountToAmmBalanceRatio),
            Errors.LONG_TERM_ORDER_AMOUNT_TOO_LOW
        );
        _require(
            amountIn < balances[sellTokenIndex].mulUp(longTermOrders.maxltoOrderAmountToAmmBalanceRatio),
            Errors.LONG_TERM_ORDER_AMOUNT_TOO_LARGE
        );

        // TODO add check for sales rate not greater than certain limit

        executeVirtualOrdersUntilCurrentBlock(balances);
        return _addLongTermSwap(owner, sellTokenIndex, buyTokenIndex, amountIn, numberOfBlockIntervals);
    }

    //@notice adds long term swap to order pool
    function _addLongTermSwap(
        address owner,
        uint256 from,
        uint256 to,
        uint256 amount,
        uint256 numberOfBlockIntervals
    )
        internal
        returns (
            Order memory,
            uint256,
            uint256
        )
    {
        uint256 orderId = longTermOrders.lastOrderId;
        longTermOrders.lastOrderId++;

        //determine the selling rate based on number of blocks to expiry and total amount
        uint256 orderExpiry = _getOrderExpiry(numberOfBlockIntervals);
        uint256 sellingRate = amount.divDown(Math.sub(orderExpiry, block.number).fromUint());

        //add order to correct pool
        longTermOrders.orderPoolMap[from].depositOrder(orderId, sellingRate, orderExpiry);

        //add to order map
        Order memory order = Order(orderId, orderExpiry, sellingRate, owner, from, to);
        longTermOrders.orderMap[orderId] = order;

        // transfer sale amount to contract
        _addToLongTermOrdersBalance(from, amount);

        uint256 amountAIn = from == 0 ? amount : 0;
        uint256 amountBIn = from == 1 ? amount : 0;

        return (order, amountAIn, amountBIn);
    }

    //@notice cancel long term swap, pay out unsold tokens and well as purchased tokens
    function cancelLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] memory balances
    )
        external
        override
        onlyOwner
        returns (
            uint256 purchasedAmount,
            uint256 unsoldAmount,
            Order memory order
        )
    {
        executeVirtualOrdersUntilCurrentBlock(balances);

        order = longTermOrders.orderMap[orderId];
        _require(order.owner == sender, Errors.CALLER_IS_NOT_OWNER);

        OrderPoolLib.OrderPool storage orderPool = longTermOrders.orderPoolMap[order.sellTokenIndex];
        (unsoldAmount, purchasedAmount) = orderPool.cancelOrder(orderId, longTermOrders.lastVirtualOrderBlock);

        //update LongTermOrders balances
        _removeFromLongTermOrdersBalance(order.buyTokenIndex, purchasedAmount);
        _removeFromLongTermOrdersBalance(order.sellTokenIndex, unsoldAmount);

        // clean up order data
        delete longTermOrders.orderMap[orderId];
    }

    //@notice withdraw proceeds from a long term swap (can be expired or ongoing)
    function withdrawProceedsFromLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] memory balances
    ) external override onlyOwner returns (uint256 proceeds, Order memory order) {
        executeVirtualOrdersUntilCurrentBlock(balances);

        order = longTermOrders.orderMap[orderId];
        _require(order.owner == sender, Errors.CALLER_IS_NOT_OWNER);

        OrderPoolLib.OrderPool storage orderPool = longTermOrders.orderPoolMap[order.sellTokenIndex];
        _require(orderPool.orderExpiry[orderId] <= block.number, Errors.LONG_TERM_ORDER_ORDER_NOT_COMPLETED);

        proceeds = orderPool.withdrawProceeds(orderId, longTermOrders.lastVirtualOrderBlock);

        _require(proceeds > 0, Errors.NO_PROCEEDS_TO_WITHDRAW);
        //update long term order balances
        _removeFromLongTermOrdersBalance(order.buyTokenIndex, proceeds);

        // clean up order data
        delete longTermOrders.orderMap[orderId];
    }

    //@notice executes all virtual orders until current block is reached.
    function executeVirtualOrdersUntilCurrentBlock(uint256[] memory balances)
        public
        override
        onlyOwner
        returns (uint256 ammTokenA, uint256 ammTokenB)
    {
        ammTokenA = balances[0];
        ammTokenB = balances[1];

        uint256 nextExpiryBlock = Math.add(
            Math.sub(
                longTermOrders.lastVirtualOrderBlock,
                Math.mod(longTermOrders.lastVirtualOrderBlock, longTermOrders.orderBlockInterval)
            ),
            longTermOrders.orderBlockInterval
        );
        //iterate through blocks eligible for order expiries, moving state forward
        while (nextExpiryBlock < block.number) {
            (ammTokenA, ammTokenB) = _executeVirtualTradesAndOrderExpiries(ammTokenA, ammTokenB, nextExpiryBlock, true);
            nextExpiryBlock = Math.add(nextExpiryBlock, longTermOrders.orderBlockInterval);
        }
        //finally, move state to current block if necessary
        if (longTermOrders.lastVirtualOrderBlock != block.number) {
            bool isExpiryBlock = Math.mod(block.number, longTermOrders.orderBlockInterval) == 0;
            (ammTokenA, ammTokenB) = _executeVirtualTradesAndOrderExpiries(
                ammTokenA,
                ammTokenB,
                block.number,
                isExpiryBlock
            );
        }
    }

    //@notice executes all virtual orders between current lastVirtualOrderBlock and blockNumber also handles
    //orders that expire at end of final block. This assumes that no orders expire inside the given interval
    function _executeVirtualTradesAndOrderExpiries(
        uint256 tokenAStart,
        uint256 tokenBStart,
        uint256 blockNumber,
        bool isExpiryBlock
    ) private returns (uint256, uint256) {
        //amount sold from virtual trades
        uint256 blockNumberIncrement = Math.sub(blockNumber, longTermOrders.lastVirtualOrderBlock).fromUint();
        uint256 tokenASellAmount = longTermOrders.orderPoolMap[0].currentSalesRate.mulDown(blockNumberIncrement);
        uint256 tokenBSellAmount = longTermOrders.orderPoolMap[1].currentSalesRate.mulDown(blockNumberIncrement);

        //updated balances from sales
        (uint256 tokenAOut, uint256 tokenBOut, uint256 ammEndTokenA, uint256 ammEndTokenB) = _computeVirtualBalances(
            tokenAStart,
            tokenBStart,
            tokenASellAmount,
            tokenBSellAmount
        );

        //update balances reserves
        _addToLongTermOrdersBalance(0, tokenAOut.toSignedFixedPoint().sub(tokenASellAmount.toSignedFixedPoint()));
        _addToLongTermOrdersBalance(1, tokenBOut.toSignedFixedPoint().sub(tokenBSellAmount.toSignedFixedPoint()));

        //distribute proceeds to pools
        OrderPoolLib.OrderPool storage orderPoolA = longTermOrders.orderPoolMap[0];
        OrderPoolLib.OrderPool storage orderPoolB = longTermOrders.orderPoolMap[1];

        orderPoolA.distributePayment(tokenBOut);
        orderPoolB.distributePayment(tokenAOut);

        //handle orders expiring at end of interval
        // TODO verify added check if this is an actual expiry block
        if (isExpiryBlock) {
            orderPoolA.updateStateFromBlockExpiry(blockNumber);
            orderPoolB.updateStateFromBlockExpiry(blockNumber);
        }

        //update last virtual trade block
        longTermOrders.lastVirtualOrderBlock = blockNumber;

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

    function _addToLongTermOrdersBalance(uint256 tokenIndex, int256 balance) internal {
        if (tokenIndex == 0) {
            longTermOrders.balanceA = Math.add(longTermOrders.balanceA.toSignedFixedPoint(), balance).toFixedPoint();
        } else if (tokenIndex == 1) {
            longTermOrders.balanceB = Math.add(longTermOrders.balanceB.toSignedFixedPoint(), balance).toFixedPoint();
        }
    }

    function _addToLongTermOrdersBalance(uint256 tokenIndex, uint256 balance) internal {
        if (tokenIndex == 0) {
            longTermOrders.balanceA = Math.add(longTermOrders.balanceA, balance);
        } else if (tokenIndex == 1) {
            longTermOrders.balanceB = Math.add(longTermOrders.balanceB, balance);
        }
    }

    function _removeFromLongTermOrdersBalance(uint256 tokenIndex, uint256 balance) internal {
        if (tokenIndex == 0) {
            longTermOrders.balanceA = longTermOrders.balanceA.sub(balance);
        } else if (tokenIndex == 1) {
            longTermOrders.balanceB = longTermOrders.balanceB.sub(balance);
        }
    }

    function getTokenBalanceFromLongTermOrder(uint8 tokenIndex) external view override returns (uint256 balance) {
        return tokenIndex == 0 ? longTermOrders.balanceA : longTermOrders.balanceB;
    }

    function _getOrderExpiry(uint256 numberOfBlockIntervals) internal view returns (uint256) {
        uint256 mod = Math.mod(block.number, longTermOrders.orderBlockInterval);
        if (mod > 0) {
            numberOfBlockIntervals = Math.add(numberOfBlockIntervals, 1);
        }

        return
            Math.add(Math.mul(longTermOrders.orderBlockInterval, numberOfBlockIntervals), Math.sub(block.number, mod));
    }

    function setMaxltoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRation) external onlyOwner {
        longTermOrders.maxltoOrderAmountToAmmBalanceRatio = amountToAmmBalanceRation;
    }

    function setMinltoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRation) external onlyOwner {
        longTermOrders.minltoOrderAmountToAmmBalanceRatio = amountToAmmBalanceRation;
    }

    function getLongTermOrder(uint256 orderId)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            address,
            uint256,
            uint256
        )
    {
        Order memory order = longTermOrders.orderMap[orderId];
        return (
            order.id,
            order.expirationBlock,
            order.saleRate,
            order.owner,
            order.sellTokenIndex,
            order.buyTokenIndex
        );
    }
}
