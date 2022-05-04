import { ethers } from 'hardhat';
import { expect } from 'chai';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';

import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';

import { range } from 'lodash';

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
  const initialBalances = [fp(1.0), fp(4.0)];

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
    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens,
          weights,
          owner: owner.address,
          poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
          swapEnabledOnStart: true,
          orderBlockInterval: 1000,
          fromFactory: true,
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

          it('can accept Long Term Order', async () => {
            const balance = (await tokens.balanceOf(other))[0];
            await pool.placeLongTermOrder({ from: other, amountIn: balance, tokenInIndex: 0, tokenOutIndex: 1})
          });
        });
      });
        
    });
  });
});
