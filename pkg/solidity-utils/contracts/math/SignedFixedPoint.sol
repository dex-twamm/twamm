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

import "../helpers/BalancerErrors.sol";

/* solhint-disable private-vars-leading-underscore */

library SignedFixedPoint {
    int256 internal constant ONE = 1e18; // 18 decimal places
    int256 internal constant TWO = 2 * ONE;
    int256 internal constant FOUR = 4 * ONE;
    int256 internal constant MAX_POW_RELATIVE_ERROR = 10000; // 10^(-14)

    // Minimum base for the power function when the exponent is 'free' (larger than ONE).
    int256 internal constant MIN_POW_BASE_FREE_EXPONENT = 0.7e18;

    function add(int256 a, int256 b) internal pure returns (int256) {
        // Fixed Point addition is the same as regular checked addition

        int256 c = a + b;
        _require(c >= a, Errors.ADD_OVERFLOW);
        return c;
    }

    function sub(int256 a, int256 b) internal pure returns (int256) {
        // Fixed Point addition is the same as regular checked addition

        _require(b <= a, Errors.SUB_OVERFLOW);
        int256 c = a - b;
        return c;
    }

    function mulDown(int256 a, int256 b) internal pure returns (int256) {
        int256 product = a * b;
        _require(a == 0 || product / a == b, Errors.MUL_OVERFLOW);

        return product / ONE;
    }

    function mulUp(int256 a, int256 b) internal pure returns (int256) {
        int256 product = a * b;
        _require(a == 0 || product / a == b, Errors.MUL_OVERFLOW);

        if (product == 0) {
            return 0;
        } else {
            // The traditional divUp formula is:
            // divUp(x, y) := (x + y - 1) / y
            // To avoid intermediate overflow in the addition, we distribute the division and get:
            // divUp(x, y) := (x - 1) / y + 1
            // Note that this requires x != 0, which we already tested for.

            return ((product - 1) / ONE) + 1;
        }
    }

    function divDown(int256 a, int256 b) internal pure returns (int256) {
        _require(b != 0, Errors.ZERO_DIVISION);

        if (a == 0) {
            return 0;
        } else {
            int256 aInflated = a * ONE;
            _require(aInflated / a == ONE, Errors.DIV_INTERNAL); // mul overflow

            return aInflated / b;
        }
    }

    function divUp(int256 a, int256 b) internal pure returns (int256) {
        _require(b != 0, Errors.ZERO_DIVISION);

        if (a == 0) {
            return 0;
        } else {
            int256 aInflated = a * ONE;
            _require(aInflated / a == ONE, Errors.DIV_INTERNAL); // mul overflow

            // The traditional divUp formula is:
            // divUp(x, y) := (x + y - 1) / y
            // To avoid intermediate overflow in the addition, we distribute the division and get:
            // divUp(x, y) := (x - 1) / y + 1
            // Note that this requires x != 0, which we already tested for.

            return ((aInflated - 1) / b) + 1;
        }
    }

    /**
     * @dev Returns the complement of a value (1 - x), capped to 0 if x is larger than 1.
     *
     * Useful when computing the complement for values with some level of relative error, as it strips this error and
     * prevents intermediate negative values.
     */
    function complement(int256 x) internal pure returns (int256) {
        return (x < ONE) ? (ONE - x) : 0;
    }

    function fromInt(int256 x) internal pure returns (int256) {
        return x * ONE;
    }

    function toInt(int256 x) internal pure returns (int256) {
        return x / ONE;
    }

    // TODO fix these
    function fromUint(int256 x) internal pure returns (uint256) {
        return uint256(x);
    }

    function toUint(int256 x) internal pure returns (uint256) {
        return uint256(x);
    }
}
