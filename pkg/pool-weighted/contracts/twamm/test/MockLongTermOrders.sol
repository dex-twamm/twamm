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

import "hardhat/console.sol";
import "../LongTermOrders.sol";

contract MockLongTermOrders {
    using LongTermOrdersLib for LongTermOrdersLib.LongTermOrders;

    LongTermOrdersLib.LongTermOrders internal _longTermOrders;

    function initialize(uint256 lastVirtualOrderBlock, uint256 orderBlockInterval) external {
        _longTermOrders.initialize(lastVirtualOrderBlock, orderBlockInterval);
    }

    function performLongTermSwap(address owner, bytes memory orderData)
        external
        returns (
            uint256,
            uint256,
            uint256
        )
    {
        return _longTermOrders.performLongTermSwap(owner, orderData);
    }

    function executeVirtualOrdersUntilCurrentBlock(uint256[] memory balances) external {
        _longTermOrders.executeVirtualOrdersUntilCurrentBlock(balances);
    }

    function cancelLongTermSwap(address sender, uint256 orderId) external returns (uint256, uint256) {
        return _longTermOrders.cancelLongTermSwap(sender, orderId);
    }

    function withdrawProceedsFromLongTermSwap(address sender, uint256 orderId) external returns (uint256) {
        return _longTermOrders.withdrawProceedsFromLongTermSwap(sender, orderId);
    }

    function getLastVirtualOrderBlock() external view returns (uint256) {
        return _longTermOrders.lastVirtualOrderBlock;
    }

    function getOrderBlockInterval() external view returns (uint256) {
        return _longTermOrders.orderBlockInterval;
    }

    function getOrderId() external view returns (uint256) {
        return _longTermOrders.orderId;
    }

    function getBalanceA() external view returns (uint256) {
        return _longTermOrders.balanceA;
    }

    function getBalanceB() external view returns (uint256) {
        return _longTermOrders.balanceB;
    }

    function getLongTermOrdersDetails()
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256
        )
    {
        return (
            _longTermOrders.balanceA,
            _longTermOrders.balanceB,
            _longTermOrders.orderId,
            _longTermOrders.lastVirtualOrderBlock,
            _longTermOrders.orderBlockInterval
        );
    }

    function getOrderPoolDetails(uint256 tokenIndex) external view returns (uint256, uint256) {
        return (
            _longTermOrders.orderPoolMap[tokenIndex].currentSalesRate,
            _longTermOrders.orderPoolMap[tokenIndex].rewardFactor
        );
    }

    function getOrderDetails(uint256 index)
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
        return (
            _longTermOrders.orderMap[index].id,
            _longTermOrders.orderMap[index].expirationBlock,
            _longTermOrders.orderMap[index].saleRate,
            _longTermOrders.orderMap[index].owner,
            _longTermOrders.orderMap[index].sellTokenIndex,
            _longTermOrders.orderMap[index].buyTokenIndex
        );
    }
}
