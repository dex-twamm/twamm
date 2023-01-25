//SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.0;

import "./SignedFixedPoint.sol";

contract SignedFixedPointTest {
    using SignedFixedPoint for int256;


    function divUp(int256 a, int256 b) public pure returns (int256) {
        return a.divUp(b);
    }
}