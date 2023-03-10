import { ethers } from 'hardhat';

import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { fp, fromFp } from '@balancer-labs/v2-helpers/src/numbers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import VaultDeployer from '@balancer-labs/v2-helpers/src/models/vault/VaultDeployer';
import TypesConverter from '@balancer-labs/v2-helpers/src/models/types/TypesConverter';
import fc from 'fast-check';
import { TwammModel } from './model/TwammModel';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import { deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';
import {
  allTwammCommands,
  JoinGivenInCommand,
  MoveFwdNBlocksCommand,
  PlaceLtoCommand,
  WithdrawLtoManagementFeeCommand,
} from './model/TwammCommands';
fc.configureGlobal({
  numRuns: 100,
  interruptAfterTimeLimit: 195 * 1000,
  markInterruptAsFailure: true,
});

describe('TwammWeightedPool FastCheck tests', function () {
  let owner: SignerWithAddress, alice: SignerWithAddress, betty: SignerWithAddress, carl: SignerWithAddress;

  beforeEach('setup signers', async () => {
    [owner, alice, betty, carl] = await ethers.getSigners();
  });

  const MAX_TOKENS = 2;
  let allTokens: TokenList, tokens: TokenList;

  let pool: WeightedPool;
  const weights = [fp(0.5), fp(0.5)];
  // 200k DAI, 100 ETH
  const initialBalances = [fp(100.0), fp(400.0)];

  sharedBeforeEach('common setup for fast-check tests', async () => {
    allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
    const params = {
      owner: owner.address,
      fromFactory: true,
      from: owner,
    };
    await VaultDeployer.deploy(TypesConverter.toRawVaultDeployment(params));
  });

  context('twamm tests', () => {
    async function initialize() {
      try {
        tokens = allTokens.subset(2);
        await tokens.mint({ to: [owner, alice, betty, carl], amount: fp(600000.0) });

        const params = {
          tokens,
          weights,
          owner: owner.address,
          poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
          swapEnabledOnStart: true,
          orderBlockInterval: 100,
          fromFactory: true,
          from: owner,
        };
        pool = await WeightedPool.create(params);
        await deployedAt('LongTermOrders', await pool.getLongTermOrderContractAddress());

        tokens = allTokens.subset(2);
        await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, alice, betty, carl] });
        await pool.init({ from: owner, initialBalances });

        // Set Long Term Order fee.
        await pool.instance.setLongTermSwapFeePercentage(fp(0.0025));
        await pool.vault.setSwapFeePercentage(fp(0.5));
      } catch (error) {
        console.log(error);
        throw error;
      }

      return {
        pool: pool,
        wallet: alice,
      };
    }

    it('should test TwammPool', async () => {
      const WALLETS = [owner, alice, betty, carl];
      // run everything
      await fc.assert(
        fc
          .asyncProperty(
            fc.commands(allTwammCommands(WALLETS.length), {
              // replayPath: 'AABACB/E:VD',
            }),
            async (cmds) => {
              const ownerBalance = await pool.balanceOf(owner.address);
              const model = new TwammModel(WALLETS, 100, fromFp(ownerBalance));
              const real = {
                pool: pool,
                wallets: WALLETS,
              };
              await fc.asyncModelRun(() => ({ model, real }), cmds);
            }
          )
          .beforeEach(async () => {
            /* code executed before each call to predicate */
            try {
              await initialize();
            } catch (error) {
              console.log(error);
              throw error;
            }
          }),
        {
          verbose: true,
          // seed: -61385816,
          // path: '0:2:1:2:1:1:2:1:2:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1',
          // endOnFailure: true,
        }
      );
    });
  });
});
