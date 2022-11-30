pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "../twamm/LongTermOrders.sol";

contract MockLongTermOrders is LongTermOrders {
    LongTermOrders private _longTermOrders;

    constructor(uint256 orderBlockInterval) LongTermOrders(orderBlockInterval) {}

    function getOrderExpiryHeap() external view returns (uint256[] memory) {
        return longTermOrders.orderExpiryHeap;
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
        Order memory order = longTermOrders.orderMap[orderId];
        return (
            order.id,
            order.expirationBlock,
            order.saleRate,
            order.owner,
            order.sellTokenIndex,
            order.buyTokenIndex
        );
    }
}
