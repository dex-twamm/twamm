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

import "./twamm/LongTermOrders.sol";
import "./WeightedPoolUserData.sol";

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
        // Initializing for two tokens
        _longTermOrders.initialize(tokens[0], tokens[1], block.number, orderBlockInterval);
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
            (uint256 bptAmountOut, uint256[] memory amountsIn, uint256[] memory dueProtocolFeeAmounts) = super
                ._onJoinPool(
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
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(updatedBalances);

        WeightedPoolUserData.ExitKind kind = userData.exitKind();
        if (kind == WeightedPoolUserData.ExitKind.CANCEL_LONG_TERM_ORDER) {
            uint256 orderId = _parseExitLongTermOrderValues(userData);
            (uint256 purchasedAmount, uint256 unsoldAmount) = _longTermOrders.cancelLongTermSwap(
                sender,
                orderId,
                updatedBalances
            );

            // TODO handle dueProtocolFeeAmounts here
            if (_longTermOrders.orderMap[orderId].sellTokenId == _longTermOrders.tokenA) {
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
            uint256 orderId = _parseExitLongTermOrderValues(userData);
            uint256 proceeds = _longTermOrders.withdrawProceedsFromLongTermSwap(sender, orderId, updatedBalances);

            // TODO handle dueProtocolFeeAmounts here
            if (_longTermOrders.orderMap[orderId].sellTokenId == _longTermOrders.tokenA) {
                return (uint256(0), _getSizeTwoArray(uint256(0), proceeds), _getSizeTwoArray(uint256(0), uint256(0)));
            } else {
                return (uint256(0), _getSizeTwoArray(proceeds, uint256(0)), _getSizeTwoArray(uint256(0), uint256(0)));
            }
        } else {
            (uint256 bptAmountIn, uint256[] memory amountsOut, uint256[] memory dueProtocolFeeAmounts) = super
                ._onExitPool(
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
        uint256[] memory balances = new uint256[](2);

        if (_longTermOrders.tokenA == request.tokenIn) {
            balances = _getSizeTwoArray(balanceTokenIn, balanceTokenOut);
        } else {
            balances = _getSizeTwoArray(balanceTokenOut, balanceTokenIn);
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
    )
        internal
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
        (, sellTokenId, buyTokenId, amountIn, numberOfBlockIntervals) = abi.decode(
            userData,
            (bool, IERC20, IERC20, uint256, uint256)
        );
    }

    function _parseExitLongTermOrderValues(bytes memory userData) internal returns (uint256) {
        return abi.decode(userData, (uint256));
    }

    function _getUpdatedPoolBalances(uint256[] memory balances) internal returns (uint256[] memory) {
        uint256[] memory updatedBalances = new uint256[](balances.length);

        for (uint8 i = 0; i < balances.length; i++) {
            updatedBalances[i] = balances[i] - _longTermOrders.getTokenBalanceFromLongTermOrder(i);
        }

        return updatedBalances;
    }

    function _isLongTermOrder(bytes memory userData) internal returns (bool isLongTermOrder) {
        (isLongTermOrder, , , , ) = abi.decode(userData, (bool, address, address, uint256, uint256));
    }

    function _isExitLongTermOrder(bytes memory userData) internal returns (uint8) {
        return abi.decode(userData, (uint8));
    }

    function _getSizeTwoArray(uint256 a, uint256 b) internal returns (uint256[] memory array) {
        array = new uint256[](2);
        array[0] = a;
        array[1] = b;
        return array;
    }
}
