import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract, BigNumber, BigNumberish } from 'ethers';
import { decimal, fp, bn } from '@balancer-labs/v2-helpers/src/numbers';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import { TwammWeightedPoolEncoder } from '@balancer-labs/balancer-js/src/pool-weighted/encoder';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { lastBlockNumber } from '@balancer-labs/v2-helpers/src/time';
import { Address } from 'cluster';

function verifyOrderDetails(
  orderDetails: [BigNumber, BigNumber, BigNumber, Address, BigNumber, BigNumber],
  orderId: number,
  expirationBlock: number,
  salesRate: BigNumber,
  owner: string,
  sellTokenIndex: number,
  buyTokenIndex: number
) {
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
  //   console.log('Pool details', decimal(orderPoolDetails[0]), decimal(orderPoolDetails[1]));
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
  //   console.log(
  //     decimal(longTermOrdersDetails[0]),
  //     decimal(longTermOrdersDetails[1]),
  //     decimal(longTermOrdersDetails[2]),
  //     decimal(longTermOrdersDetails[3]),
  //     decimal(longTermOrdersDetails[4])
  //   );
  expect(longTermOrdersDetails[0]).to.be.equal(balanceA);
  expect(longTermOrdersDetails[1]).to.be.equal(balanceB);
  expect(longTermOrdersDetails[2]).to.be.equal(orderId);
  expect(longTermOrdersDetails[3]).to.be.equal(lastVirtualOrderBlock);
  expect(longTermOrdersDetails[4]).to.be.equal(orderBlockInterval);
}

function verifyTokenBalances(tokenBalances: [BigNumber, BigNumber], balanceA: BigNumber, balanceB: BigNumber) {
  //   console.log('Token Balances', decimal(tokenBalances[0]), decimal(tokenBalances[1]));
  expect(tokenBalances[0]).to.be.equal(balanceA);
  expect(tokenBalances[1]).to.be.equal(balanceB);
}

async function moveForwardNBlocks(n: number): Promise<number> {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }

  return await lastBlockNumber();
}

