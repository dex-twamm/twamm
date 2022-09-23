//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;

import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";

// import "prb-math/contracts/PRBMathUD60x18.sol";

//@notice An Order Pool is an abstraction for a pool of long term orders that sells a token at a constant rate to the
//embedded AMM. The order pool handles the logic for distributing the proceeds from these sales to the owners of the
//long term orders through a modified version of the staking algorithm from https://uploads-ssl.webflow.com/
//5ad71ffeb79acc67c8bcdaba/5ad8d1193a40977462982470_scalable-reward-distribution-paper.pdf

library OrderPoolLib {
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
        // TODO this mapping is unneccessary, we can just use one from the LongTermOrders
        mapping(uint256 => uint256) salesRate;
        //@notice reward factor per order at time of submission
        mapping(uint256 => uint256) rewardFactorAtSubmission;
        //@notice reward factor at a specific block
        // TODO fix this as this will grow a lot with time.
        mapping(uint256 => uint256) rewardFactorAtBlock;

        // uint128 currentlyActiveOrders;

        // uint128 cleanedUpUntilBlock;
    }

    //@notice distribute payment amount to pool (in the case of TWAMM, proceeds from trades against amm)
    function distributePayment(OrderPool storage self, uint256 amount) internal {
        if (self.currentSalesRate != 0) {
            //floating point arithmetic
            self.rewardFactor = self.rewardFactor.add(amount.divDown(self.currentSalesRate));
        }
    }

    //@notice deposit an order into the order pool.
    function depositOrder(
        OrderPool storage self,
        uint256 orderId,
        uint256 amountPerBlock,
        uint256 orderExpiry
    ) internal {
        self.currentSalesRate = self.currentSalesRate.add(amountPerBlock);
        self.rewardFactorAtSubmission[orderId] = self.rewardFactor;
        self.orderExpiry[orderId] = orderExpiry;
        self.salesRate[orderId] = amountPerBlock;
        self.salesRateEndingPerBlock[orderExpiry] = self.salesRateEndingPerBlock[orderExpiry].add(amountPerBlock);

        // if(self.cleanedUpUntilBlock == 0) {
        //     self.cleanedUpUntilBlock = uint128(block.number);
        // }
        // ++self.currentlyActiveOrders;
    }

    function cleanUpOrder(OrderPool storage self, uint256 orderId/*, bool noOtherActiveOrders*/) internal {
        delete self.orderExpiry[orderId];
        delete self.salesRate[orderId];
        delete self.rewardFactorAtSubmission[orderId];
        // --self.currentlyActiveOrders;
        // Todo clean up salesRateEndingPerBlock and rewardFactorAtBlock
        // TODO: set rewardFactor to zero when there are no active orders?

        // if(self.currentlyActiveOrders == 0) {
        //     self.rewardFactor = 0;

        //     // salesRateEndingPerBlock[]
        // }
    }

    //@notice when orders expire after a given block, we need to update the state of the pool
    function updateStateFromBlockExpiry(OrderPool storage self, uint256 blockNumber) internal {
        uint256 ordersExpiring = self.salesRateEndingPerBlock[blockNumber];
        self.currentSalesRate = self.currentSalesRate.sub(ordersExpiring);
        self.rewardFactorAtBlock[blockNumber] = self.rewardFactor;
    }

    //@notice cancel order and remove from the order pool
    function cancelOrder(
        OrderPool storage self,
        uint256 orderId,
        uint256 lastVirtualOrderBlock
    ) internal returns (uint256 unsoldAmount, uint256 purchasedAmount) {
        uint256 expiry = self.orderExpiry[orderId];
        require(expiry > lastVirtualOrderBlock, "order already finished");

        // Calculate amount that wasn't sold, and needs to be returned
        uint256 salesRate = self.salesRate[orderId];
        uint256 blocksRemaining = Math.sub(expiry, lastVirtualOrderBlock);
        unsoldAmount = blocksRemaining.fromUint().mulDown(salesRate);

        // Calculate amount of purchased token.
        uint256 rewardFactorAtSubmission = self.rewardFactorAtSubmission[orderId];
        purchasedAmount = (self.rewardFactor - rewardFactorAtSubmission).mulDown(salesRate);

        // Update state
        self.currentSalesRate = self.currentSalesRate.sub(salesRate);
        self.salesRate[orderId] = 0;
        self.orderExpiry[orderId] = 0;
        self.salesRateEndingPerBlock[expiry] -= salesRate;
    }

    //@notice withdraw proceeds from pool for a given order. This can be done before or after the order has expired.
    //If the order has expired, we calculate the reward factor at time of expiry. If order has not yet expired, we
    //use current reward factor, and update the reward factor at time of staking (effectively creating a new order)
    function withdrawProceeds(
        OrderPool storage self,
        uint256 orderId,
        uint256 lastVirtualOrderBlock
    ) internal returns (uint256 totalReward, bool isPartialWithdrawal) {
        uint256 stakedAmount = self.salesRate[orderId];
        require(stakedAmount > 0, "sales rate amount must be positive");

        uint256 orderExpiry = self.orderExpiry[orderId];
        uint256 rewardFactorAtSubmission = self.rewardFactorAtSubmission[orderId];

        // TODO: shouldn't this be >= orderExpiry?
        // If order has expired, we need to calculate the reward factor at expiry
        if (lastVirtualOrderBlock >= orderExpiry) {
            uint256 rewardFactorAtExpiry = self.rewardFactorAtBlock[orderExpiry];
            totalReward = rewardFactorAtExpiry.sub(rewardFactorAtSubmission).mulDown(stakedAmount);
            // Remove stake
            self.salesRate[orderId] = 0;
            isPartialWithdrawal = false;
        }
        // If order has not yet expired (i.e. partial withdrawal), we just adjust the start.
        else {
            totalReward = self.rewardFactor.sub(rewardFactorAtSubmission).mulDown(stakedAmount);
            self.rewardFactorAtSubmission[orderId] = self.rewardFactor;
            isPartialWithdrawal = true;
        }
    }
}
