import { ethers } from 'hardhat';
import { expect } from 'chai';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';

import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { deploy } from '@balancer-labs/v2-helpers/src/contract';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';

import { itBehavesAsWeightedPool } from './BaseWeightedPool.behavior';

import { range } from 'lodash';
import { Contract } from 'ethers';

async function moveForwardNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

// TODO(codesherpa): Add real tests. Current tests are duplicate of WeightedPool tests
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
        };
        pool = await WeightedPool.create(params);
        await longTermOrdersContract.transferOwnership(pool.address);
      });

      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            sender = owner;

            tokens = allTokens.subset(2);
            await tokens.approve({ from: owner, to: await pool.getVault() });

            await pool.init({ from: owner, initialBalances });
            await tokens.approve({ from: other, to: await pool.getVault() });
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

            expectEvent.inIndirectReceipt(
              placeResult.receipt,
              pool.instance.interface,
              "LongTermOrderPlaced",
              {
                orderId: 0,
                sellTokenIndex: 0,
                buyTokenIndex: 1,
                owner: other.address
              }
            );

            // Move forward 80 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 5; j++) {
              await moveForwardNBlocks(20);
              const result = await pool.swapGivenIn({ in: 0, out: 1, amount: fp(0.1) });
            }

            // Move forward to end of expiry block of the long term order.
            await moveForwardNBlocks(20);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.95));
          });

          it('can cancel one-way Long Term Order', async () => {
            await tokens.approve({ from: other, to: await pool.getVault() });
            const longTermOrder = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            // Move forward 40 blocks with one swap after every 10 blocks.
            for (let j = 0; j < 5; j++) {
              await moveForwardNBlocks(10);
              const result = await pool.swapGivenIn({ in: 0, out: 1, amount: fp(0.1) });
            }

            // Move forward to mid of the long term order duration. I.e., t+50 blocks.
            await moveForwardNBlocks(10);

            const cancelResult = await pool.cancelLongTermOrder({ orderId: 0, from: other });
            expectEvent.inIndirectReceipt(
              cancelResult.receipt,
              pool.instance.interface,
              "LongTermOrderCancelled",
              {
                orderId: 0,
                sellTokenIndex: 0,
                buyTokenIndex: 1,
                owner: other.address,
                proceeds: cancelResult.amountsOut[1],
                unsoldAmount: cancelResult.amountsOut[0]
              }
            );

            expect(cancelResult.amountsOut[0]).to.be.gte(fp(0.33));
            expect(cancelResult.amountsOut[1]).to.be.lte(fp(2.7));
          });

          it('can execute two-way Long Term Order', async () => {
            await tokens.approve({ from: other, to: await pool.getVault() });
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

            // Move forward 80 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 5; j++) {
              await moveForwardNBlocks(20);
              await pool.swapGivenIn({ in: 0, out: 1, amount: fp(0.1) });
            }

            // Move forward to end of expiry block of the long term order.
            await moveForwardNBlocks(20);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            expectEvent.inIndirectReceipt(
              withdrawResult.receipt,
              pool.instance.interface,
              "LongTermOrderWithdrawn",
              {
                orderId: 0,
                sellTokenIndex: 0,
                buyTokenIndex: 1,
                owner: other.address,
                proceeds: withdrawResult.amountsOut[1]
              }
            );

            const withdrawResult1 = await pool.withdrawLongTermOrder({ orderId: 1, from: other });

            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.95));

            expect(withdrawResult1.amountsOut[0]).to.be.gte(fp(0.05));
            expect(withdrawResult1.amountsOut[1]).to.be.equal(fp(0));
          });

          it('can complete one-way Long Term Order and withdraw pool owner can withdraw fees', async () => {
            await tokens.approve({ from: other, to: await pool.getVault() });

            await pool.setLongTermSwapFeePercentage(owner, {
              newLongTermSwapFeePercentage: fp(1),
              newLongTermSwapFeeUserCutPercentage: fp(0.5),
            });

            const longTermOrder1 = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            // Move forward 80 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 5; j++) {
              await moveForwardNBlocks(20);
              await pool.swapGivenIn({ in: 0, out: 1, amount: fp(0.1) });
            }

            // Move forward to end of expiry block of the long term order.
            await moveForwardNBlocks(20);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            await pool.withdrawLongTermOrderCollectedManagementFees(owner, { recipient: owner });

            pool.instance.once('LongTermOrderManagementFeesCollected', (tokens, collectedFees, event) => {
              // TODO fix this to proper calculated fees
              const someFees = [1, 2];
              expect(collectedFees).to.be.eq(someFees);
            });

            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.95));
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
});
