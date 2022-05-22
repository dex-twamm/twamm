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
import "./twamm/LongTermOrders.sol";
import "./WeightedPoolUserData.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";

/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract TwammWeightedPool is WeightedPool {
    using LongTermOrdersLib for LongTermOrdersLib.LongTermOrders;
    using WeightedPoolUserData for bytes;
    using FixedPoint for uint256;

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
            return
                super._onJoinPool(
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
            if (_longTermOrders.orderMap[orderId].sellTokenIndex == 0) {
                return (uint256(0), _getSizeTwoArray(uint256(0), proceeds), _getSizeTwoArray(uint256(0), uint256(0)));
            } else {
                return (uint256(0), _getSizeTwoArray(proceeds, uint256(0)), _getSizeTwoArray(uint256(0), uint256(0)));
            }
        } else {
            return
                super._onExitPool(
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
        return _longTermOrders.performLongTermSwap(recipient, userData, updatedBalances);
    }

    function _getUpdatedPoolBalances(uint256[] memory balances) internal view returns (uint256[] memory) {
        uint256[] memory updatedBalances = new uint256[](balances.length);

        for (uint8 i = 0; i < balances.length; i++) {
            updatedBalances[i] = balances[i] - _longTermOrders.getTokenBalanceFromLongTermOrder(i);
        }

        return updatedBalances;
    }

    function _getSizeTwoArray(uint256 a, uint256 b) internal pure returns (uint256[] memory array) {
        array = new uint256[](2);
        array[0] = a;
        array[1] = b;
        return array;
    }

    function _calculateInvariant(uint256[] memory normalizedWeights, uint256[] memory balances)
        internal
        view
        override
        returns (uint256)
    {
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);
        // return WeightedMath._calculateInvariant(normalizedWeights, updatedBalances);
        // TODO Considering constant product amm
        return updatedBalances[0].mulUp(updatedBalances[1]);
    }
}
