import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract, BigNumber } from 'ethers';
import { decimal, fp, bn } from '@balancer-labs/v2-helpers/src/numbers';

import executeVirtualOrders from './TwammHelper';
import { Decimal } from 'decimal.js';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { lastBlockNumber } from '@balancer-labs/v2-helpers/src/time';
import { Address } from 'cluster';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';

const ONE = BigNumber.from(1);
const TWO = BigNumber.from(2);

Decimal.set({ precision: 50, rounding: 3 });

function sqrt(value: BigNumber): BigNumber {
  const x = BigNumber.from(value);
  let z = x.add(ONE).div(TWO);
  let y = x;
  while (z.sub(y).isNegative()) {
    y = z;
    z = x.div(z).add(z).div(TWO);
  }

  return y;
}

describe('LongTermOrders', function () {
  let longTermOrders: Contract;
  let anAddress: SignerWithAddress, anAddress1: SignerWithAddress, anAddress2: SignerWithAddress;
  let blockNumber: number;

  const EXPECTED_RELATIVE_ERROR = 1e-13;
  const orderBlockInterval = 100;

  async function verifyOrderDetails(
    orderId: number,
    expirationBlock: number,
    salesRate: BigNumber,
    owner: string,
    sellTokenIndex: number,
    buyTokenIndex: number
  ) {
    const orderDetails: [BigNumber, BigNumber, BigNumber, Address, BigNumber, BigNumber] = (
      await longTermOrders.getLongTermOrderAndBoughtAmount(orderId)
    )[0];

    expect(orderDetails[0]).to.be.equal(orderId);
    expect(orderDetails[1]).to.be.equal(expirationBlock);
    expect(orderDetails[2]).to.be.equal(salesRate);
    expect(orderDetails[3]).to.be.equal(owner);
    expect(orderDetails[4]).to.be.equal(sellTokenIndex);
    expect(orderDetails[5]).to.be.equal(buyTokenIndex);
  }

  function verifyOrderPoolDetails(
    orderPoolDetails: [BigNumber, BigNumber],
    currentSalesRate: BigNumber,
    rewardFactor: BigNumber
  ) {
    expect(orderPoolDetails[0]).to.be.equal(currentSalesRate);
    expect(orderPoolDetails[1]).to.be.equal(rewardFactor);
  }

  function verifyLongTermOrdersDetails(
    longTermOrdersDetails: [BigNumber, BigNumber, BigNumber, BigNumber, BigNumber],
    balanceA: BigNumber,
    balanceB: BigNumber,
    orderId: number,
    lastVirtualOrderBlock: number,
    orderBlockInterval: number
  ) {
    expect(longTermOrdersDetails[0]).to.be.equal(balanceA);
    expect(longTermOrdersDetails[1]).to.be.equal(balanceB);
    expect(longTermOrdersDetails[2]).to.be.equal(orderId);
    expect(longTermOrdersDetails[3]).to.be.equal(lastVirtualOrderBlock);
    expect(longTermOrdersDetails[4]).to.be.equal(orderBlockInterval);
  }

  function verifyTokenBalances(tokenBalances: [BigNumber, BigNumber], balanceA: BigNumber, balanceB: BigNumber) {
    // Expect both balances to be within 1e-15 of expected values.
    expectEqualWithError(tokenBalances[0], balanceA, EXPECTED_RELATIVE_ERROR);
    expectEqualWithError(tokenBalances[1], balanceB, EXPECTED_RELATIVE_ERROR);

    // expect(tokenBalances[1]).to.be.lte(balanceB.add(1000));
    // expect(tokenBalances[1]).to.be.gte(balanceB.sub(1000));
  }

  function getOrderExpiryBlock(numberOfBlockIntervals: number, blockNumber: number): number {
    return orderBlockInterval * (numberOfBlockIntervals + 1) + blockNumber - (blockNumber % orderBlockInterval);
  }

  async function moveForwardNBlocks(n: number): Promise<number> {
    for (let index = 0; index < n; index++) {
      await ethers.provider.send('evm_mine', []);
    }

    return await lastBlockNumber();
  }
  function getSaleRate(amount: BigNumber, numberOfBlockIntervals: number, blockNumber: number): BigNumber {
    return amount.div(orderBlockInterval * (numberOfBlockIntervals + 1) - (blockNumber % orderBlockInterval));
  }

  async function getOrderBlockInterval(): Promise<BigNumber> {
    return bn((await longTermOrders.longTermOrders()).orderBlockInterval);
  }

  async function getLastVirtualOrderBlock(): Promise<BigNumber> {
    return bn((await longTermOrders.longTermOrders()).lastVirtualOrderBlock);
  }

  async function getOrderDetails(
    index: number
  ): Promise<[BigNumber, BigNumber, BigNumber, Address, BigNumber, BigNumber]> {
    return [
      bn((await longTermOrders.longTermOrders()).orderMap[index].id),
      bn((await longTermOrders.longTermOrders()).orderMap[index].expirationBlock),
      bn((await longTermOrders.longTermOrders()).orderMap[index].saleRate),
      (await longTermOrders.longTermOrders()).orderMap[index].owner.toString(),
      bn((await longTermOrders.longTermOrders()).orderMap[index].sellTokenIndex),
      bn((await longTermOrders.longTermOrders()).orderMap[index].buyTokenIndex),
    ];
  }

  async function getOrderPoolDetails(tokenIndex: number): Promise<[BigNumber, BigNumber]> {
    return [
      bn((await longTermOrders.longTermOrders()).orderPoolMap[tokenIndex].currentSalesRate),
      bn((await longTermOrders.longTermOrders()).orderPoolMap[tokenIndex].rewardFactor),
    ];
  }

  async function getLongTermOrdersDetails(): Promise<[BigNumber, BigNumber, BigNumber, BigNumber, BigNumber]> {
    return [
      bn((await longTermOrders.longTermOrders()).balanceA),
      bn((await longTermOrders.longTermOrders()).balanceB),
      bn((await longTermOrders.longTermOrders()).lastOrderId),
      bn((await longTermOrders.longTermOrders()).lastVirtualOrderBlock),
      bn((await longTermOrders.longTermOrders()).orderBlockInterval),
    ];
  }

  async function placeLongTermOrder(
    address: string,
    tokenInIndex: number,
    tokenOutIndex: number,
    amount: BigNumber,
    numberOfBlockIntervals: number,
    balances: [BigNumber, BigNumber]
  ): Promise<[number, BigNumber]> {
    await longTermOrders.performLongTermSwap(
      address,
      balances,
      tokenInIndex,
      tokenOutIndex,
      amount,
      numberOfBlockIntervals
    );

    const lastBlock = await lastBlockNumber();

    return [lastBlock, getSaleRate(amount, numberOfBlockIntervals, lastBlock)];
  }

  describe('init', () => {
    before('setup', async function () {
      longTermOrders = await deploy('LongTermOrders', { args: [orderBlockInterval] });
      [, anAddress] = await ethers.getSigners();

      blockNumber = await lastBlockNumber();
    });

    it('initialize long term orders library', async () => {
      const lastVirtualOrderBlock = await getLastVirtualOrderBlock();
      const orderBlockInterval = await getOrderBlockInterval();

      expect(lastVirtualOrderBlock).to.be.equal(blockNumber);
      expect(orderBlockInterval).to.be.equal(orderBlockInterval);
    });
  });

  describe('place long term order, order expiry calculation', () => {
    before('setup', async function () {
      longTermOrders = await deploy('LongTermOrders', { args: [orderBlockInterval] });
      [, anAddress] = await ethers.getSigners();

      blockNumber = await lastBlockNumber();
    });

    it('can calculate order expiry properly for border cases', async () => {
      const amount = fp(100),
        orderInterval = 100;

      const ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      // Move to closest expiry block
      await moveForwardNBlocks(orderBlockInterval - (await lastBlockNumber()) - 1);

      const [orderPlacementBlock, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        amount,
        orderInterval,
        ammBalances
      );

      const orderDetails = (await longTermOrders.getLongTermOrderAndBoughtAmount(0))[0];

      expect(orderPlacementBlock % orderBlockInterval == 0).to.be.true;
      expect(orderDetails[1]).to.be.equal(orderPlacementBlock + orderInterval * orderBlockInterval);
    });
  });

  describe('place long term order', () => {
    sharedBeforeEach('setup', async function () {
      longTermOrders = await deploy('LongTermOrders', { args: [orderBlockInterval] });
      [, anAddress, anAddress1, anAddress2] = await ethers.getSigners();

      blockNumber = await lastBlockNumber();
    });

    it('can place long term order', async () => {
      const amount = fp(100),
        orderInterval = 100;

      const ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlock, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        amount,
        orderInterval,
        ammBalances
      );

      // const orderPoolDetailsA = await getOrderPoolDetails(0);
      // const orderPoolDetailsB = await getOrderPoolDetails(1);
      const longTermOrdersDetails = await getLongTermOrdersDetails();

      await verifyOrderDetails(
        0,
        getOrderExpiryBlock(orderInterval, orderPlacementBlock),
        salesRateA,
        anAddress.address,
        0,
        1
      );
      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, fp(0));
      // verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, amount, fp(0), 1, orderPlacementBlock, orderBlockInterval);
    });

    it('can place long term order in both directions', async () => {
      let balanceA, balanceB;
      const amount1 = fp(100),
        amount2 = fp(100),
        orderIntervalA = 100,
        orderIntervalB = 500,
        ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        amount1,
        orderIntervalA,
        ammBalances
      );

      const longTermOrdersDetails1 = await getLongTermOrdersDetails();

      await verifyOrderDetails(
        0,
        getOrderExpiryBlock(orderIntervalA, orderPlacementBlockA),
        salesRateA,
        anAddress.address,
        0,
        1
      );
      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails1, amount1, fp(0), 1, orderPlacementBlockA, orderBlockInterval);

      const [orderPlacementBlockB, salesRateB] = await placeLongTermOrder(
        anAddress1.address,
        1,
        0,
        amount2,
        orderIntervalB,
        ammBalances
      );

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        amount1,
        amount2,
        orderPlacementBlockA,
        orderPlacementBlockA + 1
      );

      // const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      // orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const longTermOrdersDetails2 = await getLongTermOrdersDetails();

      await verifyOrderDetails(
        1,
        getOrderExpiryBlock(orderIntervalB, orderPlacementBlockB),
        salesRateB,
        anAddress1.address,
        1,
        0
      );
      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('999999009411580506'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, fp(0));
      verifyLongTermOrdersDetails(
        longTermOrdersDetails2,
        balanceA,
        balanceB,
        2,
        orderPlacementBlockB,
        orderBlockInterval
      );
    });

    it('can place long term order and execute', async () => {
      let balanceA, balanceB;
      const amount = fp(100),
        nInterval = 1000,
        ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        amount,
        nInterval,
        ammBalances
      );

      await moveForwardNBlocks(2 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock(ammBalances);

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        amount,
        fp(0),
        orderPlacementBlockA,
        orderPlacementBlockA + 1 + 2 * orderBlockInterval
      );

      // const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      // const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();

      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('200995963815502579716'));
      // verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);
    });

    it('can place long term order in both direction of same interval and execute', async () => {
      let balanceA, balanceB;

      const amount = fp(100),
        nInterval = 1000,
        ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        amount,
        nInterval,
        ammBalances
      );

      const [orderPlacementBlockB, salesRateB] = await placeLongTermOrder(
        anAddress.address,
        1,
        0,
        amount,
        nInterval,
        ammBalances
      );

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        amount,
        fp(0),
        orderPlacementBlockA,
        orderPlacementBlockA + 1
      );

      balanceB = balanceB.add(amount);
      let [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      await moveForwardNBlocks(2 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock(ammBalances);

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        salesRateB,
        balanceA,
        balanceB,
        orderPlacementBlockB,
        orderPlacementBlockB + 2 * orderBlockInterval + 1
      );

      [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      // const orderPoolDetailsA = await longTermOrders.getLongTermOrder(0);
      // const orderPoolDetailsB = await longTermOrders.getLongTermOrder(1);

      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('201999959178428795856'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('201000040721681221460'));
    });

    it('can place long term order in both direction of diff sale rate and execute', async () => {
      let balanceA, balanceB;

      const orderIntervalA = 1000,
        orderAmountA = fp(100),
        ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        orderAmountA,
        orderIntervalA,
        ammBalances
      );

      const orderIntervalB = 500,
        orderAmountB = fp(200);

      const [orderPlacementBlockB, salesRateB] = await placeLongTermOrder(
        anAddress.address,
        1,
        0,
        orderAmountB,
        orderIntervalB,
        ammBalances
      );

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        orderAmountA,
        fp(0),
        orderPlacementBlockA,
        orderPlacementBlockA + 1
      );

      balanceB = balanceB.add(orderAmountB);
      let [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      await moveForwardNBlocks(2 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock(ammBalances);

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        salesRateB,
        balanceA,
        balanceB,
        orderPlacementBlockB,
        orderPlacementBlockB + 2 * orderBlockInterval + 1
      );

      [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      // const orderPoolDetailsA = await longTermOrders.getLongTermOrder(0);
      // const orderPoolDetailsB = await longTermOrders.getLongTermOrder(1);

      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('202012053981096173406'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('200987947148768005531'));
    });

    it('can place long term order in both direction, execute and cancel first order', async () => {
      let balanceA, balanceB;
      const orderIntervalA = 1000,
        orderAmountA = fp(100),
        ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        orderAmountA,
        orderIntervalA,
        ammBalances
      );

      const orderIntervalB = 500,
        orderAmountB = fp(200);

      const [orderPlacementBlockB, salesRateB] = await placeLongTermOrder(
        anAddress.address,
        1,
        0,
        orderAmountB,
        orderIntervalB,
        ammBalances
      );

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        orderAmountA,
        fp(0),
        orderPlacementBlockA,
        orderPlacementBlockA + 1
      );

      balanceB = balanceB.add(orderAmountB);
      let [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      await moveForwardNBlocks(2 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock(ammBalances);

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        salesRateB,
        balanceA,
        balanceB,
        orderPlacementBlockB,
        orderPlacementBlockB + 2 * orderBlockInterval + 1
      );

      [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      // let orderPoolDetailsA = await longTermOrders.getLongTermOrder(0);
      // let orderPoolDetailsB = await longTermOrders.getLongTermOrder(1);

      // verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('202012053981096173406'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('200987947148768005531'));

      await longTermOrders.cancelLongTermSwap(anAddress.address, 0, ammBalances);

      [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();
      // TODO subtract withdrawn balance from the balances before matching
      // verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      // orderPoolDetailsA = await longTermOrders.getLongTermOrder(0);
      // orderPoolDetailsB = await longTermOrders.getLongTermOrder(1);

      // verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('202012053981096173406'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('200987947148768005531'));
    });

    it('can place long term order in one direction, execute and withdraw order', async () => {
      const orderInterval = 3,
        orderAmount = fp(100),
        ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];

      const [orderPlacementBlock, salesRate] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        orderAmount,
        orderInterval,
        ammBalances
      );

      await moveForwardNBlocks(4 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

      const [, , balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRate,
        fp(0),
        orderAmount,
        fp(0),
        orderPlacementBlock,
        getOrderExpiryBlock(orderInterval, orderPlacementBlock)
      );

      // let orderPoolDetailsA = (await longTermOrders.getLongTermOrderAndBoughtAmount(0))[0];
      // let orderPoolDetailsB = (await longTermOrders.getLongTermOrderAndBoughtAmount(1))[0];
      let [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();

      // verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('391089108910891089108'));
      // verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 0, ammBalances);

      // orderPoolDetailsA = (await longTermOrders.getLongTermOrderAndBoughtAmount(0))[0];
      // orderPoolDetailsB = (await longTermOrders.getLongTermOrderAndBoughtAmount(1))[0];
      [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();

      // verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('391089108910891089108'));
      // verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, bn(1));
    });

    it('can place long term order in both direction, execute and partially withdraw first order', async () => {
      const orderIntervalA = 3,
        orderIntervalB = 500,
        orderAmountA = fp(100),
        orderAmountB = fp(200);
      const ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];
      let balanceA, balanceB;

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        orderAmountA,
        orderIntervalA,
        ammBalances
      );

      const [orderPlacementBlockB, salesRateB] = await placeLongTermOrder(
        anAddress.address,
        1,
        0,
        orderAmountB,
        orderIntervalB,
        ammBalances
      );

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        orderAmountA,
        fp(0),
        orderPlacementBlockA,
        orderPlacementBlockA + 1
      );

      balanceB = balanceB.add(orderAmountB);

      const currentExecBlockNumber = await moveForwardNBlocks(2 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock(ammBalances);
      const [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        salesRateB,
        balanceA,
        balanceB,
        orderPlacementBlockB,
        orderPlacementBlockB + 2 * orderBlockInterval + 1
      );

      verifyTokenBalances([tokenBalanceA, tokenBalanceB], balanceA, balanceB);

      await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 0, ammBalances);

      // Long term order is withdrawn now
      // TODO fix this
      // const orderDetails = await longTermOrders.getLongTermOrder(0);

      // expect(orderDetails[0]).to.be.equal(0);
    });

    it('can place long term order in both direction, execute and withdraw first order', async () => {
      const orderIntervalA = 3,
        orderIntervalB = 500,
        orderAmountA = fp(100),
        orderAmountB = fp(200);
      const ammBalances: [BigNumber, BigNumber] = [fp(10000), fp(10000)];
      let balanceA, balanceB;

      const [orderPlacementBlockA, salesRateA] = await placeLongTermOrder(
        anAddress.address,
        0,
        1,
        orderAmountA,
        orderIntervalA,
        ammBalances
      );

      const [orderPlacementBlockB, salesRateB] = await placeLongTermOrder(
        anAddress.address,
        1,
        0,
        orderAmountB,
        orderIntervalB,
        ammBalances
      );

      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        fp(0),
        orderAmountA,
        fp(0),
        orderPlacementBlockA,
        orderPlacementBlockA + 1
      );

      balanceB = balanceB.add(orderAmountB);

      const currentExecBlockNumber = await moveForwardNBlocks(4 * orderBlockInterval);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock(ammBalances);
      [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders(
        ammBalances[0],
        ammBalances[1],
        salesRateA,
        salesRateB,
        balanceA,
        balanceB,
        orderPlacementBlockB,
        getOrderExpiryBlock(orderIntervalA, orderPlacementBlockA)
      );

      // [ammBalances[0], ammBalances[1], balanceA, balanceB] = executeVirtualOrders1(
      //   ammBalances[0],
      //   ammBalances[1],
      //   fp(0),
      //   salesRateB,
      //   balanceA,
      //   balanceB,
      //   getOrderExpiryBlock(orderIntervalA, orderPlacementBlockA),
      //   currentExecBlockNumber,
      //   orderBlockInterval
      // );

      // let orderPoolDetailsA = (await longTermOrders.getLongTermOrderAndBoughtAmount(0))[0];
      // let orderPoolDetailsB = (await longTermOrders.getLongTermOrderAndBoughtAmount(1))[0];
      let [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();

      // verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('391150274317278982266'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('405038774564188060935'));
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], bn('1616897557000407300'), bn('297424608915063606936'));

      await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 0, ammBalances);
      // const orderDetails = await longTermOrders.getLongTermOrder(0);

      // orderPoolDetailsA = (await longTermOrders.getLongTermOrderAndBoughtAmount(0))[0];
      // orderPoolDetailsB = (await longTermOrders.getLongTermOrderAndBoughtAmount(1))[0];
      [tokenBalanceA, tokenBalanceB, , ,] = await getLongTermOrdersDetails();

      // verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('391150274317278982266'));
      // verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('405038774564188060935'));
      // TODO fix this
      verifyTokenBalances([tokenBalanceA, tokenBalanceB], bn('1620968764021656669'), bn('198395113479849092775'));
    });
  });
});
