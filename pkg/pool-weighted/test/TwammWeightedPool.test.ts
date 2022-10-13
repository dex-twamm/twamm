import { ethers, testUtils } from 'hardhat';
import { expect } from 'chai';
import { bn, fp, fromFp, toFp } from '@balancer-labs/v2-helpers/src/numbers';
import { BigNumber } from 'ethers';

import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';

import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import { lastBlockNumber } from '@balancer-labs/v2-helpers/src/time';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

import { itBehavesAsWeightedPool } from './BaseWeightedPool.behavior';

import { range } from 'lodash';
import { Contract } from 'ethers';
import { time } from 'console';

const { block } = testUtils;

async function moveForwardNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

async function swap(
  pool: WeightedPool,
  tokenInIndex: number,
  tokenOutIndex: number,
  amountIn: BigNumber,
  sender: SignerWithAddress,
  recipient: SignerWithAddress
) {
  const kind = 0; // GivenIn

  const tokens = (await pool.getTokens()).tokens;

  const swapTx = await pool.vault.instance.connect(sender).swap(
    {
      poolId: await pool.getPoolId(),
      kind: kind,
      assetIn: tokens[tokenInIndex],
      assetOut: tokens[tokenOutIndex],
      amount: amountIn,
      userData: '0x',
    },
    {
      sender: sender.address,
      fromInternalBalance: false,
      recipient: recipient.address,
      toInternalBalance: false,
    },
    0,
    MAX_UINT256
  );

  const receipt = await swapTx.wait();

  // Uncomment for gas measurement.
  // console.log('swap: ', receipt.cumulativeGasUsed.toString());

  return receipt;
}

async function estimateSpotPrice(pool: WeightedPool, longTermOrdersContract: Contract) {
  const fpBalances = await pool.getBalances();
  const adjustedBalances = [];

  const longTermOrdersStruct = await longTermOrdersContract.longTermOrders();
  // console.log(longTermOrdersStruct);
  adjustedBalances[0] = fpBalances[0].sub(longTermOrdersStruct.balanceA);
  adjustedBalances[1] = fpBalances[1].sub(longTermOrdersStruct.balanceB);

  const fpWeights = pool.weights;
  const numerator = fromFp(adjustedBalances[0]).div(fromFp(fpWeights[0]));
  const denominator = fromFp(adjustedBalances[1]).div(fromFp(fpWeights[1]));
  return bn(toFp(numerator.div(denominator)).toFixed(0));
}

async function doShortSwapsUntil(
  blockNumber: number,
  pool: WeightedPool,
  owner: SignerWithAddress,
  other: SignerWithAddress
) {
  let i = 0;
  // Move forward beyond expiry block with one swap after every 20 blocks.
  while ((await lastBlockNumber()) < blockNumber) {
    await moveForwardNBlocks(4);
    if (i % 2) {
      await swap(pool, 0, 1, fp(0.01), owner, other);
    } else {
      await swap(pool, 1, 0, fp(0.04), owner, other);
    }
    i++;
  }
}

