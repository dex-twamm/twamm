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

import "./BaseWeightedPool.sol";
import "./twamm/LongTermOrders.sol";

/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract TwammWeightedPool is BaseWeightedPool {
    using LongTermOrdersLib for LongTermOrdersLib.LongTermOrders;

    LongTermOrdersLib.LongTermOrders internal longTermOrders;

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
        uint256 _orderBlockInterval
    )
        WeightedPool(
            vault,
            name,
            symbol,
            tokens,
            assetManagers,
            swapFeePercentage,
            pauseWindowDuration,
            bufferPeriodDuration,
            owner
        )
    {
        // TODO initialize it properly
        longTermOrders.initialize(tokens, block.number, _orderBlockInterval);
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
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        bptAmountOut, amountsIn, dueProtocolFeeAmounts = super._onJoinPool(
            poolId,
            sender,
            recipient,
            updatedBalances,
            lastChangeBlock,
            protocolSwapFeePercentage,
            scalingFactors,
            userData
        );

        // Check if it is a long term order, if it is then register it
        if (_isLongTermOrder(userData)) {
            _registerLongTermOrder(sender, recipient, updatedBalances, lastChangeBlock, scalingFactors, userData);
            // Return 0 bpt when long term order is placed
            bptAmountOut = 0;
        }

        return (bptAmountOut, amountsIn, dueProtocolFeeAmounts);
    }

    /**
     * Registers the long term order with the Pool.
     */
    function _registerLongTermOrder(
        address sender,
        address recipient,
        uint256[] memory balances,
        uint256 lastChangeBlock,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) private {
        sellTokenId, buyTokenId, amount, numberOfBlockIntervals = _parseLongTermOrderValues(userData);

        longTermOrders.performLongTermSwap(sellTokenId, buyTokenId, amount, numberOfBlockIntervals)
    }

    function _parseLongTermOrderValues(bytes memory userData) returns (
        id, expirationBlock, saleRate, owner, sellTokenId, buyTokenId
    ) {
        // TODO implement this
    }

    function _getUpdatedPoolBalances(uint256[] memory balances, ) returns (uint256[] memory) {
        uint256[] memory updatedBalances = new uint256[](balances.length);

        for (uint256 i = 0; i < balances.length; i++) {
            // TODO implement this
            updatedBalances[i] = balances[i] - longTermOrders.getTokenBalanceFromLongTermOrder(i);
        }

        return updatedBalances;
    }

    function _isLongTermOrder(bytes memory userData) returns (bool) {
        // TODO implement this
    }
}
