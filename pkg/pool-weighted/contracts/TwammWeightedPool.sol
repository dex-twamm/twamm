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

    LongTermOrdersLib.LongTermOrders internal _longTermOrders;

    constructor(
        IVault vault,
        string memory name,
        string memory symbol,
        IERC20[] memory tokens,
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
        // Initializing for two tokens
        _longTermOrders.initialize(token[0], token[1], block.number, _orderBlockInterval);
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

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        // Check if it is a long term order, if it is then register it
        if (_isLongTermOrder(userData)) {
            // TODO fix registerLongTermOrder to return token balances
            (uint256 amountAIn, uint256 amountBIn) = _registerLongTermOrder(
                sender,
                recipient,
                scalingFactors,
                updatedBalances,
                userData
            );
            // Return 0 bpt when long term order is placed
            // TODO handle amountsIn being array here
            // TODO add protocol fees
            return (0, [amountAIn, amountBIn], [0, 0]);
        } else {
            (uint256 bptAmountOut, uint256[] amountsIn, uint256[] dueProtocolFeeAmounts) = super._onJoinPool(
                poolId,
                sender,
                recipient,
                updatedBalances,
                lastChangeBlock,
                protocolSwapFeePercentage,
                scalingFactors,
                userData
            );

            return (bptAmountOut, amountsIn, dueProtocolFeeAmounts);
        }
    }

    function _onExitPool(
        bytes32,
        address,
        address,
        uint256[] memory balances,
        uint256,
        uint256 protocolSwapFeePercentage,
        uint256[] memory scalingFactors,
        bytes memory userData
    )
        internal
        virtual
        override
        returns (
            uint256 bptAmountIn,
            uint256[] memory amountsOut,
            uint256[] memory dueProtocolFeeAmounts
        )
    {
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        uint8 isExitLongTermOrder = _isExitLongTermOrder(userData);
        if (isExitLongTermOrder == 1) {
            uint256 orderId = _parseExitLongTermOrderValues(userData);
            (uint256 purchasedAmount, uint256 unsoldAmount) = _longTermOrders.cancelLongTermSwap(
                sender,
                orderId,
                updatedBalances
            );

            // TODO handle dueProtocolFeeAmounts here
            if (_longTermOrders.orderMap[orderId].sellTokenId == _longTermOrders.tokenA)
                return (0, [purchasedAmount, unsoldAmount], 0);
            else return (0, [unsoldAmount, purchasedAmount], 0);
        } else if (isExitLongTermOrder == 2) {
            uint256 orderId = _parseExitLongTermOrderValues(userData);
            uint256 proceeds = _longTermOrders.withdrawProceedsFromLongTermSwap(sender, orderId, updatedBalances);

            // TODO handle dueProtocolFeeAmounts here
            if (_longTermOrders.orderMap[orderId].sellTokenId == _longTermOrders.tokenA)
                return (0, [0, proceeds], dueProtocolFeeAmounts);
            else return (0, [proceeds, 0], dueProtocolFeeAmounts);
        } else {
            (uint256 bptAmountIn, uint256[] amountsOut, uint256[] dueProtocolFeeAmounts) = super._onExitPool(
                poolId,
                sender,
                recipient,
                updatedBalances,
                lastChangeBlock,
                protocolSwapFeePercentage,
                scalingFactors,
                userData
            );

            return (bptAmountIn, amountsOut, dueProtocolFeeAmounts);
        }
    }

    function onSwap(
        SwapRequest memory request,
        uint256 balanceTokenIn,
        uint256 balanceTokenOut
    ) public virtual override onlyVault(request.poolId) returns (uint256) {
        uint256[] memory balances = new uint256[2];

        if (_longTermOrders.tokenA == request.tokenIn) {
            balances = [balanceTokenIn, balanceTokenOut];
        } else {
            balances = [balanceTokenOut, balanceTokenIn];
        }

        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        if (_longTermOrders.tokenA == request.tokenIn) {
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
    ) internal returns (uint256 orderId) {
        (
            address sellTokenId,
            address buyTokenId,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        ) = _parseLongTermOrderValues(userData);

        return
            _longTermOrders.performLongTermSwap(
                recipient,
                sellTokenId,
                buyTokenId,
                amountIn,
                numberOfBlockIntervals,
                updatedBalances
            );
    }

    function _parseLongTermOrderValues(bytes memory userData)
        internal
        returns (
            IERC20 sellTokenId,
            IERC20 buyTokenId,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        )
    {
        (_, sellTokenId, buyTokenId, amountIn, numberOfBlockIntervals) = abi.decode(
            userData,
            (bool, address, address, uint256, uint256)
        );
    }

    function _parseExitLongTermOrderValues(bytes memory userData) internal returns (uint256) {
        return abi.decode(userData, (uint256));
    }

    function _getUpdatedPoolBalances(uint256[] memory balances) internal returns (uint256[] memory) {
        uint256[] memory updatedBalances = new uint256[](balances.length);

        for (uint256 i = 0; i < balances.length; i++) {
            updatedBalances[i] = balances[i] - _longTermOrders.getTokenBalanceFromLongTermOrder(i);
        }

        return updatedBalances;
    }

    function _isLongTermOrder(bytes memory userData) internal returns (bool) {
        (isLongTermOrder, _, _, _, _) = abi.decode(userData, (bool, address, address, uint256, uint256));
        return isLongTermOrder;
    }

    function _isExitLongTermOrder(bytes memory userData) internal returns (uint8) {
        return abi.decode(userData, (uint8));
    }
}
