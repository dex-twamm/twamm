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
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/ReentrancyGuard.sol";
import "@balancer-labs/v2-solidity-utils/contracts/helpers/ERC20Helpers.sol";
import "@balancer-labs/v2-solidity-utils/contracts/openzeppelin/Ownable.sol";

import "hardhat/console.sol";

/**
 * @dev Basic Weighted Pool with immutable weights.
 */
contract TwammWeightedPool is BaseWeightedPool, Ownable, ReentrancyGuard {
    using WeightedPoolUserData for bytes;
    using FixedPoint for uint256;
    using WordCodec for bytes32;

    uint256 private constant _MAX_TOKENS = 2;
    uint256 private constant _MIN_SWAP_FEE_PERCENTAGE = 1e12; // 0.0001%
    uint256 private constant _MAX_SWAP_FEE_PERCENTAGE = 1e17; // 10% - this fits in 64 bits

    IERC20 internal immutable _token0;
    IERC20 internal immutable _token1;

    uint256 internal immutable _scalingFactor0;
    uint256 internal immutable _scalingFactor1;

    ILongTermOrders private _longTermOrders;

    // Twamm math depends on both the tokens being equal weight.
    uint256 internal _normalizedWeight0 = 0.5e18;
    uint256 internal _normalizedWeight1 = 0.5e18;

    mapping(uint256 => uint256) private _ltoCollectedFees;

    bool private _virtualOrderExecutionPaused = false;

    event LongTermOrderPlaced(
        uint256 orderId,
        uint256 indexed buyTokenIndex,
        uint256 indexed sellTokenIndex,
        uint256 saleRate,
        address indexed owner,
        uint256 expirationBlock
    );
    event LongTermOrderWithdrawn(
        uint256 orderId,
        uint256 indexed buyTokenIndex,
        uint256 indexed sellTokenIndex,
        uint256 saleRate,
        address indexed owner,
        uint256 expirationBlock,
        uint256 proceeds,
        bool isPartialWithdrawal
    );
    event LongTermOrderCancelled(
        uint256 orderId,
        uint256 indexed buyTokenIndex,
        uint256 indexed sellTokenIndex,
        uint256 saleRate,
        address indexed owner,
        uint256 expirationBlock,
        uint256 proceeds,
        uint256 unsoldAmount
    );

    event LongTermSwapFeePercentageChanged(uint256 longTermSwapFeePercentage);
    event LongTermOrderManagementFeesCollected(IERC20[] tokens, uint256[] amounts);

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

        _token0 = tokens[0];
        _token1 = tokens[1];

        _scalingFactor0 = _computeScalingFactor(tokens[0]);
        _scalingFactor1 = _computeScalingFactor(tokens[1]);

        if (longTermOrdersContractAddress != address(0)) {
            _longTermOrders = ILongTermOrders(longTermOrdersContractAddress);
            return;
        }

        // Code for unit tests.
        _require(normalizedWeights[0] >= WeightedMath._MIN_WEIGHT, Errors.MIN_WEIGHT);
        _require(normalizedWeights[1] >= WeightedMath._MIN_WEIGHT, Errors.MIN_WEIGHT);
        _virtualOrderExecutionPaused = true;
        _normalizedWeight0 = normalizedWeights[0];
        _normalizedWeight1 = normalizedWeights[1];
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

    function _getNormalizedWeights() internal view virtual override returns (uint256[] memory normalizedWeights) {
        normalizedWeights = _getSizeTwoArray(_normalizedWeight0, _normalizedWeight1);
    }

    function _getNormalizedWeightsAndMaxWeightIndex()
        internal
        view
        override
        returns (uint256[] memory normalizedWeights, uint256 maxWeightTokenIndex)
    {
        normalizedWeights = _getSizeTwoArray(_normalizedWeight0, _normalizedWeight1);
        if (!_virtualOrderExecutionPaused || normalizedWeights[0] >= normalizedWeights[1]) {
            maxWeightTokenIndex = 0;
        } else {
            maxWeightTokenIndex = 1;
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

    function _scalingFactors() internal view virtual override returns (uint256[] memory scalingFactors) {
        scalingFactors = _getSizeTwoArray(_scalingFactor0, _scalingFactor1);
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
            uint256 bptAmountOut,
            uint256[] memory amountsIn,
            uint256[] memory dueProtocolFeeAmounts
        )
    {
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        (bptAmountOut, amountsIn, dueProtocolFeeAmounts) = super._onJoinPool(
            poolId,
            sender,
            recipient,
            updatedBalances,
            lastChangeBlock,
            protocolSwapFeePercentage,
            scalingFactors,
            userData
        );

        _checkSplitProtocolFees(dueProtocolFeeAmounts);
    }

    function _doJoin(
        address recipient,
        uint256[] memory balances,
        uint256[] memory normalizedWeights,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal virtual override returns (uint256, uint256[] memory) {
        WeightedPoolUserData.JoinKind kind = userData.joinKind();
        // Check if it is a long term order, if it is then register it
        if (kind == WeightedPoolUserData.JoinKind.PLACE_LONG_TERM_ORDER) {
            return _registerLongTermOrder(recipient, balances, scalingFactors, userData);
        } else {
            if (!_virtualOrderExecutionPaused) {
                (balances[0], balances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);
            }

            return super._doJoin(recipient, balances, normalizedWeights, scalingFactors, userData);
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
            uint256 bptAmountIn,
            uint256[] memory amountsOut,
            uint256[] memory dueProtocolFeeAmounts
        )
    {
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        (bptAmountIn, amountsOut, dueProtocolFeeAmounts) = super._onExitPool(
            poolId,
            sender,
            recipient,
            updatedBalances,
            lastChangeBlock,
            protocolSwapFeePercentage,
            scalingFactors,
            userData
        );

        _checkSplitProtocolFees(dueProtocolFeeAmounts);
    }

    function _doExit(
        address sender,
        uint256[] memory balances,
        uint256[] memory normalizedWeights,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal virtual override returns (uint256, uint256[] memory) {
        WeightedPoolUserData.ExitKind kind = userData.exitKind();
        if (kind == WeightedPoolUserData.ExitKind.CANCEL_LONG_TERM_ORDER) {
            return _cancelLongTermOrder(sender, userData, balances, scalingFactors);
        } else if (kind == WeightedPoolUserData.ExitKind.WITHDRAW_LONG_TERM_ORDER) {
            return _withdrawLongTermOrder(sender, userData, balances, scalingFactors);
        } else if (kind == WeightedPoolUserData.ExitKind.MANAGEMENT_FEE_TOKENS_OUT) {
            return _exitManagerFeeTokensOut(sender);
        } else {
            if (!_virtualOrderExecutionPaused) {
                (balances[0], balances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);
            }

            return super._doExit(sender, balances, normalizedWeights, scalingFactors, userData);
        }
    }

    function _checkSplitProtocolFees(uint256[] memory dueProtocolFeeAmounts) private {
        for (uint256 i = 0; i < _MAX_TOKENS; ++i) {
            if (dueProtocolFeeAmounts[i] != 0) {
                uint256 ltoProtocolFee = dueProtocolFeeAmounts[i].divDown(FixedPoint.fromUint(2));

                dueProtocolFeeAmounts[i] = dueProtocolFeeAmounts[i].sub(ltoProtocolFee);
                _ltoCollectedFees[i] = _ltoCollectedFees[i].add(ltoProtocolFee);
            }
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
    ) internal returns (uint256[] memory updatedBalances) {
        uint256[] memory balances;

        if (_token0 == request.tokenIn) {
            balances = _getSizeTwoArray(balanceTokenIn, balanceTokenOut);
        } else {
            balances = _getSizeTwoArray(balanceTokenOut, balanceTokenIn);
        }

        updatedBalances = _getUpdatedPoolBalances(balances);
        if (!_virtualOrderExecutionPaused) {
            (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(
                updatedBalances
            );
        }
    }

    /**
     * Registers the long term order with the Pool.
     */
    function _registerLongTermOrder(
        address recipient,
        uint256[] memory balances,
        uint256[] memory scalingFactors,
        bytes memory userData
    ) internal returns (uint256, uint256[] memory) {
        (
            uint256 sellTokenIndex,
            uint256 buyTokenIndex,
            uint256 amountIn,
            uint256 numberOfBlockIntervals
        ) = WeightedPoolUserData.placeLongTermOrder(userData);

        amountIn = _upscale(amountIn, scalingFactors[sellTokenIndex]);

        (ILongTermOrders.Order memory order, uint256 amountAIn, uint256 amountBIn) = _longTermOrders
            .performLongTermSwap(recipient, balances, sellTokenIndex, buyTokenIndex, amountIn, numberOfBlockIntervals);

        _emitEventOrderPlaced(order, scalingFactors);

        // Return 0 bpt when long term order is placed
        return (uint256(0), _getSizeTwoArray(amountAIn, amountBIn));
    }

    function _emitEventOrderPlaced(ILongTermOrders.Order memory order, uint256[] memory scalingFactors) internal {
        emit LongTermOrderPlaced(
            order.id,
            order.buyTokenIndex,
            order.sellTokenIndex,
            _downscaleDown(order.saleRate, scalingFactors[order.sellTokenIndex]),
            order.owner,
            order.expirationBlock
        );
    }

    function _emitEventOrderCancelled(
        ILongTermOrders.Order memory order,
        uint256 purchasedAmount,
        uint256 unsoldAmount,
        uint256[] memory scalingFactors
    ) internal {
        emit LongTermOrderCancelled(
            order.id,
            order.buyTokenIndex,
            order.sellTokenIndex,
            _downscaleDown(order.saleRate, scalingFactors[order.sellTokenIndex]),
            order.owner,
            order.expirationBlock,
            _downscaleDown(purchasedAmount, scalingFactors[order.buyTokenIndex]),
            _downscaleDown(unsoldAmount, scalingFactors[order.sellTokenIndex])
        );
    }

    function _emitEventOrderWithdrawn(
        ILongTermOrders.Order memory order,
        uint256 proceeds,
        uint256[] memory scalingFactors,
        bool isPartialWithdrawal
    ) internal {
        emit LongTermOrderWithdrawn(
            order.id,
            order.buyTokenIndex,
            order.sellTokenIndex,
            _downscaleDown(order.saleRate, scalingFactors[order.sellTokenIndex]),
            order.owner,
            order.expirationBlock,
            _downscaleDown(proceeds, scalingFactors[order.buyTokenIndex]),
            isPartialWithdrawal
        );
    }

    function _cancelLongTermOrder(
        address sender,
        bytes memory userData,
        uint256[] memory balances,
        uint256[] memory scalingFactors
    ) internal returns (uint256, uint256[] memory) {
        uint256 orderId = WeightedPoolUserData.cancelLongTermOrder(userData);
        (uint256 purchasedAmount, uint256 unsoldAmount, ILongTermOrders.Order memory order) = _longTermOrders
            .cancelLongTermSwap(sender, orderId, balances);

        _emitEventOrderCancelled(order, purchasedAmount, unsoldAmount, scalingFactors);

        if (order.buyTokenIndex == 0) {
            return (uint256(0), _getSizeTwoArray(purchasedAmount, unsoldAmount));
        } else {
            return (uint256(0), _getSizeTwoArray(unsoldAmount, purchasedAmount));
        }
    }

    function _withdrawLongTermOrder(
        address sender,
        bytes memory userData,
        uint256[] memory balances,
        uint256[] memory scalingFactors
    ) internal returns (uint256, uint256[] memory) {
        uint256 orderId = WeightedPoolUserData.withdrawLongTermOrder(userData);
        (uint256 proceeds, ILongTermOrders.Order memory order, bool isPartialWithdrawal) = _longTermOrders
            .withdrawProceedsFromLongTermSwap(sender, orderId, balances);

        _emitEventOrderWithdrawn(order, proceeds, scalingFactors, isPartialWithdrawal);

        if (order.sellTokenIndex == 0) {
            return (uint256(0), _getSizeTwoArray(uint256(0), proceeds));
        } else {
            return (uint256(0), _getSizeTwoArray(proceeds, uint256(0)));
        }
    }

    function _getUpdatedPoolBalances(uint256[] memory balances)
        internal
        view
        returns (uint256[] memory updatedBalances)
    {
        if (address(_longTermOrders) != address(0)) {
            (uint256 balanceA, uint256 balanceB) = _longTermOrders.getLongTermOrdersBalances();

            updatedBalances = _getSizeTwoArray(balances[0], balances[1]);

            // Deduct the long term orders and long term order management fee from the pool balances.
            updatedBalances[0] = updatedBalances[0].sub(balanceA).sub(_ltoCollectedFees[0]);
            updatedBalances[1] = updatedBalances[1].sub(balanceB).sub(_ltoCollectedFees[1]);
        } else {
            return balances;
        }
    }

    function _getSizeTwoArray(uint256 a, uint256 b) internal pure returns (uint256[] memory array) {
        array = new uint256[](2);
        array[0] = a;
        array[1] = b;
    }

    function getInvariant() public view override returns (uint256) {
        (, uint256[] memory balances, ) = getVault().getPoolTokens(getPoolId());

        // Since the Pool hooks always work with upscaled balances, we manually
        // upscale here for consistency
        _upscaleArray(balances, _scalingFactors());

        (uint256[] memory normalizedWeights, ) = _getNormalizedWeightsAndMaxWeightIndex();
        uint256[] memory updatedBalances = _getUpdatedPoolBalances(balances);

        return _calculateInvariant(normalizedWeights, updatedBalances);
    }

    function setLongTermSwapFeePercentage(uint128 newLongTermSwapFeePercentage) external authenticate {
        // Fees should be fraction of 1.
        _require(newLongTermSwapFeePercentage >= _MIN_SWAP_FEE_PERCENTAGE, Errors.MIN_SWAP_FEE_PERCENTAGE);
        _require(newLongTermSwapFeePercentage <= _MAX_SWAP_FEE_PERCENTAGE, Errors.MAX_SWAP_FEE_PERCENTAGE);

        _longTermOrders.setLongTermSwapFeePercentage(newLongTermSwapFeePercentage);
        emit LongTermSwapFeePercentageChanged(newLongTermSwapFeePercentage);
    }

    function setMaxPerBlockSaleRatePercent(uint256 newMaxPerBlockSaleRatePercent) external authenticate {
        _longTermOrders.setMaxPerBlockSaleRatePercent(newMaxPerBlockSaleRatePercent);
    }

    function setMinLtoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRatio) external authenticate {
        _longTermOrders.setMinLtoOrderAmountToAmmBalanceRatio(amountToAmmBalanceRatio);
    }

    function getLongTermOrderContractAddress() external view returns (address) {
        return address(_longTermOrders);
    }

    function getCollectedManagementFees() public view returns (uint256[] memory collectedFees) {
        collectedFees = new uint256[](2);

        for (uint256 i = 0; i < 2; ++i) {
            collectedFees[i] = _ltoCollectedFees[i];
        }

        _downscaleDownArray(collectedFees, _scalingFactors());
    }

    function setOrderLimits(
        uint256 maxUniqueOrderExpiries,
        uint256 maxNumberOfBlockIntervals,
        uint256 maxVirtualOrderExecutionLoops
    ) external authenticate {
        _longTermOrders.setOrderLimits(
            maxUniqueOrderExpiries,
            maxNumberOfBlockIntervals,
            maxVirtualOrderExecutionLoops
        );
    }

    function setVirtualOrderExecutionPaused(bool virtualOrderExecutionPaused) external authenticate {
        require(
            virtualOrderExecutionPaused || _normalizedWeight0 == _normalizedWeight1,
            "Virtual order execution cannot be unpaused if weights not equal."
        );
        _virtualOrderExecutionPaused = virtualOrderExecutionPaused;
    }

    function withdrawLongTermOrderCollectedManagementFees(address recipient)
        external
        whenNotPaused
        authenticate
        nonReentrant
    {
        uint256[] memory collectedFees = getCollectedManagementFees();
        (IERC20[] memory tokens, , ) = getVault().getPoolTokens(getPoolId());

        getVault().exitPool(
            getPoolId(),
            address(this),
            payable(recipient),
            IVault.ExitPoolRequest({
                assets: _asIAsset(tokens),
                minAmountsOut: collectedFees,
                userData: abi.encode(WeightedPoolUserData.ExitKind.MANAGEMENT_FEE_TOKENS_OUT),
                toInternalBalance: false
            })
        );

        emit LongTermOrderManagementFeesCollected(tokens, collectedFees);
    }

    function _exitManagerFeeTokensOut(address sender)
        private
        whenNotPaused
        returns (uint256 bptAmountIn, uint256[] memory amountsOut)
    {
        // This exit function is disabled if the contract is paused.

        // This exit function can only be called by the Pool itself - the authorization logic that governs when that
        // call can be made resides in withdrawCollectedManagementFees.
        _require(sender == address(this), Errors.UNAUTHORIZED_EXIT);

        bptAmountIn = 0;

        amountsOut = new uint256[](2);

        for (uint256 i = 0; i < 2; ++i) {
            amountsOut[i] = _ltoCollectedFees[i];
            _ltoCollectedFees[i] = 0;
        }
    }

    /**
     * @dev Extend ownerOnly functions to include the Managed Pool control functions.
     */
    function _isOwnerOnlyAction(bytes32 actionId) internal view override returns (bool) {
        return
            (actionId == getActionId(TwammWeightedPool.withdrawLongTermOrderCollectedManagementFees.selector)) ||
            (actionId == getActionId(TwammWeightedPool.setLongTermSwapFeePercentage.selector)) ||
            (actionId == getActionId(TwammWeightedPool.setMaxPerBlockSaleRatePercent.selector)) ||
            (actionId == getActionId(TwammWeightedPool.setMinLtoOrderAmountToAmmBalanceRatio.selector)) ||
            (actionId == getActionId(TwammWeightedPool.setOrderLimits.selector)) ||
            (actionId == getActionId(TwammWeightedPool.setVirtualOrderExecutionPaused.selector)) ||
            super._isOwnerOnlyAction(actionId);
    }

    function getLongTermOrder(uint256 orderId)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            address,
            uint256,
            uint256,
            uint256
        )
    {
        (ILongTermOrders.Order memory order, uint256 boughtAmount) = _longTermOrders.getLongTermOrderAndBoughtAmount(
            orderId
        );

        return (
            order.id,
            order.expirationBlock,
            _downscaleDown(order.saleRate, _scalingFactors()[order.sellTokenIndex]),
            order.owner,
            order.sellTokenIndex,
            order.buyTokenIndex,
            _downscaleDown(boughtAmount, _scalingFactors()[order.buyTokenIndex])
        );
    }
}
