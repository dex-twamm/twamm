//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;

import "hardhat/console.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";
// import "prb-math/contracts/PRBMathSD59x18.sol";
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/IERC20.sol";
import "./OrderPool.sol";

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
        IERC20 sellTokenId;
        IERC20 buyTokenId;
    }

    //@notice structure contains full state related to long term orders
    struct LongTermOrders {
        //@notice minimum block interval between order expiries
        uint256 orderBlockInterval;
        //@notice last virtual orders were executed immediately before this block
        uint256 lastVirtualOrderBlock;
        //@notice token pair being traded in embedded amm
        IERC20 tokenA;
        IERC20 tokenB;
        uint256 balanceA;
        uint256 balanceB;
        //@notice mapping from token address to pool that is selling that token
        //we maintain two order pools, one for each token that is tradable in the AMM
        mapping(IERC20 => OrderPoolLib.OrderPool) orderPoolMap;
        //@notice incrementing counter for order ids
        uint256 orderId;
        //@notice mapping from order ids to Orders
        mapping(uint256 => Order) orderMap;
    }

    //@notice initialize state
    function initialize(
        LongTermOrders storage self,
        IERC20 tokenA,
        IERC20 tokenB,
        uint256 lastVirtualOrderBlock,
        uint256 orderBlockInterval
    ) internal {
        self.tokenA = tokenA;
        self.tokenB = tokenB;
        self.lastVirtualOrderBlock = lastVirtualOrderBlock;
        self.orderBlockInterval = orderBlockInterval;
    }

    //@notice adds long term swap to order pool
    function _addLongTermSwap(
        LongTermOrders storage self,
        address owner,
        IERC20 from,
        IERC20 to,
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

        uint256 amountAIn = from == self.tokenA ? amount : 0;
        uint256 amountBIn = from == self.tokenB ? amount : 0;

        return (self.orderId++, amountAIn, amountBIn);
    }

     function performLongTermSwap(
        LongTermOrders storage self,
        address owner,
        bytes memory orderData,
        uint256[] memory balances
    )
        external
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        (
            IERC20 sellTokenId,
            IERC20 buyTokenId,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        ) = _parseLongTermOrderValues(orderData);
        
        return _addLongTermSwap(
                self,
                owner,
                sellTokenId,
                buyTokenId,
                amountIn,
                numberOfBlockIntervals,
                balances
            );
    }

    function _parseLongTermOrderValues(bytes memory orderData)
        internal
        returns (
            IERC20 sellTokenId,
            IERC20 buyTokenId,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        )
    {
        (, sellTokenId, buyTokenId, amountIn, numberOfBlockIntervals) = abi.decode(
            orderData,
            (bool, IERC20, IERC20, uint256, uint256)
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

        OrderPoolLib.OrderPool storage orderPool = self.orderPoolMap[order.sellTokenId];
        (unsoldAmount, purchasedAmount) = orderPool.cancelOrder(orderId);

        require(unsoldAmount > 0 || purchasedAmount > 0, "no proceeds to withdraw");

        //update LongTermOrders balances
        _removeFromLongTermOrdersBalance(self, order.buyTokenId, purchasedAmount);
        _removeFromLongTermOrdersBalance(self, order.sellTokenId, unsoldAmount);
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

        OrderPoolLib.OrderPool storage orderPool = self.orderPoolMap[order.sellTokenId];
        require(orderPool.orderExpiry[orderId] <= block.number, "Order not expired yet");

        proceeds = orderPool.withdrawProceeds(orderId);

        require(proceeds > 0, "no proceeds to withdraw");
        //update long term order balances
        _removeFromLongTermOrdersBalance(self, order.sellTokenId, proceeds);
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
        uint256 tokenASellAmount = self.orderPoolMap[self.tokenA].currentSalesRate * blockNumberIncrement;
        uint256 tokenBSellAmount = self.orderPoolMap[self.tokenB].currentSalesRate * blockNumberIncrement;

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
        _addToLongTermOrdersBalance(self, self.tokenA, tokenAOut - tokenASellAmount);
        _addToLongTermOrdersBalance(self, self.tokenB, tokenBOut - tokenBSellAmount);

        //distribute proceeds to pools
        OrderPoolLib.OrderPool storage orderPoolA = self.orderPoolMap[self.tokenA];
        OrderPoolLib.OrderPool storage orderPoolB = self.orderPoolMap[self.tokenB];

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
        IERC20 token,
        uint256 balance
    ) internal {
        if (token == self.tokenA) {
            self.balanceA += balance;
        } else if (token == self.tokenB) {
            self.balanceB += balance;
        }
    }

    function _removeFromLongTermOrdersBalance(
        LongTermOrders storage self,
        IERC20 token,
        uint256 balance
    ) internal {
        if (token == self.tokenA) {
            self.balanceA -= balance;
        } else if (token == self.tokenB) {
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