describe('LongTermOrders', function () {
  let longTermOrders: Contract;
  let anAddress: SignerWithAddress, anAddress1: SignerWithAddress, anAddress2: SignerWithAddress;
  let blockNumber: number;

  const EXPECTED_RELATIVE_ERROR = 1e-14;
  const ORDER_BLOCK_INTERVAL = 100;

  function getSaleRate(amount: BigNumber, numberOfBlockIntervals: number, blockNumber: number): BigNumber {
    return amount.div(ORDER_BLOCK_INTERVAL * (numberOfBlockIntervals + 1) - (blockNumber % ORDER_BLOCK_INTERVAL));
  }

  describe('init', () => {
    before('setup', async function () {
      longTermOrders = await deploy('MockLongTermOrders');
      [, anAddress] = await ethers.getSigners();

      blockNumber = await lastBlockNumber();
      await longTermOrders.initialize(blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('initialize long term orders library', async () => {
      const lastVirtualOrderBlock = await longTermOrders.getLastVirtualOrderBlock();
      const orderBlockInterval = await longTermOrders.getOrderBlockInterval();

      expect(lastVirtualOrderBlock).to.be.equal(blockNumber);
      expect(orderBlockInterval).to.be.equal(ORDER_BLOCK_INTERVAL);
    });
  });

  describe('place long term order', () => {
    async function placeLongTermOrder(
      address: string,
      tokenInIndex: number,
      tokenOutIndex: number,
      amount: BigNumber,
      numberOfBlockIntervals: number
    ): Promise<[number, BigNumber]> {
      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(
        tokenInIndex,
        tokenOutIndex,
        amount,
        numberOfBlockIntervals
      );
      await longTermOrders.performLongTermSwap(address, orderData);
      const lastBlock = await lastBlockNumber();

      return [lastBlock, getSaleRate(amount, numberOfBlockIntervals, lastBlock)];
    }

    sharedBeforeEach('setup', async function () {
      longTermOrders = await deploy('MockLongTermOrders');
      [, anAddress, anAddress1, anAddress2] = await ethers.getSigners();

      blockNumber = await lastBlockNumber();
      await longTermOrders.initialize(blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('can place long term order', async () => {
      const amount = fp(100);

      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, amount, 1000);

      const orderDetails = await longTermOrders.getOrderDetails(0);
      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderDetails(orderDetails, 0, 100100, salesRateA, anAddress.address, 0, 1);
      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, fp(0));
      verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, fp(100), fp(0), 1, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('can place long term order in both directions', async () => {
      const amount1 = fp(100),
        amount2 = fp(100);

      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, amount1, 1000);
      const [, salesRateB] = await placeLongTermOrder(anAddress1.address, 1, 0, amount2, 500);

      const orderDetails1 = await longTermOrders.getOrderDetails(0);
      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const longTermOrdersDetails1 = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderDetails(orderDetails1, 0, 100100, salesRateA, anAddress.address, 0, 1);
      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails1, amount1, amount2, 2, blockNumber, ORDER_BLOCK_INTERVAL);

      const orderDetails2 = await longTermOrders.getOrderDetails(1);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails2 = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderDetails(orderDetails2, 1, 50100, salesRateB, anAddress1.address, 1, 0);
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails2, amount1, amount2, 2, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('can place long term order and execute', async () => {
      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, fp(100), 1000);

      const currentExecBlockNumber = await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('202995883094633276320'));
      verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
      verifyTokenBalances(tokenBalances, bn('99797192666966382086'), bn('202803220035599308'));
    });

    it('can place long term order in both direction of same interval and execute', async () => {
      const amount = fp(100),
        nInterval = 1000;

      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, amount, nInterval);
      const [, salesRateB] = await placeLongTermOrder(anAddress.address, 1, 0, amount, nInterval);

      const currentExecBlockNumber = await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('203999999440537538095'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('204000000559470409300'));
      verifyTokenBalances(tokenBalances, bn('100000002036708803633'), bn('99999997963291209891'));
    });

    it('can place long term order in both direction of diff sale rate and execute', async () => {
      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, fp(100), 1000);
      const [, salesRateB] = await placeLongTermOrder(anAddress.address, 1, 0, fp(200), 500);

      const currentExecBlockNumber = await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('204012457946465326377'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('203987543329374243561'));
      verifyTokenBalances(tokenBalances, bn('100610612681539143706'), bn('199389350031399388218'));
    });

    it('can place long term order in both direction, execute and cancel first order', async () => {
      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, fp(100), 1000);
      const [, salesRateB] = await placeLongTermOrder(anAddress.address, 1, 0, fp(200), 500);

      const currentExecBlockNumber = await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

      let orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      let orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      let tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('204012457946465326377'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('203987543329374243561'));
      verifyTokenBalances(tokenBalances, bn('100610612681539143706'), bn('199389350031399388218'));

      await longTermOrders.cancelLongTermSwap(anAddress.address, 0);

      orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('204012457946465326377'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('203987543329374243561'));
      verifyTokenBalances(tokenBalances, bn('812420963671191572'), bn('199185531201341478057'));
    });

    // it('can place long term order in one direction, execute and withdraw order', async () => {
    //   await placeLongTermOrder(anAddress.address, 0, 1, fp(100), 3);

    //   const currentExecBlockNumber = await moveForwardNBlocks(4 * ORDER_BLOCK_INTERVAL);
    //   await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

    //   let orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
    //   let orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
    //   let tokenBalances = await longTermOrders.getTokenBalances();

    //   verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('393049602727022081856'));
    //   verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
    //   verifyTokenBalances(tokenBalances, bn('1122923248902847537'), bn('297908981364596278033'));

    //   await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 0);

    //   orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
    //   orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
    //   tokenBalances = await longTermOrders.getTokenBalances();

    //   verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('393049602727022081856'));
    //   verifyOrderPoolDetails(orderPoolDetailsB, fp(0), fp(0));
    //   verifyTokenBalances(tokenBalances, fp(0), fp(0));
    // });

    it('can place long term order in both direction, execute and withdraw first order', async () => {
      const [, salesRateA] = await placeLongTermOrder(anAddress.address, 0, 1, fp(100), 3);
      const [, salesRateB] = await placeLongTermOrder(anAddress.address, 1, 0, fp(200), 500);

      const currentExecBlockNumber = await moveForwardNBlocks(4 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);

      let orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      let orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      let tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('393111698492602697555'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('408078839317253156679'));
      verifyTokenBalances(tokenBalances, bn('1122923248902847537'), bn('297908981364596278033'));

      await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 0);

      orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      tokenBalances = await longTermOrders.getTokenBalances();

      verifyOrderPoolDetails(orderPoolDetailsA, fp(0), bn('393111698492602697555'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('408078839317253156679'));
      verifyTokenBalances(tokenBalances, bn('1122923248902847537'), bn('198387032379127240857'));
    });
  });
});
