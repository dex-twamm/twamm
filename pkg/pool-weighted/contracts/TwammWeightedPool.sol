// SPDX-License-Identifier: GPL-3.0-or-later
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "./WeightedPool.sol";

import "hardhat/console.sol";
// import "./twamm/LongTermOrders.sol";
import "./WeightedPoolUserData.sol";

import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";

// import "prb-math/contracts/PRBMathUD60x18.sol";

//@notice An Order Pool is an abstraction for a pool of long term orders that sells a token at a constant rate to the embedded AMM.
//the order pool handles the logic for distributing the proceeds from these sales to the owners of the long term orders through a modified
//version of the staking algorithm from  https://uploads-ssl.webflow.com/5ad71ffeb79acc67c8bcdaba/5ad8d1193a40977462982470_scalable-reward-distribution-paper.pdf
library OrderPoolLib {
    // using PRBMathUD60x18 for uint256;
    using FixedPoint for uint256;

    //@notice you can think of this as a staking pool where all long term orders are staked.
    // The pool is paid when virtual long term orders are executed, and each order is paid proportionally
    // by the order's sale rate per block
    struct OrderPool {
        //@notice current rate that tokens are being sold (per block)
        uint256 currentSalesRate;
        //@notice sum of (salesProceeds_k / salesRate_k) over every period k. Stored as a fixed precision floating point number
        uint256 rewardFactor;
        //@notice this maps block numbers to the cumulative sales rate of orders that expire on that block
        mapping(uint256 => uint256) salesRateEndingPerBlock;
        //@notice map order ids to the block in which they expire
        mapping(uint256 => uint256) orderExpiry;
        //@notice map order ids to their sales rate
        mapping(uint256 => uint256) salesRate;
        //@notice reward factor per order at time of submission
        mapping(uint256 => uint256) rewardFactorAtSubmission;
        //@notice reward factor at a specific block
        mapping(uint256 => uint256) rewardFactorAtBlock;
    }

    //@notice distribute payment amount to pool (in the case of TWAMM, proceeds from trades against amm)
    function distributePayment(OrderPool storage self, uint256 amount) internal {
        if (self.currentSalesRate != 0) {
            //floating point arithmetic
            // TODO fix this
            // self.rewardFactor += amount.fromUint().div(self.currentSalesRate.fromUint());
            self.rewardFactor += amount;
        }
    }

    //@notice deposit an order into the order pool.
    function depositOrder(
        OrderPool storage self,
        uint256 orderId,
        uint256 amountPerBlock,
        uint256 orderExpiry
    ) internal {
        self.currentSalesRate += amountPerBlock;
        self.rewardFactorAtSubmission[orderId] = self.rewardFactor;
        self.orderExpiry[orderId] = orderExpiry;
        self.salesRate[orderId] = amountPerBlock;
        self.salesRateEndingPerBlock[orderExpiry] += amountPerBlock;
    }

    //@notice when orders expire after a given block, we need to update the state of the pool
    function updateStateFromBlockExpiry(OrderPool storage self, uint256 blockNumber) internal {
        uint256 ordersExpiring = self.salesRateEndingPerBlock[blockNumber];
        self.currentSalesRate -= ordersExpiring;
        self.rewardFactorAtBlock[blockNumber] = self.rewardFactor;
    }

    //@notice cancel order and remove from the order pool
    function cancelOrder(OrderPool storage self, uint256 orderId)
        internal
        returns (uint256 unsoldAmount, uint256 purchasedAmount)
    {
        uint256 expiry = self.orderExpiry[orderId];
        require(expiry > block.number, "order already finished");

        //calculate amount that wasn't sold, and needs to be returned
        uint256 salesRate = self.salesRate[orderId];
        uint256 blocksRemaining = expiry - block.number;
        unsoldAmount = blocksRemaining * salesRate;

        //calculate amount of other token that was purchased
        uint256 rewardFactorAtSubmission = self.rewardFactorAtSubmission[orderId];
        // TODO fix this
        // purchasedAmount = (self.rewardFactor - rewardFactorAtSubmission).mul(salesRate.fromUint()).toUint();
        purchasedAmount = (self.rewardFactor - rewardFactorAtSubmission).mulDown(salesRate);

        //update state
        self.currentSalesRate -= salesRate;
        self.salesRate[orderId] = 0;
        self.orderExpiry[orderId] = 0;
        self.salesRateEndingPerBlock[expiry] -= salesRate;
    }

    //@notice withdraw proceeds from pool for a given order. This can be done before or after the order has expired.
    //If the order has expired, we calculate the reward factor at time of expiry. If order has not yet expired, we
    //use current reward factor, and update the reward factor at time of staking (effectively creating a new order)
    function withdrawProceeds(OrderPool storage self, uint256 orderId) internal returns (uint256 totalReward) {
        uint256 stakedAmount = self.salesRate[orderId];
        require(stakedAmount > 0, "sales rate amount must be positive");
        uint256 orderExpiry = self.orderExpiry[orderId];
        uint256 rewardFactorAtSubmission = self.rewardFactorAtSubmission[orderId];

        //if order has expired, we need to calculate the reward factor at expiry
        if (block.number > orderExpiry) {
            uint256 rewardFactorAtExpiry = self.rewardFactorAtBlock[orderExpiry];
            // TODO fix this
            // totalReward = (rewardFactorAtExpiry - rewardFactorAtSubmission).mul(stakedAmount.fromUint()).toUint();
            totalReward = (rewardFactorAtExpiry - rewardFactorAtSubmission).mulDown(stakedAmount);
            //remove stake
            self.salesRate[orderId] = 0;
        }
        //if order has not yet expired, we just adjust the start
        else {
            // TODO fix this
            // totalReward = (self.rewardFactor - rewardFactorAtSubmission).mul(stakedAmount.fromUint()).toUint();
            totalReward = (self.rewardFactor - rewardFactorAtSubmission).mulDown(stakedAmount);
            self.rewardFactorAtSubmission[orderId] = self.rewardFactor;
        }
    }
}


