//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ILongTermOrders.sol";
import "./OrderPool.sol";
import "./MinHeap.sol";
import "./SignedFixedPoint.sol";
import "../WeightedPoolUserData.sol";

import "hardhat/console.sol";

//@notice This library handles the state and execution of long term orders.
contract LongTermOrders is ILongTermOrders, Ownable {
    using FixedPoint for uint256;
    using SignedFixedPoint for int256;
    using OrderPoolLib for OrderPoolLib.OrderPool;
    using MinHeap for uint256[];

    //@notice structure contains full state related to long term orders
    struct LongTermOrdersStruct {
        //@notice minimum block interval between order expiries
        uint32 orderBlockInterval;
        //@notice incrementing counter for order ids
        uint32 lastOrderId;
        uint64 maxPerBlockSaleRatePercent;
        uint64 minltoOrderAmountToAmmBalanceRatio;
        //@notice last virtual orders were executed immediately before this block
        uint64 lastVirtualOrderBlock;
        uint256 balanceA;
        uint256 balanceB;
        //@notice mapping from token address to pool that is selling that token
        // We maintain two order pools, one for each token that is tradable in the AMM
        mapping(uint256 => OrderPoolLib.OrderPool) orderPoolMap;
        //@notice mapping from order ids to Orders
        mapping(uint256 => Order) orderMap;
        uint256[] orderExpiryHeap;
    }

    LongTermOrdersStruct public longTermOrders;
    uint256 private _maxUniqueOrderExpiries = 20;
    uint256 private _maxNumberOfBlockIntervals = 48;
    uint256 private _maxVirtualOrderExecutionLoops = 750;

    constructor(uint256 _orderBlockInterval) Ownable() {
        longTermOrders.lastVirtualOrderBlock = uint64(block.number);
        longTermOrders.orderBlockInterval = uint32(_orderBlockInterval);

        longTermOrders.maxPerBlockSaleRatePercent = uint64(1e16);
        longTermOrders.minltoOrderAmountToAmmBalanceRatio = uint64(1e14);

        // Setup heap
        longTermOrders.orderExpiryHeap.push(0);
    }

    function performLongTermSwap(
        address owner,
        uint256[] calldata balances,
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
            amountIn > balances[sellTokenIndex].mulUp(uint256(longTermOrders.minltoOrderAmountToAmmBalanceRatio)),
            Errors.LONG_TERM_ORDER_AMOUNT_TOO_LOW
        );

        _require(numberOfBlockIntervals > 0, Errors.LONG_TERM_ORDER_NUM_INTERVALS_TOO_LOW);

        executeVirtualOrdersUntilCurrentBlock(balances);
        return _addLongTermSwap(owner, balances, sellTokenIndex, buyTokenIndex, amountIn, numberOfBlockIntervals);
    }

    //@notice adds long term swap to order pool
    function _addLongTermSwap(
        address owner,
        uint256[] calldata balances,
        uint256 sellTokenIndex,
        uint256 buyTokenIndex,
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
        uint256 orderId = uint256(longTermOrders.lastOrderId);
        ++longTermOrders.lastOrderId;

        // Determine the selling rate based on number of blocks to expiry and total amount
        uint256 orderExpiry = _getOrderExpiry(numberOfBlockIntervals);

        // Selling rate = amount / number of blocks
        // orderExpiry guaranteed to be > block.number.
        uint256 sellingRate = amount.divDown((orderExpiry - block.number).fromUint());

        // If there are no other orders expiring at this block, we need to protect against attack.
        if (
            longTermOrders.orderPoolMap[0].ordersExpiringAtBlock[orderExpiry] == 0 &&
            longTermOrders.orderPoolMap[1].ordersExpiringAtBlock[orderExpiry] == 0
        ) {
            if (longTermOrders.orderExpiryHeap.length > _maxUniqueOrderExpiries) {
                _require(
                    numberOfBlockIntervals <= _maxNumberOfBlockIntervals,
                    Errors.LONG_TERM_ORDER_NUM_INTERVALS_TOO_HIGH
                );
            }
            // Only insert block number in order expiry heap if it's not already there.
            longTermOrders.orderExpiryHeap.insert(orderExpiry);
        }

        // Add order to the correct pool.
        longTermOrders.orderPoolMap[sellTokenIndex].depositOrder(orderId, sellingRate, orderExpiry);

        // Add to order map
        Order memory order = Order(orderId, orderExpiry, sellingRate, owner, sellTokenIndex, buyTokenIndex);
        longTermOrders.orderMap[orderId] = order;

        // Update accounting for the sale amount.
        _addToLongTermOrdersBalance(sellTokenIndex, amount);

        _checkIfNewSalesRateTooHigh(sellTokenIndex, balances);

        if (sellTokenIndex == 0) {
            return (order, amount, 0);
        } else {
            return (order, 0, amount);
        }
    }

    //@notice cancel long term swap, pay out unsold tokens and well as purchased tokens
    function cancelLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] calldata balances
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
        uint256 orderExpirationBlock = longTermOrders.orderMap[orderId].expirationBlock;

        (unsoldAmount, purchasedAmount) = orderPool.cancelOrder(
            orderId,
            longTermOrders.lastVirtualOrderBlock,
            longTermOrders.orderMap[orderId].saleRate,
            orderExpirationBlock
        );

        // Remove amounts from LongTermOrders balances.
        _removeFromLongTermOrdersBalance(order.buyTokenIndex, purchasedAmount);
        _removeFromLongTermOrdersBalance(order.sellTokenIndex, unsoldAmount);

        // Clean up order data
        delete longTermOrders.orderMap[orderId];
        orderPool.cleanUpOrder(orderId, orderExpirationBlock);
    }

    // @notice withdraw proceeds from a long term swap (can be expired or ongoing)
    function withdrawProceedsFromLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] calldata balances
    )
        external
        override
        onlyOwner
        returns (
            uint256 proceeds,
            Order memory order,
            bool isPartialWithdrawal
        )
    {
        executeVirtualOrdersUntilCurrentBlock(balances);

        order = longTermOrders.orderMap[orderId];
        _require(order.owner == sender, Errors.CALLER_IS_NOT_OWNER);

        OrderPoolLib.OrderPool storage orderPool = longTermOrders.orderPoolMap[order.sellTokenIndex];
        uint256 orderExpirationBlock = longTermOrders.orderMap[orderId].expirationBlock;

        (proceeds, isPartialWithdrawal) = orderPool.withdrawProceeds(
            orderId,
            longTermOrders.lastVirtualOrderBlock,
            longTermOrders.orderMap[orderId].saleRate,
            orderExpirationBlock
        );

        _require(proceeds > 0, Errors.NO_PROCEEDS_TO_WITHDRAW);
        // Update long term order balances
        _removeFromLongTermOrdersBalance(order.buyTokenIndex, proceeds);

        // Clean up order data
        if (!isPartialWithdrawal) {
            delete longTermOrders.orderMap[orderId];
            orderPool.cleanUpOrder(orderId, orderExpirationBlock);
        }
    }

    //@notice executes all virtual orders until current block is reached.
    function executeVirtualOrdersUntilCurrentBlock(uint256[] calldata balances)
        public
        override
        onlyOwner
        returns (uint256 ammTokenA, uint256 ammTokenB)
    {
        if (longTermOrders.lastVirtualOrderBlock == uint64(block.number)) {
            return (balances[0], balances[1]);
        }

        ammTokenA = balances[0];
        ammTokenB = balances[1];

        uint256 num_loops = 0;

        while (longTermOrders.orderExpiryHeap.length != 1 && num_loops < _maxVirtualOrderExecutionLoops) {
            // Look for next order expiry block number in heap.
            uint256 nextOrderExpiryBlock = longTermOrders.orderExpiryHeap.getMin();

            // Directly jump to current block number if no order has expired until it.
            if (nextOrderExpiryBlock >= block.number) {
                (ammTokenA, ammTokenB) = _executeVirtualTradesAndOrderExpiries(
                    ammTokenA,
                    ammTokenB,
                    block.number,
                    nextOrderExpiryBlock == block.number
                );

                // If next order expiry is current block, pop from heap.
                // Looping, because there can be multiple orders expiring at same block.
                if (nextOrderExpiryBlock == block.number) {
                    // Assumption: nextOrderExpiryBlock is at top of the heap.
                    // do while saves operations for one condition check.
                    do {
                        longTermOrders.orderExpiryHeap.removeMin();
                    } while (
                        longTermOrders.orderExpiryHeap.length != 1 &&
                            nextOrderExpiryBlock == longTermOrders.orderExpiryHeap.getMin()
                    );
                }
                break;
            } else {
                // Directly jump to nextOrderExpiryBlock.
                (ammTokenA, ammTokenB) = _executeVirtualTradesAndOrderExpiries(
                    ammTokenA,
                    ammTokenB,
                    nextOrderExpiryBlock,
                    true
                );

                // Assumption: nextOrderExpiryBlock is at top of the heap.
                // do while saves operations for one condition check.
                do {
                    longTermOrders.orderExpiryHeap.removeMin();
                } while (
                    longTermOrders.orderExpiryHeap.length != 1 &&
                        nextOrderExpiryBlock == longTermOrders.orderExpiryHeap.getMin()
                );
            }
            num_loops += 1;
        }
        if (longTermOrders.orderExpiryHeap.length == 1) {
            longTermOrders.lastVirtualOrderBlock = uint64(block.number);
        }
    }

    function _checkIfNewSalesRateTooHigh(uint256 sellTokenIndex, uint256[] calldata balances) internal view {
        uint256 maxPerBlockSaleRatePercent = uint256(longTermOrders.maxPerBlockSaleRatePercent);

        _require(
            longTermOrders.orderPoolMap[sellTokenIndex].currentSalesRate <=
                maxPerBlockSaleRatePercent.mulDown(balances[sellTokenIndex]),
            Errors.LONG_TERM_ORDER_AMOUNT_TOO_LARGE
        );
    }

    //@notice executes all virtual orders between current lastVirtualOrderBlock and blockNumber also handles
    //orders that expire at end of final block. This assumes that no orders expire inside the given interval
    function _executeVirtualTradesAndOrderExpiries(
        uint256 tokenAStart,
        uint256 tokenBStart,
        uint256 blockNumber,
        bool isExpiryBlock
    ) private returns (uint256, uint256) {
        OrderPoolLib.OrderPool storage orderPoolA = longTermOrders.orderPoolMap[0];
        OrderPoolLib.OrderPool storage orderPoolB = longTermOrders.orderPoolMap[1];

        // Amounts to be sold from virtual trades.
        uint256 blockNumberIncrement = Math.sub(blockNumber, longTermOrders.lastVirtualOrderBlock).fromUint();
        uint256 tokenASellAmount = orderPoolA.currentSalesRate.mulDown(blockNumberIncrement);
        uint256 tokenBSellAmount = orderPoolB.currentSalesRate.mulDown(blockNumberIncrement);

        // Get updated LTO and AMM balances.
        (uint256 tokenAOut, uint256 tokenBOut, uint256 ammEndTokenA, uint256 ammEndTokenB) = _computeVirtualBalances(
            tokenAStart,
            tokenBStart,
            tokenASellAmount,
            tokenBSellAmount
        );

        // Update balances reserves for both tokens.
        _addToLongTermOrdersBalance(0, tokenAOut);
        _removeFromLongTermOrdersBalance(0, tokenASellAmount);

        _addToLongTermOrdersBalance(1, tokenBOut);
        _removeFromLongTermOrdersBalance(1, tokenBSellAmount);

        // Distribute proceeds to order pools.
        orderPoolA.distributePayment(tokenBOut);
        orderPoolB.distributePayment(tokenAOut);

        // Handle orders expiring at the end of interval.
        if (isExpiryBlock) {
            orderPoolA.updateStateFromBlockExpiry(blockNumber);
            orderPoolB.updateStateFromBlockExpiry(blockNumber);
        }

        //update last virtual trade block
        longTermOrders.lastVirtualOrderBlock = uint64(blockNumber);

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
        // If no tokens are sold to the pool, we don't need to execute any orders
        if (tokenAIn == 0 && tokenBIn == 0) {
            tokenAOut = 0;
            tokenBOut = 0;
            ammEndTokenA = tokenAStart;
            ammEndTokenB = tokenBStart;
        } else if (tokenAIn == 0) {
            // Only one pool is selling, we just perform a normal swap
            tokenBOut = 0;
            ammEndTokenB = tokenBStart.add(tokenBIn);
            tokenAOut = tokenAStart.mulDown(tokenBIn).divDown(ammEndTokenB);
            ammEndTokenA = tokenAStart.sub(tokenAOut);
        } else if (tokenBIn == 0) {
            // Only one pool is selling, we just perform a normal swap
            tokenAOut = 0;
            ammEndTokenA = tokenAStart.add(tokenAIn);
            tokenBOut = tokenBStart.mulDown(tokenAIn).divDown(ammEndTokenA);
            ammEndTokenB = tokenBStart.sub(tokenBOut);
        } else {
            // When both pools sell, we use the TWAMM formula
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
        } else {
            longTermOrders.balanceB = longTermOrders.balanceB.sub(balance);
        }
    }

    function getTokenBalanceFromLongTermOrder(uint256 tokenIndex) external view override returns (uint256 balance) {
        return tokenIndex == 0 ? longTermOrders.balanceA : longTermOrders.balanceB;
    }

    function _getOrderExpiry(uint256 numberOfBlockIntervals) internal view returns (uint256) {
        uint256 orderBlockInterval = longTermOrders.orderBlockInterval;
        uint256 mod = Math.mod(block.number, orderBlockInterval);
        if (mod > 0) {
            numberOfBlockIntervals = Math.add(numberOfBlockIntervals, 1);
        }

        return Math.add(Math.mul(orderBlockInterval, numberOfBlockIntervals), Math.sub(block.number, mod));
    }

    function setMaxPerBlockSaleRatePercent(uint256 newMaxPerBlockSaleRatePercent) external override onlyOwner {
        longTermOrders.maxPerBlockSaleRatePercent = uint64(newMaxPerBlockSaleRatePercent);
    }

    function setMinLtoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRatio) external override onlyOwner {
        longTermOrders.minltoOrderAmountToAmmBalanceRatio = uint64(amountToAmmBalanceRatio);
    }

    function setOrderLimits(uint256 maxUniqueOrderExpiries, uint256 maxNumberOfBlockIntervals, uint256 maxVirtualOrderExecutionLoops)
        external
        override
        onlyOwner
    {
        _maxUniqueOrderExpiries = maxUniqueOrderExpiries;
        _maxNumberOfBlockIntervals = maxNumberOfBlockIntervals;
        _maxVirtualOrderExecutionLoops = maxVirtualOrderExecutionLoops;
    }

    function getLongTermOrderAndBoughtAmount(uint256 orderId)
        external
        view
        override
        returns (Order memory order, uint256 boughtAmount)
    {
        order = longTermOrders.orderMap[orderId];
        OrderPoolLib.OrderPool storage orderPool = longTermOrders.orderPoolMap[order.sellTokenIndex];

        boughtAmount = orderPool.rewardFactor.sub(orderPool.rewardFactorAtSubmission[order.id]).mulDown(order.saleRate);
    }
}
