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

import "@balancer-labs/v2-solidity-utils/contracts/helpers/BalancerErrors.sol";

/* solhint-disable private-vars-leading-underscore */

library SignedFixedPoint {
    int256 internal constant ONE = 1e18; // 18 decimal places

    function add(int256 a, int256 b) internal pure returns (int256) {
        // Fixed Point addition is the same as regular checked addition

        int256 c = a + b;

        if (a >= 0 && b >= 0) {
            _require(c >= a, Errors.ADD_OVERFLOW);
        } else if (a <= 0 && b <= 0) {
            _require(c <= a, Errors.ADD_UNDERFLOW);
        }

        return c;
    }

    function sub(int256 a, int256 b) internal pure returns (int256) {
        // Fixed Point addition is the same as regular checked addition

        int256 c = a - b;
        if (a >= 0 && b <= 0) {
            _require(c >= a, Errors.SUB_OVERFLOW);
        } else if (a <= 0 && b >= 0) {
            _require(c <= a, Errors.SUB_UNDERFLOW);
        }

        return c;
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

    function toFixedPoint(int256 x) internal pure returns (uint256) {
        _require(x >= 0, Errors.UNDERFLOW);
        return uint256(x);
    }
}