function expectBalanceToBeApprox(actualBalance: BigNumber, expectedBalance: BigNumber) {
  // Expect both balances to be within 1e-3 of expected values.
  expect(actualBalance).to.be.lt(expectedBalance.add(1e15));
  expect(actualBalance).to.be.gt(expectedBalance.sub(1e15));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TwammWeightedPool', function () {
  describe('long term order tests', () => {
    let owner: SignerWithAddress, other: SignerWithAddress;

    before('setup signers', async () => {
      [, owner, other] = await ethers.getSigners();
    });

    const MAX_TOKENS = 2;

    let allTokens: TokenList, tokens: TokenList;

    let sender: SignerWithAddress;
    let pool: WeightedPool;
    const weights = [fp(0.5), fp(0.5)];
    // 1 token A = 4 token B
    const initialBalances = [fp(100.0), fp(400.0)];

    let longTermOrdersContract: Contract;

    sharedBeforeEach('deploy tokens', async () => {
      allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
      tokens = allTokens.subset(2);
      await tokens.mint({ to: [owner, other], amount: fp(100000.0) });
    });

    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        longTermOrdersContract = await deploy('LongTermOrders', { args: [10] });

        const params = {
          tokens,
          weights,
          owner: owner.address,
          poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
          swapEnabledOnStart: true,
          longTermOrdersContract: longTermOrdersContract.address,
          fromFactory: true,
        };
        pool = await WeightedPool.create(params);
        await longTermOrdersContract.transferOwnership(pool.address);
      });

      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            sender = owner;

            tokens = allTokens.subset(2);
            await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, other] });

            await pool.init({ from: owner, initialBalances });
          });

          it('can get long term order contract address', async () => {
            const longTermOrdersContractAddress = await pool.getLongTermOrderContractAddress();
            expect(longTermOrdersContractAddress).to.be.equal(longTermOrdersContract.address);
          });

          it('can execute one-way Long Term Order', async () => {
            await tokens.approve({ from: other, to: await pool.getVault() });

            const placeResult = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            const startingBlock = await lastBlockNumber();
            const expectedExpiryBlock =
              startingBlock % 10 ? startingBlock + 100 + (10 - (startingBlock % 10)) : startingBlock + 100;

            expectEvent.inIndirectReceipt(placeResult.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              expirationBlock: expectedExpiryBlock,
            });

            await doShortSwapsUntil(expectedExpiryBlock, pool, owner, other);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.96));
          });

          it('can cancel one-way Long Term Order', async () => {
            await tokens.approve({ from: other, amount: MAX_UINT256, to: await pool.getVault() });
            const longTermOrder = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            const startingBlock = await lastBlockNumber();
            const expectedExpiryBlock =
              startingBlock % 10 ? startingBlock + 100 + (10 - (startingBlock % 10)) : startingBlock + 100;

            expectEvent.inIndirectReceipt(longTermOrder.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              expirationBlock: expectedExpiryBlock,
            });

            const midpointBlock = startingBlock + (expectedExpiryBlock - startingBlock) / 2;

            // Move to mid point block - 1.
            await doShortSwapsUntil(midpointBlock - 4, pool, owner, other);
            await moveForwardNBlocks(midpointBlock - (await lastBlockNumber()) - 1);

            const cancelResult = await pool.cancelLongTermOrder({ orderId: 0, from: other });
            expectEvent.inIndirectReceipt(cancelResult.receipt, pool.instance.interface, 'LongTermOrderCancelled', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              proceeds: cancelResult.amountsOut[1],
              unsoldAmount: cancelResult.amountsOut[0],
            });

            expectBalanceToBeApprox(cancelResult.amountsOut[0], fp(0.5));
            // expect(cancelResult.amountsOut[0]).to.be.eq(fp(0.5));
            expect(cancelResult.amountsOut[1]).to.be.lte(fp(2));
          });

          it('can execute two-way Long Term Order', async () => {
            await tokens.approve({ from: other, amount: MAX_UINT256, to: await pool.getVault() });
            const longTermOrder1 = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });
            const longTermOrder2 = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(0.2),
              tokenInIndex: 1,
              tokenOutIndex: 0,
              numberOfBlockIntervals: 10,
            });

            const startingBlock2 = await lastBlockNumber();
            const expectedExpiryBlock2 =
              startingBlock2 % 10 ? startingBlock2 + 100 + (10 - (startingBlock2 % 10)) : startingBlock2 + 100;

            await doShortSwapsUntil(expectedExpiryBlock2, pool, owner, other);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            expectEvent.inIndirectReceipt(withdrawResult.receipt, pool.instance.interface, 'LongTermOrderWithdrawn', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              proceeds: withdrawResult.amountsOut[1],
            });

            const withdrawResult1 = await pool.withdrawLongTermOrder({ orderId: 1, from: other });

            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.96));

            expect(withdrawResult1.amountsOut[0]).to.be.gte(fp(0.05));
            expect(withdrawResult1.amountsOut[1]).to.be.equal(fp(0));
          });

          it('can complete one-way Long Term Order and withdraw pool owner can withdraw fees', async () => {
            await tokens.approve({ from: other, amount: MAX_UINT256, to: await pool.getVault() });

            await pool.setLongTermSwapFeePercentage(owner, {
              newLongTermSwapFeePercentage: fp(0.01),
              newLongTermSwapFeeUserCutPercentage: fp(0.5),
            });

            await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            const startingBlock = await lastBlockNumber();
            const expectedExpiryBlock =
              startingBlock % 10 ? startingBlock + 100 + (10 - (startingBlock % 10)) : startingBlock + 100;

            await doShortSwapsUntil(expectedExpiryBlock, pool, owner, other);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            // 3.96 - 1% fee = 3.92
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.92));

            await pool.withdrawLongTermOrderCollectedManagementFees(owner, owner);

            pool.instance.once('LongTermOrderManagementFeesCollected', (tokens, collectedFees, event) => {
              expect(collectedFees[0]).to.be.eq(fp(0));
              expectBalanceToBeApprox(collectedFees[1], fp(0.0198));
            });
          });
        });
      });
    });
  });

  describe('BaseWeightedPool tests', function () {
    context('for a 2 token pool', () => {
      // Should behave as basic weighted pool if no long term orders are placed.
      itBehavesAsWeightedPool(2, WeightedPoolType.TWAMM_WEIGHTED_POOL);
    });
  });

  describe('End to End tests', () => {
    let owner: SignerWithAddress, alice: SignerWithAddress, betty: SignerWithAddress, carl: SignerWithAddress;

    before('setup signers', async () => {
      await ethers.provider.send('hardhat_reset', []);
      [owner, alice, betty, carl] = await ethers.getSigners();
    });

    const MAX_TOKENS = 2;

    let allTokens: TokenList, tokens: TokenList;

    let sender: SignerWithAddress;
    let pool: WeightedPool;
    const weights = [fp(0.5), fp(0.5)];
    // 200k DAI, 100 ETH
    const initialBalances = [fp(200000.0), fp(100.0)];

    let longTermOrdersContract: Contract;

    sharedBeforeEach('deploy tokens', async () => {
      allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
      tokens = allTokens.subset(2);
      await tokens.mint({ to: [owner, alice, betty, carl], amount: fp(300000.0) });
    });

    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        // Order block interval = 10
        longTermOrdersContract = await deploy('LongTermOrders', { args: [5] });

        const params = {
          tokens,
          weights,
          owner: owner.address,
          poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
          swapEnabledOnStart: true,
          longTermOrdersContract: longTermOrdersContract.address,
          fromFactory: true,
        };
        pool = await WeightedPool.create(params);
        await longTermOrdersContract.transferOwnership(pool.address);
      });

      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            sender = owner;

            tokens = allTokens.subset(2);
            await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, alice, betty, carl] });

            await pool.init({ from: owner, initialBalances });
          });

          it('can execute one-way Long Term Order', async () => {
            await block.setAutomine(false);
            await block.setIntervalMining(0);

            await block.advanceTo(99);

            // BLOCK 100 //////////////////////////////////////////////////////////////////////
            // Alice puts in an order to buy 1,000 DAI worth of ETH over the next 100 blocks
            const tx1 = pool.placeLongTermOrder({
              from: alice,
              amountIn: fp(1000.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 20, // 20*5 = 100 blocks
            });

            // Betty puts in an order to buy 2,000 DAI worth of ETH over the next 50 blocks
            pool.placeLongTermOrder({
              from: betty,
              amountIn: fp(2000.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });
            //////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(124);

            expectEvent.inIndirectReceipt((await tx1).receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: alice.address,
              expirationBlock: 200,
            });

            // BLOCK 125 //////////////////////////////////////////////////////////////////////
            swap(pool, 1, 0, fp(0.62423925741878552), owner, owner);
            pool.placeLongTermOrder({
              from: carl,
              amountIn: fp(2.0),
              tokenInIndex: 1,
              tokenOutIndex: 0,
              numberOfBlockIntervals: 20,
            });
            //////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(125);

            // Spot price = fp(2000)
            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            let lto0 = await longTermOrdersContract.getLongTermOrder(0);
            const lto1 = await longTermOrdersContract.getLongTermOrder(1);

            expectBalanceToBeApprox(lto0[6], fp(0.124));
            expectBalanceToBeApprox(lto1[6], fp(0.497));

            await block.advanceTo(149);

            // BLOCK 150 //////////////////////////////////////////////////////////////////////
            swap(pool, 1, 0, fp(0.12484657552742167), owner, owner);
            const withdrawTx1 = pool.withdrawLongTermOrder({ orderId: 1, from: betty });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(150);

            // Spot price = fp(2000)
            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            lto0 = await longTermOrdersContract.getLongTermOrder(0);
            let lto2 = await longTermOrdersContract.getLongTermOrder(2);

            expectBalanceToBeApprox(lto0[6], fp(0.249));
            expect((await withdrawTx1).amountsOut[0]).to.be.equal(0);
            expectBalanceToBeApprox((await withdrawTx1).amountsOut[1], fp(0.996));
            expectBalanceToBeApprox(lto2[6], fp(1001.246));

            await block.advanceTo(199);

            // BLOCK 200 //////////////////////////////////////////////////////////////////////
            swap(pool, 0, 1, fp(1492.59995191032122), owner, owner);
            const withdrawTx0 = pool.withdrawLongTermOrder({ orderId: 0, from: alice });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(200);

            // Spot price = fp(2000)
            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            expect((await withdrawTx0).amountsOut[0]).to.be.equal(0);
            expectBalanceToBeApprox((await withdrawTx0).amountsOut[1], fp(0.501));
            lto2 = await longTermOrdersContract.getLongTermOrder(2);
            expectBalanceToBeApprox(lto2[6], fp(2986.383));

            await block.advanceTo(224);

            // BLOCK 225 //////////////////////////////////////////////////////////////////////
            swap(pool, 0, 1, fp(1000.02525), owner, owner);
            const withdrawTx2 = pool.withdrawLongTermOrder({ orderId: 2, from: carl });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(225);

            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            expect((await withdrawTx2).amountsOut[1]).to.be.equal(0);
            expectBalanceToBeApprox((await withdrawTx2).amountsOut[0], fp(3981.408));

            await block.setAutomine(true);
          });
        });
      });
    });
  });
});
