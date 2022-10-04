//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

//@notice This is interface for LongTermOrders
abstract contract ILongTermOrders {
    //@notice information associated with a long term order
    struct Order {
        uint256 id;
        uint256 expirationBlock;
        uint256 saleRate;
        address owner;
        uint256 sellTokenIndex;
        uint256 buyTokenIndex;
    }

    function performLongTermSwap(
        address owner,
        uint256[] calldata balances,
        uint256 sellTokenIndex,
        uint256 buyTokenIndex,
        uint256 amountIn,
        uint256 numberOfBlockIntervals
    )
        external
        virtual
        returns (
            Order memory,
            uint256,
            uint256
        );

    //@notice cancel long term swap, pay out unsold tokens and well as purchased tokens
    function cancelLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] calldata balances
    )
        external
        virtual
        returns (
            uint256 purchasedAmount,
            uint256 unsoldAmount,
            Order memory order
        );

    //@notice withdraw proceeds from a long term swap (can be expired or ongoing)
    function withdrawProceedsFromLongTermSwap(
        address sender,
        uint256 orderId,
        uint256[] calldata balances
    )
        external
        virtual
        returns (
            uint256 proceeds,
            Order memory order,
            bool isPartialWithdrawal
        );

    //@notice executes all virtual orders until current block is reached.
    function executeVirtualOrdersUntilCurrentBlock(uint256[] calldata balances)
        external
        virtual
        returns (uint256 ammTokenA, uint256 ammTokenB);

    function getTokenBalanceFromLongTermOrder(uint256 tokenIndex) external view virtual returns (uint256 balance);

    function setMaxPerBlockSaleRatePercent(uint256 newMaxPerBlockSaleRatePercent) external virtual;

    function setMinLtoOrderAmountToAmmBalanceRatio(uint256 amountToAmmBalanceRatio) external virtual;
}
