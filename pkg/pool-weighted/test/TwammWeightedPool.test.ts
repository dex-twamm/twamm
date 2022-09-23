import { ethers } from 'hardhat';
import { expect } from 'chai';
import { fp, decimal } from '@balancer-labs/v2-helpers/src/numbers';
import { BigNumber } from 'ethers';

import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';

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

async function swap(
  pool: WeightedPool, tokenInIndex: number, tokenOutIndex: number, amountIn: BigNumber,
  sender: SignerWithAddress, recipient: SignerWithAddress) {
  const kind = 0; // GivenIn

  let tokens = (await pool.getTokens()).tokens;

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
  console.log('swap: ', receipt.cumulativeGasUsed.toString());
}

function expectBalanceToBeApprox(actualBalance: BigNumber, expectedBalance: BigNumber) {
  // Expect both balances to be within 1e-15 of expected values.
  expect(actualBalance).to.be.lt(expectedBalance.add(1000));
  expect(actualBalance).to.be.gt(expectedBalance.sub(1000));
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
          fromFactory: true
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

            expectEvent.inIndirectReceipt(placeResult.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
            });

            // Move forward 100 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 6; j++) {
              await moveForwardNBlocks(20);
              await swap(pool, 0, 1, fp(0.1), owner, other);
            }

            // Move forward beyond expiry block of the long term order.
            await moveForwardNBlocks(20);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.94));
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

            expectEvent.inIndirectReceipt(longTermOrder.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
            });

            // Move forward 40 blocks with one swap after every 10 blocks.
            // Total blocks moved forward 40 + 5(swap transactions) = 45.
            for (let j = 0; j < 4; j++) {
              await moveForwardNBlocks(10);
              await swap(pool, 0, 1, fp(0.01), owner, other);
            }

            // Order placed at block 22, expiry block 130.
            // Move forward to mid of the long term order duration. I.e., t+54 blocks.
            await moveForwardNBlocks(9);

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
            let longTermOrder2 = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(0.2),
              tokenInIndex: 1,
              tokenOutIndex: 0,
              numberOfBlockIntervals: 10,
            });

            // Move forward 80 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 5; j++) {
              await moveForwardNBlocks(20);
              await swap(pool, 0, 1, fp(0.1), owner, other);
            }

            // Move forward to end of expiry block of the long term order.
            await moveForwardNBlocks(20);

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
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.94));

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

            // Move forward 80 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 5; j++) {
              await moveForwardNBlocks(20);
              await swap(pool, 0, 1, fp(0.1), owner, other);
            }

            // Move forward to end of expiry block of the long term order.
            await moveForwardNBlocks(20);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            await pool.withdrawLongTermOrderCollectedManagementFees(owner, owner);

            pool.instance.once('LongTermOrderManagementFeesCollected', (tokens, collectedFees, event) => {
              // TODO fix this to proper calculated fees
              const someFees = [1, 2];
              // expect(collectedFees).to.be.eq(someFees);
            });

            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.90));
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
