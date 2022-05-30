import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract, BigNumber } from 'ethers';
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
  //   console.log(decimal(orderPoolDetails[0]), decimal(orderPoolDetails[1]));
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

// function computeAmmEnd(aStart: BigNumber, bStart: BigNumber, aIn: BigNumber, bIn: BigNumber) {
//   const k = aStart.mul(bStart);
//   const c = ;
//   const endA =
// }

async function moveForwardNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

describe('LongTermOrders', function () {
  let longTermOrders: Contract;
  let anAddress: SignerWithAddress;
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
    let salesRateA: BigNumber = fp(0);
    let salesRateB: BigNumber = fp(0);
    let firstOrderSalesRate: BigNumber;

    before('setup', async function () {
      longTermOrders = await deploy('MockLongTermOrders');
      [, anAddress] = await ethers.getSigners();

      blockNumber = await lastBlockNumber();
      await longTermOrders.initialize(blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('place long term order', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 1000;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(0, 1, amount, 1000);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);
      const blockNumberAtOrderPlacement = await lastBlockNumber();
      console.log('blockNumberAtOrderPlacement', blockNumberAtOrderPlacement);

      const orderDetails = await longTermOrders.getOrderDetails(0);
      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      salesRateA = salesRateA.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));
      firstOrderSalesRate = salesRateA;
      console.log('salesRateA', decimal(salesRateA));

      verifyOrderDetails(
        orderDetails,
        0,
        100100,
        getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement),
        anAddress.address,
        0,
        1
      );
      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, fp(0));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, fp(100), fp(0), 1, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('place 2nd long term order', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 1000;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(0, 1, amount, numberOfBlockIntervals);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);
      const blockNumberAtOrderPlacement = await lastBlockNumber();
      console.log('blockNumberAtOrderPlacement', blockNumberAtOrderPlacement);

      const orderDetails = await longTermOrders.getOrderDetails(1);
      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      salesRateA = salesRateA.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));
      console.log('salesRateA', decimal(salesRateA));

      verifyOrderDetails(
        orderDetails,
        1,
        100100,
        getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement),
        anAddress.address,
        0,
        1
      );
      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, fp(0));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, fp(200), fp(0), 2, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('place 3rd long term order B to A', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 2000;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(1, 0, amount, numberOfBlockIntervals);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);
      const blockNumberAtOrderPlacement = await lastBlockNumber();
      console.log('blockNumberAtOrderPlacement', blockNumberAtOrderPlacement);

      const orderDetails = await longTermOrders.getOrderDetails(2);
      const orderPoolDetails = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      salesRateB = salesRateB.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));
      console.log('salesRateB', decimal(salesRateB));

      verifyOrderDetails(
        orderDetails,
        2,
        200100,
        getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement),
        anAddress.address,
        1,
        0
      );
      verifyOrderPoolDetails(orderPoolDetails, salesRateB, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, fp(200), fp(100), 3, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('Execute virtual orders, move forward 2 * order block intervals', async () => {
      console.log('executeVirtualOrdersUntilCurrentBlock');
      await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);
      blockNumber = await lastBlockNumber();
      console.log('Block Number', blockNumber);

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('204993702462721570573'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('205006300740401754432'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('200307157407246073909'),
        bn('100307147972968584701'),
        3,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );
    });

    it('Move forward 2 * order block intervals, cancel virtual orders', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 1000;

      console.log('executeVirtualOrdersUntilCurrentBlock');
      await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);
      blockNumber = await lastBlockNumber();
      console.log('Block Number', blockNumber);
      await longTermOrders.cancelLongTermSwap(anAddress.address, 0);
      salesRateA = salesRateA.sub(firstOrderSalesRate);

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('405987648072692566720'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('406012358829287036644'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('300204704994792087924'),
        bn('101013905380930270597'),
        3,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );
    });

    it('Place short long term order for 3 interval blocks, move forward 4 * order block intervals, withdraw long term order', async () => {
      console.log('executeVirtualOrdersUntilCurrentBlock');
      const amount = fp(100),
        numberOfBlockIntervals = 3;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(0, 1, amount, numberOfBlockIntervals);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);
      const blockNumberAtOrderPlacement = await lastBlockNumber();
      salesRateA = salesRateA.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));

      let orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      let orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      let longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('405987648072692566720'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('406012358829287036644'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('400204704994792087924'),
        bn('101013905380930270597'),
        4,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );

      await moveForwardNBlocks(4 * ORDER_BLOCK_INTERVAL);

      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);
      blockNumber = await lastBlockNumber();
      console.log('Block Number', blockNumber);
      await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 3);
      salesRateA = salesRateA.sub(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));

      orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, salesRateA, bn('804851121421325029714'));
      verifyOrderPoolDetails(orderPoolDetailsB, salesRateB, bn('813206197003992177555'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('600429936186922145552'),
        bn('200722961058084863350'),
        4,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );
    });
  });
});
