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

import "../twamm/ILongTermOrders.sol";
import "./MockLongTermOrders.sol";

contract MockLongTermOrdersCaller {
    ILongTermOrders private _longTermOrders;
    MockLongTermOrders private _mockLongTermOrders;

    constructor(address longTermOrdersContractAddress) {
        _longTermOrders = ILongTermOrders(longTermOrdersContractAddress);
        _mockLongTermOrders = MockLongTermOrders(longTermOrdersContractAddress);
    }

    function executeLongTermOrdersAndPlaceLongTermOrder(
        uint256[] calldata balances,
        address sender,
        uint256 sellTokenIndex,
        uint256 buyTokenIndex,
        uint256 amountIn,
        uint256 numberOfBlockIntervals
    ) external {
        uint256[] memory updatedBalances = new uint256[](2);

        (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);
        _longTermOrders.performLongTermSwap(
            sender,
            updatedBalances,
            sellTokenIndex,
            buyTokenIndex,
            amountIn,
            numberOfBlockIntervals
        );
    }

    function executeVirtualOrdersUntilCurrentBlock(uint256[] calldata balances) external {
        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);
    }

    function executeLongTermOrdersAndCancelLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] calldata balances
    ) external {
        uint256[] memory updatedBalances = new uint256[](2);
        (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);

        _longTermOrders.cancelLongTermSwap(sender, orderId);
    }

    function executeLongTermOrdersAndWithdrawLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] calldata balances
    ) external {
        uint256[] memory updatedBalances = new uint256[](2);
        (updatedBalances[0], updatedBalances[1]) = _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);

        _longTermOrders.withdrawProceedsFromLongTermSwap(sender, orderId);
    }

    function getOrderExpiryHeap() external view returns (uint256[] memory) {
        return _mockLongTermOrders.getOrderExpiryHeap();
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
            uint256
        )
    {
        return _mockLongTermOrders.getLongTermOrder(orderId);
    }
}
