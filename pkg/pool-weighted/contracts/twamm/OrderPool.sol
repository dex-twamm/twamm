//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.0;

import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";

import "hardhat/console.sol";

// @notice An Order Pool is an abstraction for a pool of long term orders that sells a token at a constant rate to the
// embedded AMM.

library OrderPoolLib {
    using FixedPoint for uint256;

    // @notice you can think of this as a staking pool where all long term orders are staked.
    // The pool is paid when virtual long term orders are executed, and each order is paid proportionally
    // by the order's sale rate per block
    struct OrderPool {
        //@notice current rate that tokens are being sold (per block)
        uint256 currentSalesRate;
        //@notice sum of (salesProceeds_k / salesRate_k) over every period k.
        //Stored as a fixed precision floating point number
        uint256 rewardFactor;
        //@notice this maps block numbers to the cumulative sales rate of orders that expire on that block
        mapping(uint256 => uint256) salesRateEndingPerBlock;
        //@notice reward factor per order at time of submission
        mapping(uint256 => uint256) rewardFactorAtSubmission;
        //@notice reward factor at a specific block
        mapping(uint256 => uint256) rewardFactorAtBlock;
        // To keep track of number of orders expiring at specific block for cleanup later
        mapping(uint256 => uint256) ordersExpiringAtBlock;
    }

    //@notice distribute payment amount to pool (in the case of TWAMM, proceeds from trades against amm)
    function distributePayment(OrderPool storage self, uint256 amount) internal {
        if (self.currentSalesRate != 0) {
            self.rewardFactor = self.rewardFactor.add(amount.divDown(self.currentSalesRate));
        }
    }

    //@notice deposit an order into the order pool.
    function depositOrder(
        OrderPool storage self,
        uint256 orderId,
        uint256 amountPerBlock,
        uint256 orderExpiryBlock
    ) internal {
        self.currentSalesRate = self.currentSalesRate.add(amountPerBlock);
        self.rewardFactorAtSubmission[orderId] = self.rewardFactor;
        self.salesRateEndingPerBlock[orderExpiryBlock] = self.salesRateEndingPerBlock[orderExpiryBlock].add(
            amountPerBlock
        );
        self.ordersExpiringAtBlock[orderExpiryBlock] = Math.add(self.ordersExpiringAtBlock[orderExpiryBlock], 1);
    }

    // This function gets called when the orders are either cancelled or withdrawn
    function cleanUpOrder(
        OrderPool storage self,
        uint256 orderId,
        uint256 orderExpiryBlock
    ) internal {
        // Reward factor of the order can be cleaned up when the order is completed
        delete self.rewardFactorAtSubmission[orderId];

        // rewardFactorAtBlock and ordersExpiringAtBlock can be cleaned up since rewardFactorAtBlock is useful for
        // withdraw and cancel only
        if (self.ordersExpiringAtBlock[orderExpiryBlock] == 0) {
            delete self.rewardFactorAtBlock[orderExpiryBlock];
            delete self.ordersExpiringAtBlock[orderExpiryBlock];
        }
    }

    //@notice when orders expire after a given block, we need to update the state of the pool
    function updateStateFromBlockExpiry(OrderPool storage self, uint256 blockNumber) internal {
        self.currentSalesRate = self.currentSalesRate.sub(self.salesRateEndingPerBlock[blockNumber]);
        self.rewardFactorAtBlock[blockNumber] = self.rewardFactor;

        // Free up salesRateEndingPerBlock as it won't be needed once currentSalesRate is updated on reaching
        // the expiry block
        delete self.salesRateEndingPerBlock[blockNumber];
    }

    //@notice cancel order and remove from the order pool
    function cancelOrder(
        OrderPool storage self,
        uint256 orderId,
        uint256 lastVirtualOrderBlock,
        uint256 orderSaleRate,
        uint256 orderExpiryBlock
    ) internal returns (uint256 unsoldAmount, uint256 purchasedAmount) {
        _require(orderExpiryBlock > lastVirtualOrderBlock, Errors.ORDER_ALREADY_COMPLETED);

        // Calculate amount that wasn't sold, and needs to be returned
        uint256 blocksRemaining = Math.sub(orderExpiryBlock, lastVirtualOrderBlock);
        unsoldAmount = blocksRemaining.fromUint().mulDown(orderSaleRate);

        // Calculate amount of purchased token.
        uint256 rewardFactorAtSubmission = self.rewardFactorAtSubmission[orderId];
        purchasedAmount = (self.rewardFactor - rewardFactorAtSubmission).mulDown(orderSaleRate);

        // Update state
        self.currentSalesRate = self.currentSalesRate.sub(orderSaleRate);
        self.salesRateEndingPerBlock[orderExpiryBlock] -= orderSaleRate;
        self.ordersExpiringAtBlock[orderExpiryBlock] = Math.sub(self.ordersExpiringAtBlock[orderExpiryBlock], 1);
    }

    //@notice withdraw proceeds from pool for a given order. This can be done before or after the order has expired.
    //If the order has expired, we calculate the reward factor at time of expiry. If order has not yet expired, we
    //use current reward factor, and update the reward factor at time of staking (effectively creating a new order)
    function withdrawProceeds(
        OrderPool storage self,
        uint256 orderId,
        uint256 lastVirtualOrderBlock,
        uint256 orderSaleRate,
        uint256 orderExpiryBlock
    ) internal returns (uint256 totalReward, bool isPartialWithdrawal) {
        _require(orderSaleRate != 0, Errors.NEGATIVE_SALES_RATE);

        uint256 rewardFactorAtSubmission = self.rewardFactorAtSubmission[orderId];

        // If order has expired, we need to calculate the reward factor at expiry
        if (lastVirtualOrderBlock >= orderExpiryBlock) {
            uint256 rewardFactorAtExpiry = self.rewardFactorAtBlock[orderExpiryBlock];
            totalReward = rewardFactorAtExpiry.sub(rewardFactorAtSubmission).mulDown(orderSaleRate);
            isPartialWithdrawal = false;
            self.ordersExpiringAtBlock[orderExpiryBlock] = Math.sub(self.ordersExpiringAtBlock[orderExpiryBlock], 1);
        } else {
            // If order has not yet expired (i.e. partial withdrawal), we just adjust the start.
            totalReward = self.rewardFactor.sub(rewardFactorAtSubmission).mulDown(orderSaleRate);
            self.rewardFactorAtSubmission[orderId] = self.rewardFactor;
            isPartialWithdrawal = true;
        }
    }
}
