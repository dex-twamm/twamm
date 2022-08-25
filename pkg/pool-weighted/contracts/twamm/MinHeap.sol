//SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;

import "@balancer-labs/v2-solidity-utils/contracts/math/Math.sol";

contract MinHeap {

    using Math for uint256;

    // The main operations of a minHeap are insert, removeMin, getMin & isEmpty.
    constructor() public {
        // Start at 0
        heap = [0];
    }

    // We will be storing our heap in an array
    uint256[] public heap;

    // Inserts adds in a value to our heap.
    function insert(uint256 _value) public {
        // Add the value to the end of our array
        heap.push(_value);
        // Start at the end of the array
        uint256 currentIndex = heap.length.sub(1);

        // Bubble up the value until it reaches it's correct place (i.e. it is smaller than it's parent)
        while(currentIndex > 1 && heap[currentIndex.divDown(2)] > heap[currentIndex]) {

        // If the parent value is lower than our current value, we swap them
        (heap[currentIndex.divDown(2)], heap[currentIndex]) = (_value, heap[currentIndex.divDown(2)]);
        // change our current Index to go up to the parent
        currentIndex = currentIndex.divDown(2);
        }
    }

    // RemoveMax pops off the root element of the heap (the highest value here) and rebalances the heap
    function removeMin() public returns(uint256){
        // Ensure the heap exists
        require(heap.length > 1);
        // take the root value of the heap
        uint256 toReturn = heap[1];

        // Takes the last element of the array and put it at the root
        heap[1] = heap[heap.length.sub(1)];
        // Delete the last element from the array
        heap.pop();
    
        // Start at the top
        uint256 currentIndex = 1;

        // Bubble down
        while(currentIndex.mul(2) < heap.length.sub(1)) {
            // get the current index of the children
            uint256 j = currentIndex.mul(2);

            // left child value
            uint256 leftChild = heap[j];
            // right child value
            uint256 rightChild = heap[j.add(1)];

            // Compare the left and right child. if the rightChild is greater, then point j to it's index
            if (leftChild > rightChild) {
                j = j.add(1);
            }

            // compare the current parent value with the highest child, if the parent is greater, we're done
            if(heap[currentIndex] < heap[j]) {
                break;
            }

            // else swap the value
            (heap[currentIndex], heap[j]) = (heap[j], heap[currentIndex]);

            // and let's keep going down the heap
            currentIndex = j;
        }
            // finally, return the top of the heap
            return toReturn;
    }


    function getHeap() public view returns(uint256[] memory) {
        return heap;
    }

    function getMin() public view returns(uint256) {
        return heap[1];
    }

    function isEmpty() public view returns(bool) {
        return heap.length == 1;
    }

}