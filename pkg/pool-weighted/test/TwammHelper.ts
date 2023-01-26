import { Decimal } from 'decimal.js';
import { bn } from '@balancer-labs/v2-helpers/src/numbers';
import { BigNumber } from 'ethers';
// import {Heap} from 'collections.js';

Decimal.set({ precision: 50 });

function executeVirtualOrders(
  aStartBn: BigNumber,
  bStartBn: BigNumber,
  aInBn: BigNumber,
  bInBn: BigNumber,
  balanceABn: BigNumber,
  balanceBBn: BigNumber,
  startBlock: number,
  endBlock: number
): BigNumber[] {
  const lastVirtualOrderBlock = startBlock;

  let aStart = new Decimal(aStartBn.toString());
  let bStart = new Decimal(bStartBn.toString());
  let balanceA = new Decimal(balanceABn.toString());
  let balanceB = new Decimal(balanceBBn.toString());

  const aIn = new Decimal(aInBn.toString());
  const bIn = new Decimal(bInBn.toString());

  [aStart, bStart, balanceA, balanceB] = calculateBalances(
    aStart,
    bStart,
    aIn,
    bIn,
    balanceA,
    balanceB,
    lastVirtualOrderBlock,
    endBlock
  );

  return [bn(aStart.toFixed(0)), bn(bStart.toFixed(0)), bn(balanceA.toFixed(0)), bn(balanceB.toFixed(0))];
}

function calculateBalances(
  aStart: Decimal,
  bStart: Decimal,
  aIn: Decimal,
  bIn: Decimal,
  balanceA: Decimal,
  balanceB: Decimal,
  lastVirtualOrderBlock: number,
  nextExpiryBlock: number
) {
  let outA: Decimal, outB: Decimal, aAmmEnd: Decimal, bAmmEnd: Decimal;
  aIn = aIn.times(nextExpiryBlock - lastVirtualOrderBlock);
  bIn = bIn.times(nextExpiryBlock - lastVirtualOrderBlock);
  const k = aStart.times(bStart);

  // console.log('\n*values before manipulation');
  // console.log('*aStart', 'bStart', aStart.toString(), bStart.toString());
  // console.log('*aIn', 'bIn', aIn.toString(), bIn.toString());
  // console.log('*balanceA', 'balanceB', balanceA.toString(), balanceB.toString());
  // console.log('*lastVirtualOrderBlock', 'nextExpiryBlock', lastVirtualOrderBlock, nextExpiryBlock);

  if (aIn.isZero() && !bIn.isZero()) {
    outA = aStart.times(bIn).dividedBy(bStart.plus(bIn));
    outB = new Decimal(0);
    aAmmEnd = aStart.minus(outA);
    bAmmEnd = bStart.plus(bIn);
  } else if (!aIn.isZero() && bIn.isZero()) {
    outB = bStart.times(aIn).dividedBy(aStart.plus(aIn));
    outA = new Decimal(0);
    aAmmEnd = aStart.plus(aIn);
    bAmmEnd = bStart.minus(outB);
  } else {
    const c1 = aStart.times(bIn).sqrt().minus(bStart.times(aIn).sqrt());
    const c2 = aStart.times(bIn).sqrt().plus(bStart.times(aIn).sqrt());
    const c = c1.dividedBy(c2);
    // console.log('*c', c.toString());

    const part1 = k.times(aIn).dividedBy(bIn).sqrt();
    const part21 = new Decimal(4).times(aIn.times(bIn).dividedBy(k)).sqrt();
    // console.log('*epow square', new Decimal(4).times(aIn.times(bIn).dividedBy(k)).toString());
    // console.log('*epow square root', part21.toString());
    const part2 = part21.exp();
    // console.log('*epow', part2.toString());

    aAmmEnd = part1.times(part2.plus(c).dividedBy(part2.minus(c)));
    bAmmEnd = aStart.times(bStart).dividedBy(aAmmEnd);

    outA = aStart.plus(aIn).minus(aAmmEnd);
    outB = bStart.plus(bIn).minus(bAmmEnd);
  }
  balanceA = balanceA.minus(aIn).plus(outA);
  balanceB = balanceB.minus(bIn).plus(outB);

  // console.log('\nValues after manipulation');
  // console.log('*balanceA', 'balanceB', balanceA.toString(), balanceB.toString());
  // console.log('*outA', 'outB', outA.toString(), outB.toString());
  // console.log('*aAmmEnd', 'bAmmEnd', aAmmEnd.toString(), bAmmEnd.toString());
  // console.log('\n\n');

  return [aAmmEnd, bAmmEnd, balanceA, balanceB];
}

export default executeVirtualOrders;
