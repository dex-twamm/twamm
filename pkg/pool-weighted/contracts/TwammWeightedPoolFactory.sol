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

import "@balancer-labs/v2-vault/contracts/interfaces/IVault.sol";

import "@balancer-labs/v2-pool-utils/contracts/factories/BasePoolSplitCodeFactory.sol";
import "@balancer-labs/v2-pool-utils/contracts/factories/FactoryWidePauseWindow.sol";

import "./twamm/LongTermOrders.sol";
import "./TwammWeightedPool.sol";

contract TwammWeightedPoolFactory is BasePoolSplitCodeFactory, FactoryWidePauseWindow {
    event LongTermOrdersContractCreated(address indexed ltoContract);

    constructor(IVault vault) BasePoolSplitCodeFactory(vault, type(TwammWeightedPool).creationCode) {
        // solhint-disable-previous-line no-empty-blocks
    }

    /**
     * @dev Deploys a new `TwammWeightedPool`.
     */
    function create(
        string memory name,
        string memory symbol,
        IERC20[] memory tokens,
        uint256[] memory weights,
        uint256 swapFeePercentage,
        address owner,
        uint256 orderBlockInterval
    ) external returns (address poolAddress) {
        (uint256 pauseWindowDuration, uint256 bufferPeriodDuration) = getPauseConfiguration();

        LongTermOrders longTermOrdersContract = new LongTermOrders(orderBlockInterval);
        emit LongTermOrdersContractCreated(address(longTermOrdersContract));

        poolAddress = _create(
            abi.encode(
                getVault(),
                name,
                symbol,
                tokens,
                weights,
                swapFeePercentage,
                pauseWindowDuration,
                bufferPeriodDuration,
                owner,
                address(longTermOrdersContract)
            )
        );

        longTermOrdersContract.transferOwnership(poolAddress);
    }
}
