import { BigNumberish, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { expect } from 'chai';
import Decimal from 'decimal.js';
import { BigNumber } from 'ethers';

export function convertAmountsArrayToBn(amounts: Array<Decimal | BigNumberish>): Array<BigNumber> {
  expect(amounts.length).to.equal(2);
  return [fp(amounts[0]), fp(amounts[1])];
}
