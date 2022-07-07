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

import "./twamm/ILongTermOrders.sol";
import "./WeightedPoolUserData.sol";
import "@balancer-labs/v2-solidity-utils/contracts/math/FixedPoint.sol";

import "hardhat/console.sol";

/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract TwammWeightedPool is BaseWeightedPool {
    using WeightedPoolUserData for bytes;
    using FixedPoint for uint256;

    uint256 private constant _MAX_TOKENS = 2;

    uint256 private constant _totalTokens = 2;

    IERC20 internal immutable _token0;
    IERC20 internal immutable _token1;

    uint256 internal immutable _scalingFactor0;
    uint256 internal immutable _scalingFactor1;

    ILongTermOrders public _longTermOrders;

    uint256 internal immutable _normalizedWeight0;
    uint256 internal immutable _normalizedWeight1;

    constructor(
        IVault vault,
        string memory name,
        string memory symbol,
        IERC20[] memory tokens,
        uint256[] memory normalizedWeights,
        uint256 swapFeePercentage,
        uint256 pauseWindowDuration,
        uint256 bufferPeriodDuration,
        address owner,
        address longTermOrdersContractAddress
    )
        BaseWeightedPool(
            vault,
            name,
            symbol,
            tokens,
            new address[](tokens.length), // Pass the zero address: Twamms can't have asset managers
            swapFeePercentage,
            pauseWindowDuration,
            bufferPeriodDuration,
            owner
        )
    {
        _require(tokens.length == 2, Errors.NOT_TWO_TOKENS);
        InputHelpers.ensureInputLengthMatch(tokens.length, normalizedWeights.length);

        // Immutable variables cannot be initialized inside an if statement, so we must do conditional assignments
        _token0 = tokens[0];
        _token1 = tokens[1];

        _normalizedWeight0 = normalizedWeights[0];
        _normalizedWeight1 = normalizedWeights[1];

        _scalingFactor0 = _computeScalingFactor(tokens[0]);
        _scalingFactor1 = _computeScalingFactor(tokens[1]);

        for (uint8 i = 0; i < 2; i++) {
            _require(normalizedWeights[i] >= WeightedMath._MIN_WEIGHT, Errors.MIN_WEIGHT);
        }

        _longTermOrders = ILongTermOrders(longTermOrdersContractAddress);
    }

    function _getMaxTokens() internal pure virtual override returns (uint256) {
        return _MAX_TOKENS;
    }

    function _getNormalizedWeight(IERC20 token) internal view virtual override returns (uint256) {
        // prettier-ignore
        if (token == _token0) { return _normalizedWeight0; }
        else if (token == _token1) { return _normalizedWeight1; }
        else {
            _revert(Errors.INVALID_TOKEN);
        }
    }

    function _getNormalizedWeights() internal view virtual override returns (uint256[] memory) {
        uint256 totalTokens = _getTotalTokens();
        uint256[] memory normalizedWeights = new uint256[](totalTokens);

        // prettier-ignore
        {
            normalizedWeights[0] = _normalizedWeight0;
            normalizedWeights[1] = _normalizedWeight1;
        }

        return normalizedWeights;
    }

    function _getNormalizedWeightsAndMaxWeightIndex()
        internal
        view
        override
        returns (uint256[] memory normalizedWeights, uint256 maxWeightTokenIndex)
    {
        normalizedWeights = _getNormalizedWeights();

        maxWeightTokenIndex = 0;
        uint256 maxNormalizedWeight = normalizedWeights[0];

        for (uint256 i = 1; i < normalizedWeights.length; i++) {
            if (normalizedWeights[i] > maxNormalizedWeight) {
                maxWeightTokenIndex = i;
                maxNormalizedWeight = normalizedWeights[i];
            }
        }
    }

    function _getTotalTokens() internal view virtual override returns (uint256) {
        return _MAX_TOKENS;
    }

    function _scalingFactor(IERC20 token) internal view virtual override returns (uint256) {
        // prettier-ignore
        if (token == _token0) { return _scalingFactor0; }
        else if (token == _token1) { return _scalingFactor1; }
        else {
            _revert(Errors.INVALID_TOKEN);
        }
    }

    function _scalingFactors() internal view virtual override returns (uint256[] memory) {
        uint256 totalTokens = _getTotalTokens();
        uint256[] memory scalingFactors = new uint256[](totalTokens);

        // prettier-ignore
        {
            scalingFactors[0] = _scalingFactor0;
            scalingFactors[1] = _scalingFactor1;
        }

        return scalingFactors;
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

        if(address(_longTermOrders) != address(0)) {
            (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
                updatedBalances
            );
        }
        
        WeightedPoolUserData.JoinKind kind = userData.joinKind();
        // Check if it is a long term order, if it is then register it
        if (kind == WeightedPoolUserData.JoinKind.PLACE_LONG_TERM_ORDER) {
            (, uint256 amountAIn, uint256 amountBIn) = _registerLongTermOrder(
                sender,
                recipient,
                updatedBalances,
                scalingFactors,
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

        if(address(_longTermOrders) != address(0)) {
            (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
                updatedBalances
            );
        }

        WeightedPoolUserData.ExitKind kind = userData.exitKind();
        if (kind == WeightedPoolUserData.ExitKind.CANCEL_LONG_TERM_ORDER) {
            return _cancelLongTermOrder(sender, userData);
        }
        if (kind == WeightedPoolUserData.ExitKind.WITHDRAW_LONG_TERM_ORDER) {
            return _withdrawLongTermOrder(sender, userData);
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
        if(address(_longTermOrders) != address(0)) {
            (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
                updatedBalances
            );
        }
        // TODO match balances with re-calculated updated balances, should match

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
        // TODO: Can we just remove this function and directly call _longTermOrders.performLongTermSwap?
        address /* sender */,
        address recipient,
        uint256[] memory balances,
        uint256[] memory /* scalingFactors */,
        bytes memory userData
    )
        internal
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return _longTermOrders.performLongTermSwap(recipient, balances, userData);
    }

    function _cancelLongTermOrder(address sender, bytes memory userData)
        internal
        returns (
            uint256,
            uint256[] memory,
            uint256[] memory
        )
    {
        uint256 orderId = WeightedPoolUserData.cancelLongTermOrder(userData);
        (uint256 purchasedAmount, uint256 unsoldAmount, ILongTermOrders.Order memory order) = _longTermOrders
            .cancelLongTermSwap(sender, orderId);

        // TODO handle dueProtocolFeeAmounts here
        if (order.buyTokenIndex == 0) {
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

    function _withdrawLongTermOrder(address sender, bytes memory userData)
        internal
        returns (
            uint256,
            uint256[] memory,
            uint256[] memory
        )
    {
        uint256 orderId = WeightedPoolUserData.withdrawLongTermOrder(userData);
        (uint256 proceeds, ILongTermOrders.Order memory order) = _longTermOrders.withdrawProceedsFromLongTermSwap(
            sender,
            orderId
        );

        // TODO handle dueProtocolFeeAmounts here
        if (order.sellTokenIndex == 0) {
            return (uint256(0), _getSizeTwoArray(uint256(0), proceeds), _getSizeTwoArray(uint256(0), uint256(0)));
        } else {
            return (uint256(0), _getSizeTwoArray(proceeds, uint256(0)), _getSizeTwoArray(uint256(0), uint256(0)));
        }
    }

    function _getUpdatedPoolBalances(uint256[] memory balances) internal view returns (uint256[] memory) {
        uint256[] memory updatedBalances = new uint256[](balances.length);

        if(address(_longTermOrders) != address(0)) {
            for (uint8 i = 0; i < balances.length; i++) {
                updatedBalances[i] = balances[i] - _longTermOrders.getTokenBalanceFromLongTermOrder(i);
            }
        } else {
            return balances;
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
        return WeightedMath._calculateInvariant(normalizedWeights, updatedBalances);
        // TODO Considering constant product amm
        //return updatedBalances[0].mulUp(updatedBalances[1]);
    }
}
