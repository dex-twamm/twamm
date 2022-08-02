import { MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';
import { lt } from 'lodash';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';

const POOL_ID = "0xc8a1b5027cc8b7ac2145dc7b786450cefee48fe8000200000000000000000227";
const OWNER_ADDRESS = '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8';
const TUSDT_TOKEN_ADDRESS = "0xD92E713d051C37EbB2561803a3b5FBAbc4962431";
const FAUCET_TOKEN_ADDRESS = "0xFab46E002BbF0b4509813474841E0716E6730136";

const VAULT_RINKEBY = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

async function joinPool(vault: Contract) {
  const encodedRequest = defaultAbiCoder.encode(
    ['uint256', 'uint256[]', 'uint256'],
    [1, [fp(1e-12), fp(1.0)], 0]
  );
  const joinPoolResult = await vault.joinPool(
    POOL_ID,
    OWNER_ADDRESS,
    OWNER_ADDRESS,
    {
      assets: [TUSDT_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      maxAmountsIn: [MAX_UINT256, MAX_UINT256],
      fromInternalBalance: false,
      userData: encodedRequest,
    }
  )
  console.log(joinPoolResult);
}

async function placeLongTermOrder(
    vault: Contract, tokenInIndex: number, tokenOutIndex: number,
    amountIn: BigNumber, numberOfBlockIntervals: number) {
  const encodedRequest = defaultAbiCoder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [4, tokenInIndex, tokenOutIndex, amountIn, numberOfBlockIntervals]
  );
  const placeLtoTx = await vault.joinPool(
    POOL_ID,
    OWNER_ADDRESS,
    OWNER_ADDRESS,
    {
      assets: [TUSDT_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      maxAmountsIn: [MAX_UINT256, MAX_UINT256],
      fromInternalBalance: false,
      userData: encodedRequest,
    }
  )
  const placeLtoResult = await placeLtoTx.wait();
  console.log(placeLtoResult);
}

async function swap(
  vault: Contract, tokenInAddress: string, tokenOutAddress: string,
  amountIn: BigNumber) {
    const kind = 0; // GivenIn

    const swapTx = await vault.swap(
      {
        poolId: POOL_ID,
        kind: kind,
        assetIn: tokenInAddress,
        assetOut: tokenOutAddress,
        amount: amountIn,
        userData: '0x',
      },
      {
        sender: OWNER_ADDRESS,
        fromInternalBalance: false,
        recipient:OWNER_ADDRESS,
        toInternalBalance: false,
      },
      kind === 0 ? 0 : MAX_UINT256, // 0 if given in, infinite if given out.
      MAX_UINT256
    );
    
    const swapResult = await swapTx.wait();
    console.log(swapResult);
}

async function withdrawLongTermOrder(vault: Contract, orderId: number) {
  const encodedRequest = defaultAbiCoder.encode(
    ['uint256', 'uint256'], 
    [5, orderId]);
  const withdrawLtoTx = await vault.exitPool(
    POOL_ID, // poolID
    OWNER_ADDRESS, // from
    OWNER_ADDRESS, // recipient
    {
      assets: [TUSDT_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      minAmountsOut: [0, 0],
      fromInternalBalance: false,
      userData: encodedRequest,
    }
  );
  const withdrawLtoResult = await withdrawLtoTx.wait();
  console.log(withdrawLtoResult);
}

async function cancelLongTermOrder(vault: Contract, orderId: number) {
  const encodedRequest = defaultAbiCoder.encode(
    ['uint256', 'uint256'], 
    [4, orderId]);
  const withdrawLtoTx = await vault.exitPool(
    POOL_ID, // poolID
    OWNER_ADDRESS, // from
    OWNER_ADDRESS, // recipient
    {
      assets: [TUSDT_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      minAmountsOut: [0, 0],
      fromInternalBalance: false,
      userData: encodedRequest,
    }
  );
  const withdrawLtoResult = await withdrawLtoTx.wait();
  console.log(withdrawLtoResult);
}

async function main() {

    const [myAccount] = await ethers.getSigners();
    console.log("Using account:", myAccount.address);
    console.log("Account balance:", (await myAccount.getBalance()).toString());

    const vault = await deployedAt('v2-vault/Vault', VAULT_RINKEBY);

    // const lto = await deployedAt('LongTermOrders', '0x0e369c2c2495152c80A386EdDaDd08c49C43E6ee');
    // const transferTx = await lto.transferOwnership('0xc8a1B5027cC8B7Ac2145dC7B786450CEfEE48FE8');
    // console.log(await transferTx.wait());


    // await placeLongTermOrder(vault, 1, 0, fp(0.1), 1);

    // await swap(vault, FAUCET_TOKEN_ADDRESS, TUSDT_TOKEN_ADDRESS, fp(0.1));

    // await swap(vault, TUSDT_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS,
    //   fp(1e-13));

    await withdrawLongTermOrder(vault, 4);

    // await cancelLongTermOrder(vault, 3);
}

main()
.then(() => process.exit(0))
.catch(error => {
  console.error(error);
  process.exit(1);
});