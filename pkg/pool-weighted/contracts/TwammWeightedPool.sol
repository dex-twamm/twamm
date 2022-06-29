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
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/Ownable.sol";

/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract TwammWeightedPool is WeightedPool, Ownable {
    uint256 private constant _MAX_TOKENS = 2;
    uint256 private constant _ALLOWED_WEIGHT = 0.5e18;

    using LongTermOrdersLib for LongTermOrdersLib.LongTermOrders;
    using WeightedPoolUserData for bytes;
    using FixedPoint for uint256;

    LongTermOrdersLib.LongTermOrders internal _longTermOrders;

    uint256 private _longTermSwapFeePercentage = 0;

    event LongTermOrderPlaced(
        uint256 id,
        IERC20 indexed buyToken,
        IERC20 indexed sellToken,
        uint256 saleRate,
        address indexed owner,
        uint256 expirationBlock
    );
    event LongTermOrderWithdrawn(
        uint256 id,
        IERC20 indexed buyToken,
        IERC20 indexed sellToken,
        uint256 saleRate,
        address indexed owner,
        uint256 expirationBlock,
        uint256 proceeds
    );
    event LongTermOrderCancelled(
        uint256 id,
        IERC20 indexed buyToken,
        IERC20 indexed sellToken,
        uint256 saleRate,
        address indexed owner,
        uint256 expirationBlock,
        uint256 proceeds,
        uint256 unsoldAmount
    );

    event LongTermSwapFeePercentageChanged(uint256 longTermSwapFeePercentage);

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
        _require(tokens.length == _MAX_TOKENS, Errors.NOT_TWO_TOKENS);
        // TODO Fix tests for this
        // _require(normalizedWeights[0] == _ALLOWED_WEIGHT, Errors.WEIGHTS_NOT_ALLOWED);
        // _require(normalizedWeights[1] == _ALLOWED_WEIGHT, Errors.WEIGHTS_NOT_ALLOWED);

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

        (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
            updatedBalances
        );

        WeightedPoolUserData.JoinKind kind = userData.joinKind();
        // Check if it is a long term order, if it is then register it
        if (kind == WeightedPoolUserData.JoinKind.PLACE_LONG_TERM_ORDER) {
            (uint256 orderId, uint256 amountAIn, uint256 amountBIn) = _registerLongTermOrder(
                sender,
                recipient,
                updatedBalances,
                scalingFactors,
                userData
            );

            emit LongTermOrderPlaced(
                _longTermOrders.orderMap[orderId].id,
                _longTermOrders.orderMap[orderId].sellTokenIndex == 0 ? _token0 : _token1,
                _longTermOrders.orderMap[orderId].buyTokenIndex == 0 ? _token0 : _token1,
                _longTermOrders.orderMap[orderId].saleRate,
                _longTermOrders.orderMap[orderId].owner,
                _longTermOrders.orderMap[orderId].expirationBlock
            );

            // Return 0 bpt when long term order is placed
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
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
            updatedBalances
        );

        WeightedPoolUserData.ExitKind kind = userData.exitKind();
        if (kind == WeightedPoolUserData.ExitKind.CANCEL_LONG_TERM_ORDER) {
            return _cancelLongTermOrder(sender, userData);
        } else if (kind == WeightedPoolUserData.ExitKind.WITHDRAW_LONG_TERM_ORDER) {
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

    function _onSwapGivenIn(
        SwapRequest memory swapRequest,
        uint256 currentBalanceTokenIn,
        uint256 currentBalanceTokenOut
    ) internal virtual override whenNotPaused returns (uint256) {
        uint256[] memory balances = _onSwapHook(swapRequest, currentBalanceTokenIn, currentBalanceTokenOut);

        if (_token0 == swapRequest.tokenIn) {
            return super._onSwapGivenIn(swapRequest, balances[0], balances[1]);
        } else {
            return super._onSwapGivenIn(swapRequest, balances[1], balances[0]);
        }
    }

    function _onSwapGivenOut(
        SwapRequest memory swapRequest,
        uint256 currentBalanceTokenIn,
        uint256 currentBalanceTokenOut
    ) internal virtual override whenNotPaused returns (uint256) {
        uint256[] memory balances = _onSwapHook(swapRequest, currentBalanceTokenIn, currentBalanceTokenOut);

        if (_token0 == swapRequest.tokenIn) {
            return super._onSwapGivenOut(swapRequest, balances[0], balances[1]);
        } else {
            return super._onSwapGivenOut(swapRequest, balances[1], balances[0]);
        }
    }

    function _onSwapHook(
        SwapRequest memory request,
        uint256 balanceTokenIn,
        uint256 balanceTokenOut
    ) internal returns (uint256[] memory) {
        uint256[] memory balances = new uint256[](2);

        if (_token0 == request.tokenIn) {
            balances = _getSizeTwoArray(balanceTokenIn, balanceTokenOut);
        } else {
            balances = _getSizeTwoArray(balanceTokenOut, balanceTokenIn);
        }

        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);
        (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
            updatedBalances
        );

        return updatedBalances;
    }

    /**
     * Registers the long term order with the Pool.
     */
    function _registerLongTermOrder(
        address sender,
        address recipient,
        uint256[] memory balances,
        uint256[] memory scalingFactors,
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
            uint256 sellTokenIndex,
            uint256 buyTokenIndex,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        ) = WeightedPoolUserData.placeLongTermOrder(userData);

        _upscale(amountIn, scalingFactors[sellTokenIndex]);

        return
            _longTermOrders.performLongTermSwap(
                recipient,
                balances,
                sellTokenIndex,
                buyTokenIndex,
                amountIn,
                numberOfBlockIntervals
            );
    }

    function _calculateLongTermOrderProtocolFees(
        uint256 sellTokenIndex,
        uint256 buyTokenIndex,
        uint256 unsoldAmount,
        uint256 purchasedAmount
    )
        internal
        returns (
            uint256[] memory,
            uint256,
            uint256
        )
    {
        uint256[] memory protocolFees = new uint256[](2);

        protocolFees[sellTokenIndex] = unsoldAmount.mulUp(_longTermSwapFeePercentage);
        protocolFees[buyTokenIndex] = purchasedAmount.mulUp(_longTermSwapFeePercentage);

        return (
            protocolFees,
            purchasedAmount.sub(protocolFees[buyTokenIndex]),
            unsoldAmount.sub(protocolFees[sellTokenIndex])
        );
    }

    function _cancelLongTermOrder(address sender, bytes memory userData)
        internal
        returns (
            uint256,
            uint256[] memory,
            uint256[] memory protocolFees
        )
    {
        uint256 orderId = WeightedPoolUserData.cancelLongTermOrder(userData);
        (uint256 purchasedAmount, uint256 unsoldAmount, LongTermOrdersLib.Order memory order) = _longTermOrders
            .cancelLongTermSwap(sender, orderId);

        (protocolFees, purchasedAmount, unsoldAmount) = _calculateLongTermOrderProtocolFees(
            order.sellTokenIndex,
            order.buyTokenIndex,
            unsoldAmount,
            purchasedAmount
        );

        emit LongTermOrderCancelled(
            order.id,
            order.buyTokenIndex == 0 ? _token0 : _token1,
            order.sellTokenIndex == 0 ? _token0 : _token1,
            order.saleRate,
            order.owner,
            order.expirationBlock,
            purchasedAmount,
            unsoldAmount
        );

        if (order.buyTokenIndex == 0) {
            return (uint256(0), _getSizeTwoArray(purchasedAmount, unsoldAmount), protocolFees);
        } else {
            return (uint256(0), _getSizeTwoArray(unsoldAmount, purchasedAmount), protocolFees);
        }
    }

    function _withdrawLongTermOrder(address sender, bytes memory userData)
        internal
        returns (
            uint256,
            uint256[] memory,
            uint256[] memory protocolFees
        )
    {
        uint256 orderId = WeightedPoolUserData.withdrawLongTermOrder(userData);
        (uint256 proceeds, LongTermOrdersLib.Order memory order) = _longTermOrders.withdrawProceedsFromLongTermSwap(
            sender,
            orderId
        );

        (protocolFees, proceeds, ) = _calculateLongTermOrderProtocolFees(
            order.sellTokenIndex,
            order.buyTokenIndex,
            0,
            proceeds
        );

        emit LongTermOrderWithdrawn(
            order.id,
            order.buyTokenIndex == 0 ? _token0 : _token1,
            order.sellTokenIndex == 0 ? _token0 : _token1,
            order.saleRate,
            order.owner,
            order.expirationBlock,
            proceeds
        );

        if (order.sellTokenIndex == 0) {
            return (uint256(0), _getSizeTwoArray(uint256(0), proceeds), protocolFees);
        } else {
            return (uint256(0), _getSizeTwoArray(proceeds, uint256(0)), protocolFees);
        }
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
        return WeightedMath._calculateInvariant(normalizedWeights, updatedBalances);
        // TODO Considering constant product amm
        // return updatedBalances[0].mulUp(updatedBalances[1]);
    }

    function setMaxltoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRation) external onlyOwner {
        _longTermOrders.maxltoOrderAmountToAmmBalanceRatio = amountToAmmBalanceRation;
    }

    function setMinltoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRation) external onlyOwner {
        _longTermOrders.minltoOrderAmountToAmmBalanceRatio = amountToAmmBalanceRation;
    }

    function setLongTermSwapFeePercentage(uint256 newLongTermSwapFeePercentage) external onlyOwner {
        _longTermSwapFeePercentage = newLongTermSwapFeePercentage;
        emit LongTermSwapFeePercentageChanged(newLongTermSwapFeePercentage);
    }
}
