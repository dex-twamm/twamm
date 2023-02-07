import { BigNumber, Contract } from 'ethers';
import { ethers, testUtils } from 'hardhat';

import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { bn, fp, fromFp, toFp, decimal } from '@balancer-labs/v2-helpers/src/numbers';
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import VaultDeployer from '@balancer-labs/v2-helpers/src/models/vault/VaultDeployer';
import TypesConverter from '@balancer-labs/v2-helpers/src/models/types/TypesConverter';
import Vault from '@balancer-labs/v2-helpers/src/models/vault/Vault';
import fc from 'fast-check';
import { TwammModel } from './model/TwammModel';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import { deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';
import { allTwammCommands } from './model/TwammCommands';

fc.configureGlobal({
  numRuns: 100,
  interruptAfterTimeLimit: 195 * 1000,
  markInterruptAsFailure: true, });

describe('TwammWeightedPool Fast-check tests', function () {
  let owner: SignerWithAddress, alice: SignerWithAddress, betty: SignerWithAddress, carl: SignerWithAddress;

  beforeEach('setup signers', async () => {
    [owner, alice, betty, carl] = await ethers.getSigners();
  });

  const MAX_TOKENS = 2;
  let allTokens: TokenList, tokens: TokenList;

  let sender: SignerWithAddress;
  let pool: WeightedPool;
  const weights = [fp(0.5), fp(0.5)];
  // 200k DAI, 100 ETH
  const initialBalances = [fp(100.0), fp(400.0)];

  let longTermOrdersContract: Contract;

  let vault: Vault;

  sharedBeforeEach('common setup for fast-check tests', async () => {
    allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
    const params = {
      owner: owner.address,
      fromFactory: true,
      from: owner
    };
    vault = (await VaultDeployer.deploy(TypesConverter.toRawVaultDeployment(params)));
  });

  context('twamm tests', () => {
    let vault: Vault;

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
          vault: vault
        };
        pool = await WeightedPool.create(params);
        longTermOrdersContract = await deployedAt('LongTermOrders', await pool.getLongTermOrderContractAddress());
        sender = owner;

        tokens = allTokens.subset(2);
        await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, alice, betty, carl] });
        await pool.init({ from: owner, initialBalances });
      } catch (error) {
        console.log(error);
        throw error;
      }

      return {
        pool: pool,
        wallet: alice
      }
    };

    it('should test TwammPool', async () => {
      // run everything
      await fc.assert(
        fc.asyncProperty(fc.commands(allTwammCommands, {
          // replayPath: "BBDA/W:1"
        }), async (cmds) => {
          let model = new TwammModel(alice, 100);
          let real = {
            pool: pool,
            wallet: alice
          };
          await fc.asyncModelRun(() => ({ model, real }), cmds);
        }).beforeEach(async () => {
          /* code executed before each call to predicate */
          try {
            await initialize();
          } catch (error) {
            console.log(error);
            throw error;
          }

        }),
        { verbose: true, 
          // seed: -1926845829, path: "1:2:1:2:3:2:2:1:1:2:2:3:3:1:1:1", endOnFailure: true 
          // seed: -1483695041, path: "6:31:45:10:8:8:8:8:43:10:12:11:12:11:12:11:12:23", endOnFailure: true, // undefined
          // seed: 439585378, path: "0:2:2:1:1:1", endOnFailure: true, 
          // endOnFailure: true,
          // seed: 1919681188, path: "74:5:3:9:4:5:4:5:4:5:7:4:3:6:3:4:3:4:3:4:3:3:3:3:3:3:4:3:4:3:3:3:5:3:3:7:3:3:5:4:5:4:5:7:5:3:3:3:7:4", endOnFailure: true, // bptOut mismatch
          // seed: -566951236, path: "95:5:10:4:7:5:6:5:8:5:5:5:6:5:7:5:6:10:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5:5", endOnFailure: true,
          // seed: 28851344, path: "25:7:1:1:1:2:1:1:1:1:1:2:1:1:1:1:1:1:1:2:1:7:3:3:3:4:3:3:3:1:1:5:1:4:3:3:3:4:3:2:1:1:5:2:4:3:3:3:3:4:1:1:1:1:1:5:3:1:2:3:3:4:3:3:1:1:1:1:4:3:4:3:3:3:3:12:3:4:3:3:3:3:4:3", endOnFailure: true, //BAL#347
          // examples: [[[new PlaceLtoCommand(500, 0, 10), new JoinGivenInCommand(1)]]], // BAL#001
          // examples: [[[new JoinGivenInCommand(1), new PlaceLtoCommand(10, 0, 10), new MultiExitGivenInCommand(3)]]], // 
          // examples: [[[new PlaceLtoCommand(30.682249069213867, 1, 1), new PlaceLtoCommand(2353.07421875, 1, 6)]]]
        }
      );
    })

  });

});