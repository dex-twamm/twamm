//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.0;

import "./MinHeap.sol";

contract MinHeapTest {
    using MinHeap for uint256[];

    uint256[] public heap;

    // The main operations of a minHeap are insert, removeMin, getMin & isEmpty.
    constructor() {
        // Start at 0
        heap = [0];
    }

    function getHeap() public view returns (uint256[] memory) {
        return heap;
    }

    function getMin() public view returns (uint256) {
        return heap.getMin();
    }

    function insert(uint256 _value) public {
        heap.insert(_value);
    }

    function isEmpty() public view returns (bool) {
        return heap.isEmpty();
    }

    function removeMin() public returns (uint256) {
        return heap.removeMin();
    }
}
