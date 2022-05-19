import { ethers } from 'hardhat';
import { expect } from 'chai';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';

import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';

import { range } from 'lodash';

async function moveForwardNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

// TODO(codesherpa): Add real tests. Current tests are duplicate of WeightedPool tests
describe('TwammWeightedPool', function () {
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

  sharedBeforeEach('deploy tokens', async () => {
    allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
    tokens = allTokens.subset(2);
    await tokens.mint({ to: [owner, other], amount: fp(100000.0) });
  });

  describe('weights and scaling factors', () => {
    for (const numTokens of range(2, MAX_TOKENS + 1)) {
      context(`with ${numTokens} tokens`, () => {
        let pool: WeightedPool;
        let tokens: TokenList;

        sharedBeforeEach('deploy pool', async () => {
          tokens = allTokens.subset(numTokens);

          pool = await WeightedPool.create({
            poolType: WeightedPoolType.LIQUIDITY_BOOTSTRAPPING_POOL,
            tokens,
            weights: weights.slice(0, numTokens),
          });
        });

        it('sets scaling factors', async () => {
          const poolScalingFactors = await pool.getScalingFactors();
          const tokenScalingFactors = tokens.map((token) => fp(10 ** (18 - token.decimals)));

          expect(poolScalingFactors).to.deep.equal(tokenScalingFactors);
        });
      });
    }
  });

  describe('with valid creation parameters', () => {
    let pool: WeightedPool;

    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens,
          weights,
          owner: owner.address,
          poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
          swapEnabledOnStart: true,
          orderBlockInterval: 10
        };
        pool = await WeightedPool.create(params);
      });

      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            sender = owner;

            tokens = allTokens.subset(2);
            await tokens.approve({ from: owner, to: await pool.getVault() });

            await pool.init({ from: owner, initialBalances });
          });

          it('can execute Long Term Order', async () => {
            await tokens.approve({ from: other, to: await pool.getVault() });
            let longTermOrder = await pool.placeLongTermOrder({ from: other, amountIn: fp(1.0), tokenInIndex: 0, tokenOutIndex: 1, numberOfBlockIntervals: 10});

            // Move forward 80 blocks with one swap after every 20 blocks.
            for (let j = 0; j < 4; j++) {
              await moveForwardNBlocks(20);
              var result = await pool.swapGivenIn({ in: 0, out: 1, amount: fp(0.1) });
            }

            // Move forward to end of expiry block of the long term order.
            await moveForwardNBlocks(20);

            var withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other});
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fp(3.9));

          });
        });
      });
    });
  });
});
