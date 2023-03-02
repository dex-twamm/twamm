import { expect } from 'chai';
import { Contract } from 'ethers';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { fp, bn } from '@balancer-labs/v2-helpers/src/numbers';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import { Decimal } from 'decimal.js';

describe('FixedPoint', () => {
  let lib: Contract;

  const EXPECTED_RELATIVE_ERROR = 1e-14;

  const valuesPow4 = [
    0.0007,
    0.0022,
    0.093,
    2.9,
    13.3,
    450.8,
    1550.3339,
    69039.11,
    7834839.432,
    83202933.5433,
    9983838318.4,
    15831567871.1,
  ];

  const valuesPow2 = [
    8e-9,
    0.0000013,
    0.000043,
    ...valuesPow4,
    8382392893832.1,
    38859321075205.1,
    848205610278492.2383,
    371328129389320282.3783289,
  ];

  const valuesPow1 = [
    1.7e-18,
    1.7e-15,
    1.7e-11,
    ...valuesPow2,
    701847104729761867823532.139,
    175915239864219235419349070.947,
  ];

  const valuesSquareRoot = [144, 169, 622521, 10000, 622715109129, 622715109129622715109129];
  const valuesExponents = [3, 7, 9, 119, 130];

  sharedBeforeEach('deploy lib', async () => {
    lib = await deploy('FixedPointMock', { args: [] });
  });

  const checkPow = async (x: number, pow: number) => {
    const result = fp(x ** pow);
    expectEqualWithError(await lib.powDown(fp(x), fp(pow)), result, EXPECTED_RELATIVE_ERROR);
    expectEqualWithError(await lib.powUp(fp(x), fp(pow)), result, EXPECTED_RELATIVE_ERROR);
  };

  const checkPows = async (pow: number, values: number[]) => {
    for (const value of values) {
      it(`handles ${value}`, async () => {
        await checkPow(value, pow);
      });
    }
  };

  const checkSquareRoot = async (x: number) => {
    const result = new Decimal(x).sqrt();
    expectEqualWithError(await lib.sqrt(fp(x)), fp(result.toString()), EXPECTED_RELATIVE_ERROR);
  };

  const checkSquareRoots = async (values: number[]) => {
    for (const value of values) {
      it(`handles ${value}`, async () => {
        await checkSquareRoot(value);
      });
    }
  };

  const checkNaturalExponent = async (x: number) => {
    const result = new Decimal(x).exp();
    expectEqualWithError(await lib.exp(fp(x)), fp(result.toString()), EXPECTED_RELATIVE_ERROR);
  };

  const checkNaturalExponents = async (values: number[]) => {
    for (const value of values) {
      it(`handles ${value}`, async () => {
        await checkNaturalExponent(value);
      });
    }
  };

  context('non-fractional pow 1', () => {
    checkPows(1, valuesPow1);
  });

  context('non-fractional pow 2', async () => {
    checkPows(2, valuesPow2);
  });

  context('non-fractional pow 4', async () => {
    checkPows(4, valuesPow4);
  });

  context('square root of', async () => {
    checkSquareRoots(valuesSquareRoot);
  });

  context('natural exponent of', async () => {
    checkNaturalExponents(valuesExponents);
  });

  it('can throw error for square root of max int', async () => {
    const MAX_UINT_256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    await expect(lib.sqrt(bn(MAX_UINT_256))).to.be.revertedWith('BAL#013');
  });
});