//@notice This library handles the state and execution of long term orders.
library LongTermOrdersLib {
    // using PRBMathSD59x18 for int256;
    using FixedPoint for int256;
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
        uint256 orderExpiry = self.orderBlockInterval *
            (numberOfBlockIntervals + 1) +
            block.number -
            (block.number % self.orderBlockInterval);
        uint256 sellingRate = amount / (orderExpiry - block.number);

        //add order to correct pool
        self.orderPoolMap[from].depositOrder(self.orderId, sellingRate, orderExpiry);

        //add to order map
        self.orderMap[self.orderId] = Order(self.orderId, orderExpiry, sellingRate, owner, from, to);

        // transfer sale amount to contract
        _addToLongTermOrdersBalance(self, from, amount);

        uint256 amountAIn = from == 0 ? amount : 0;
        uint256 amountBIn = from == 1 ? amount : 0;

        return (self.orderId++, amountAIn, amountBIn);
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
        
        return _addLongTermSwap(
                self,
                owner,
                sellTokenIndex,
                buyTokenIndex,
                amountIn,
                numberOfBlockIntervals,
                balances
            );
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
        uint256 blockNumberIncrement = blockNumber - self.lastVirtualOrderBlock;
        uint256 tokenASellAmount = self.orderPoolMap[0].currentSalesRate * blockNumberIncrement;
        uint256 tokenBSellAmount = self.orderPoolMap[1].currentSalesRate * blockNumberIncrement;

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
        _addToLongTermOrdersBalance(self, 0, tokenAOut - tokenASellAmount);
        _addToLongTermOrdersBalance(self, 1, tokenBOut - tokenBSellAmount);

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
        uint256 nextExpiryBlock = self.lastVirtualOrderBlock -
            (self.lastVirtualOrderBlock % self.orderBlockInterval) +
            self.orderBlockInterval;
        //iterate through blocks eligible for order expiries, moving state forward
        while (nextExpiryBlock < block.number) {
            _executeVirtualTradesAndOrderExpiries(self, balances, nextExpiryBlock);
            nextExpiryBlock += self.orderBlockInterval;
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
            tokenAOut = (tokenAStart * tokenBIn) / (tokenBStart + tokenBIn);
            tokenBOut = 0;

            // ammEndTokenA = (tokenAStart * tokenBStart) / (tokenBStart + tokenBIn);
            // tokenAOut = tokenAStart - ammEndTokenA
        } else if (tokenBIn == 0) {
            tokenAOut = 0;
            //contant product formula
            tokenBOut = (tokenBStart * tokenAIn) / (tokenAStart + tokenAIn);
        }
        //when both pools sell, we use the TWAMM formula
        else {
            //signed, fixed point arithmetic
            // int256 aIn = int256(tokenAIn).fromInt();
            // int256 bIn = int256(tokenBIn).fromInt();
            // int256 aStart = int256(tokenAStart).fromInt();
            // int256 bStart = int256(tokenBStart).fromInt();
            // TODO fix this
            int256 aIn = int256(tokenAIn);
            int256 bIn = int256(tokenBIn);
            int256 aStart = int256(tokenAStart);
            int256 bStart = int256(tokenBStart);

            // TODO fix this
            // int256 k = aStart.mul(bStart);
            int256 k = aStart * bStart;

            int256 c = _computeC(aStart, bStart, aIn, bIn);
            int256 endA = _computeAmmEndTokenA(aIn, bIn, c, k, aStart, bStart);
            // TODO fix this
            // int256 endB = aStart.div(endA).mul(bStart);
            int256 endB = (aStart / endA) * bStart;

            int256 outA = aStart + aIn - endA;
            int256 outB = bStart + bIn - endB;

            // TODO fix this
            // return (uint256(outA.toInt()), uint256(outB.toInt()));
            return (uint256(outA), uint256(outB));
        }
    }

    //helper function for TWAMM formula computation, helps avoid stack depth errors
    function _computeC(
        int256 tokenAStart,
        int256 tokenBStart,
        int256 tokenAIn,
        int256 tokenBIn
    ) private pure returns (int256 c) {
        int256 c1 = tokenAStart * tokenBIn;
        int256 c2 = tokenBStart * tokenAIn;
        int256 cNumerator = c1 - c2;
        int256 cDenominator = c1 + c2;
        c = cNumerator / cDenominator;
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
            self.balanceA += balance;
        } else if (tokenIndex == 1) {
            self.balanceB += balance;
        }
    }

    function _removeFromLongTermOrdersBalance(
        LongTermOrders storage self,
        uint256 tokenIndex,
        uint256 balance
    ) internal {
        if (tokenIndex == 0) {
            self.balanceA -= balance;
        } else if (tokenIndex == 1) {
            self.balanceB -= balance;
        }
    }

    function getTokenBalanceFromLongTermOrder(LongTermOrders storage self, uint8 tokenIndex)
        internal
        returns (uint256 balance)
    {
        return tokenIndex == 0 ? self.balanceA : self.balanceB;
    }
}


