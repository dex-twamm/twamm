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

      const orderDetails = await longTermOrders.getOrderDetails(0);
      const orderPoolDetails = await longTermOrders.getOrderPoolDetails(0);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      salesRateA = salesRateA.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));

      verifyOrderDetails(
        orderDetails,
        0,
        100100,
        getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement),
        anAddress.address,
        0,
        1
      );
      verifyOrderPoolDetails(orderPoolDetails, salesRateA, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, fp(100), fp(0), 1, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('place 2nd long term order', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 1000;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(0, 1, amount, numberOfBlockIntervals);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);
      const blockNumberAtOrderPlacement = await lastBlockNumber();

      const orderDetails = await longTermOrders.getOrderDetails(1);
      const orderPoolDetails = await longTermOrders.getOrderPoolDetails(0);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      salesRateA = salesRateA.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));

      verifyOrderDetails(
        orderDetails,
        1,
        100100,
        getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement),
        anAddress.address,
        0,
        1
      );
      verifyOrderPoolDetails(orderPoolDetails, salesRateA, fp(0));
      verifyLongTermOrdersDetails(longTermOrdersDetails, fp(200), fp(0), 2, blockNumber, ORDER_BLOCK_INTERVAL);
    });

    it('place 3rd long term order B to A', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 2000;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(1, 0, amount, numberOfBlockIntervals);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);
      const blockNumberAtOrderPlacement = await lastBlockNumber();

      const orderDetails = await longTermOrders.getOrderDetails(2);
      const orderPoolDetails = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      salesRateB = salesRateB.add(getSaleRate(amount, numberOfBlockIntervals, blockNumberAtOrderPlacement));

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
      await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);
      blockNumber = await lastBlockNumber();

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, bn('1998111784413634'), bn('204997081344557893990'));
      verifyOrderPoolDetails(orderPoolDetailsB, bn('499767608062251'), bn('205002921657893500619'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('200307159096002056504'),
        bn('100307154724352200000'),
        3,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );
    });

    it('Move forward 2 * order block intervals, cancel virtual orders', async () => {
      await moveForwardNBlocks(2 * ORDER_BLOCK_INTERVAL);
      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);
      blockNumber = await lastBlockNumber();
      await longTermOrders.cancelLongTermSwap(anAddress.address, 0);

      const orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      const orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      const longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, bn('999060882770196'), bn('405994301561489043830'));
      verifyOrderPoolDetails(orderPoolDetailsB, bn('499767608062251'), bn('406005704949977696154'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('300203709269283791250'),
        bn('101013925322518623497'),
        3,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );
    });

    it('Place short long term order for 3 interval blocks, move forward 4 * order block intervals, withdraw long term order', async () => {
      const amount = fp(100),
        numberOfBlockIntervals = 3;

      const orderData = TwammWeightedPoolEncoder.joinPlaceLongTermOrder(0, 1, amount, numberOfBlockIntervals);
      await longTermOrders.performLongTermSwap(anAddress.address, orderData);

      let orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      let orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      let longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, bn('258068469623130093'), bn('405994301561489043830'));
      verifyOrderPoolDetails(orderPoolDetailsB, bn('499767608062251'), bn('406005704949977696154'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('400203709269283791250'),
        bn('101013925322518623497'),
        4,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );

      await moveForwardNBlocks(4 * ORDER_BLOCK_INTERVAL);

      await longTermOrders.executeVirtualOrdersUntilCurrentBlock([fp(10000), fp(10000)]);
      blockNumber = await lastBlockNumber();
      await longTermOrders.withdrawProceedsFromLongTermSwap(anAddress.address, 3);

      orderPoolDetailsA = await longTermOrders.getOrderPoolDetails(0);
      orderPoolDetailsB = await longTermOrders.getOrderPoolDetails(1);
      longTermOrdersDetails = await longTermOrders.getLongTermOrdersDetails();

      verifyOrderPoolDetails(orderPoolDetailsA, bn('999060882770196'), bn('808010782443912624678'));
      verifyOrderPoolDetails(orderPoolDetailsB, bn('499767608062251'), bn('809992550848542578443'));

      verifyLongTermOrdersDetails(
        longTermOrdersDetails,
        bn('601179878137033336423'),
        bn('201475465970923873497'),
        4,
        blockNumber,
        ORDER_BLOCK_INTERVAL
      );
    });
  });
});
