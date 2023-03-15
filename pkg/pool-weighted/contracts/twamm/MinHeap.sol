//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.0;

import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";

library MinHeap {
    using Math for uint256;

    // Inserts adds in a value to our heap.
    function insert(uint256[] storage heap, uint256 _value) internal {
        // Add the value to the end of our array
        heap.push(_value);

        // Start at the end of the array
        uint256 currentIndex = heap.length - 1;
        if (currentIndex > 1) {
            uint256 parentIndex = currentIndex / 2;

            // Bubble up the value until it reaches it's correct place (i.e. it is smaller than it's parent)
            while (currentIndex > 1 && heap[parentIndex] > _value) {
                // If the parent value is greater than our current value, move it to current index.
                heap[currentIndex] = heap[parentIndex];
                // change our current Index to go up to the parent
                currentIndex = parentIndex;
                parentIndex = currentIndex / 2;
            }

            heap[currentIndex] = _value;
        }
    }

    // RemoveMax pops off the root element of the heap (the highest value here) and rebalances the heap
    function removeMin(uint256[] storage heap) internal returns (uint256) {
        uint256 initialHeapLength = heap.length;
        // Ensure the heap exists
        _require(initialHeapLength > 1, Errors.HEAP_EMPTY);
        // take the root value of the heap
        uint256 toReturn = heap[1];

        // Start at the top
        uint256 currentIndex = 1;

        // Take the last element of the array to move it to it's correct place.
        uint256 parentValue = heap[initialHeapLength - 1];
        uint256 childIndex = currentIndex * 2;

        // Bubble down
        while (childIndex <= initialHeapLength - 2) {
            // Assume left child is smaller.
            uint256 lesserChild = heap[childIndex];

            // Compare the left and right child. if the rightChild is lesser, then point j to it's index
            if (childIndex != initialHeapLength - 2 && lesserChild > heap[childIndex + 1]) {
                lesserChild = heap[childIndex + 1];
                childIndex = childIndex + 1;
            }

            // compare the current parent value with the highest child, if the parent is lesser, we're done
            if (parentValue < lesserChild) {
                break;
            }

            // else move lesser child to current index.
            heap[currentIndex] = lesserChild;

            // and let's keep going down the heap
            currentIndex = childIndex;
            childIndex = currentIndex * 2;
        }

        heap[currentIndex] = parentValue;

        // Delete the last element from the array
        heap.pop();

        // finally, return the top of the heap
        return toReturn;
    }

    function getMin(uint256[] storage heap) internal view returns (uint256) {
        return heap[1];
    }

    function isEmpty(uint256[] storage heap) internal view returns (bool) {
        return heap.length == 1;
    }
}