/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract TwammWeightedPool is WeightedPool {
    using LongTermOrdersLib for LongTermOrdersLib.LongTermOrders;
    using WeightedPoolUserData for bytes;

    LongTermOrdersLib.LongTermOrders internal _longTermOrders;

    constructor(
        IVault vault,
        string memory name,
        string memory symbol,
        IERC20[] memory tokens,
        uint256[] memory normalizedWeights,
        address[] memory assetManagers,
        uint256 swapFeePercentage,
        uint256 pauseWindowDuration,
        uint256 bufferPeriodDuration,
        address owner,
        uint256 orderBlockInterval
    )
        WeightedPool(
            vault,
            name,
            symbol,
            tokens,
            normalizedWeights,
            assetManagers,
            swapFeePercentage,
            pauseWindowDuration,
            bufferPeriodDuration,
            owner
        )
    {
        // Initialize with current block and specified order block interval.
        console.log("Initialize long term orders");
        _longTermOrders.initialize(block.number, orderBlockInterval);
    }

    function _onJoinPool(
        bytes32 poolId,
        address sender,
        address recipient,
        uint256[] memory balances,
        uint256 lastChangeBlock,
        uint256 protocolSwapFeePercentage,
        uint256[] memory scalingFactors,
        bytes memory userData
    )
        internal
        virtual
        override
        whenNotPaused
        returns (
            uint256,
            uint256[] memory,
            uint256[] memory
        )
    {
        console.log("In _onJoinPool TwammPool");
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        WeightedPoolUserData.JoinKind kind = userData.joinKind();
        // Check if it is a long term order, if it is then register it
        if (kind == WeightedPoolUserData.JoinKind.PLACE_LONG_TERM_ORDER) {
            (uint256 orderId, uint256 amountAIn, uint256 amountBIn) = _registerLongTermOrder(
                sender,
                recipient,
                scalingFactors,
                updatedBalances,
                userData
            );
            // Return 0 bpt when long term order is placed
            // TODO add protocol fees
            return (uint256(0), _getSizeTwoArray(amountAIn, amountBIn), _getSizeTwoArray(0, 0));
        } else {
            return super._onJoinPool(
                    poolId,
                    sender,
                    recipient,
                    updatedBalances,
                    lastChangeBlock,
                    protocolSwapFeePercentage,
                    scalingFactors,
                    userData
                );
        }
    }

    function _onExitPool(
        bytes32 poolId,
        address sender,
        address recipient,
        uint256[] memory balances,
        uint256 lastChangeBlock,
        uint256 protocolSwapFeePercentage,
        uint256[] memory scalingFactors,
        bytes memory userData
    )
        internal
        virtual
        override
        returns (
            uint256,
            uint256[] memory,
            uint256[] memory
        )
    {
        // TODO(nuhbye): Since we are using this updatedBalances later in this function as well,
        // shouldn't we use updated values after all virtual orders are executed?
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        WeightedPoolUserData.ExitKind kind = userData.exitKind();
        if (kind == WeightedPoolUserData.ExitKind.CANCEL_LONG_TERM_ORDER) {
            uint256 orderId = WeightedPoolUserData.cancelLongTermOrder(userData);
            (uint256 purchasedAmount, uint256 unsoldAmount) = _longTermOrders.cancelLongTermSwap(
                sender,
                orderId,
                updatedBalances
            );

            // TODO handle dueProtocolFeeAmounts here
            if (_longTermOrders.orderMap[orderId].buyTokenIndex == 0) {
                return (
                    uint256(0),
                    _getSizeTwoArray(purchasedAmount, unsoldAmount),
                    _getSizeTwoArray(uint256(0), uint256(0))
                );
            } else {
                return (
                    uint256(0),
                    _getSizeTwoArray(unsoldAmount, purchasedAmount),
                    _getSizeTwoArray(uint256(0), uint256(0))
                );
            }
        }
        if (kind == WeightedPoolUserData.ExitKind.WITHDRAW_LONG_TERM_ORDER) {
            uint256 orderId = WeightedPoolUserData.withdrawLongTermOrder(userData);
            uint256 proceeds = _longTermOrders.withdrawProceedsFromLongTermSwap(sender, orderId, updatedBalances);

            // TODO handle dueProtocolFeeAmounts here
            if (_longTermOrders.orderMap[orderId].buyTokenIndex == 0) {
                return (uint256(0), _getSizeTwoArray(uint256(0), proceeds), _getSizeTwoArray(uint256(0), uint256(0)));
            } else {
                return (uint256(0), _getSizeTwoArray(proceeds, uint256(0)), _getSizeTwoArray(uint256(0), uint256(0)));
            }
        } else {
            return super._onExitPool(
                    poolId,
                    sender,
                    recipient,
                    updatedBalances,
                    lastChangeBlock,
                    protocolSwapFeePercentage,
                    scalingFactors,
                    userData
                );
        }
    }

    function onSwap(
        SwapRequest memory request,
        uint256 balanceTokenIn,
        uint256 balanceTokenOut
    ) public virtual override onlyVault(request.poolId) returns (uint256) {
        uint256[] memory balances = new uint256[](2);

        if (_token0 == request.tokenIn) {
            balances = _getSizeTwoArray(balanceTokenIn, balanceTokenOut);
        } else {
            balances = _getSizeTwoArray(balanceTokenOut, balanceTokenIn);
        }

        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        if (_token0 == request.tokenIn) {
            return super.onSwap(request, updatedBalances[0], updatedBalances[1]);
        } else {
            return super.onSwap(request, updatedBalances[1], updatedBalances[0]);
        }
    }

    /**
     * Registers the long term order with the Pool.
     */
    function _registerLongTermOrder(
        address sender,
        address recipient,
        uint256[] memory scalingFactors,
        uint256[] memory updatedBalances,
        bytes memory userData
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return
            _longTermOrders.performLongTermSwap(
                recipient,
                userData,
                updatedBalances
            );
    }

    // function _doJoin(
    //     uint256[] memory balances,
    //     uint256[] memory normalizedWeights,
    //     uint256[] memory scalingFactors,
    //     bytes memory userData
    // ) internal returns (uint256, uint256[] memory) {
    //     WeightedPoolUserData.JoinKind kind = userData.joinKind();

    //     if (kind == WeightedPoolUserData.JoinKind.EXACT_TOKENS_IN_FOR_BPT_OUT) {
    //         return _joinExactTokensInForBPTOut(balances, normalizedWeights, scalingFactors, userData);
    //     } else if (kind == WeightedPoolUserData.JoinKind.TOKEN_IN_FOR_EXACT_BPT_OUT) {
    //         return _joinTokenInForExactBPTOut(balances, normalizedWeights, userData);
    //     } else if (kind == WeightedPoolUserData.JoinKind.ALL_TOKENS_IN_FOR_EXACT_BPT_OUT) {
    //         return _joinAllTokensInForExactBPTOut(balances, userData);
    //     } else {
    //         _revert(Errors.UNHANDLED_JOIN_KIND);
    //     }
    // }

    function _getUpdatedPoolBalances(uint256[] memory balances) internal returns (uint256[] memory) {
        uint256[] memory updatedBalances = new uint256[](balances.length);

        for (uint8 i = 0; i < balances.length; i++) {
            updatedBalances[i] = balances[i] - _longTermOrders.getTokenBalanceFromLongTermOrder(i);
        }

        return updatedBalances;
    }

    function _getSizeTwoArray(uint256 a, uint256 b) pure internal returns (uint256[] memory array) {
        array = new uint256[](2);
        array[0] = a;
        array[1] = b;
        return array;
    }
}
