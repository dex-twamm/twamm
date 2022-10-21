import { Decimal } from 'decimal.js';
// import {Heap} from 'collections.js';

Decimal.set({ precision: 50 });

function executeVirtualOrders(
  aStart: Decimal,
  bStart: Decimal,
  aIn: Decimal,
  bIn: Decimal,
  balanceA: Decimal,
  balanceB: Decimal,
  startBlock: number,
  endBlock: number,
  blockInterval: number
) {
  let lastVirtualOrderBlock = startBlock;
  let nextExpiryBlock = startBlock - (startBlock % blockInterval) + blockInterval;

  while (nextExpiryBlock < endBlock) {
    [aStart, bStart, balanceA, balanceB] = calculateBalances(
      aStart,
      bStart,
      aIn,
      bIn,
      balanceA,
      balanceB,
      lastVirtualOrderBlock,
      nextExpiryBlock
    );
    lastVirtualOrderBlock = nextExpiryBlock;
    nextExpiryBlock = nextExpiryBlock + blockInterval;
  }

  if (lastVirtualOrderBlock != endBlock) {
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
  }

  return [aStart, bStart, balanceA, balanceB];
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

  console.log('*aStart', 'bStart', aStart.toString(), bStart.toString());
  console.log('*aIn', 'bIn', aIn.toString(), bIn.toString());
  console.log('*balanceA', 'balanceB', balanceA.toString(), balanceB.toString());
  console.log('*lastVirtualOrderBlock', 'nextExpiryBlock', lastVirtualOrderBlock, nextExpiryBlock);

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

    console.log(c1.toString(), c2.toString(), c.toString());

    const part1 = k.times(aIn).dividedBy(bIn).sqrt();
    const part21 = new Decimal(2).times(aIn.times(bIn).dividedBy(k).sqrt());
    const part2 = part21.exp();

    aAmmEnd = part1.times(part2.plus(c).dividedBy(part2.minus(c)));
    bAmmEnd = aStart.times(bStart).dividedBy(aAmmEnd);

    outA = aStart.plus(aIn).minus(aAmmEnd);
    outB = bStart.plus(bIn).minus(bAmmEnd);
  }
  balanceA = balanceA.minus(aIn).plus(outA);
  balanceB = balanceB.minus(bIn).plus(outB);

  console.log('\n');
  console.log('*balanceA', 'balanceB', balanceA.toString(), balanceB.toString());
  console.log('*outA', 'outB', outA.toString(), outB.toString());
  console.log('*aAmmEnd', 'bAmmEnd', aAmmEnd.toString(), bAmmEnd.toString());
  console.log('\n\n');

  return [aAmmEnd, bAmmEnd, balanceA, balanceB];
}

const response = executeVirtualOrders(
  new Decimal('10000251256281407035175'),
  new Decimal('9999748750031406246076'),
  new Decimal('251256281407035175'),
  new Decimal('3992255025251013'),
  new Decimal('99748743718592964825'),
  new Decimal('200251249968593753924'),
  103,
  504,
  100
);

console.log(response[0].toString(), response[1].toString(), response[2].toString(), response[3].toString());
// console.log(fp(1).dividedBy(fp(2)), fp(1).toString(), fp(2).toString());
