import { MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';
import { lt } from 'lodash';
import { fp } from '@balancer-labs/v2-helpers/src/numbers';

async function joinPool(vault: Contract) {
  const encodedRequest = defaultAbiCoder.encode(
    ['uint256', 'uint256[]', 'uint256'],
    [1, [fp(1e-12), fp(1.0)], 0]
  );
  const joinPoolResult = await vault.joinPool(
    '0x125d09ccdca44761a0dbdfbb4b7bd666ed188d8600020000000000000000021e',
    '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8',
    '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8',
    {
      assets: ["0xD92E713d051C37EbB2561803a3b5FBAbc4962431", "0xFab46E002BbF0b4509813474841E0716E6730136"],
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
    '0x125d09ccdca44761a0dbdfbb4b7bd666ed188d8600020000000000000000021e',
    '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8',
    '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8',
    {
      assets: ["0xD92E713d051C37EbB2561803a3b5FBAbc4962431", "0xFab46E002BbF0b4509813474841E0716E6730136"],
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
        poolId: '0x125d09ccdca44761a0dbdfbb4b7bd666ed188d8600020000000000000000021e',
        kind: kind,
        assetIn: tokenInAddress,
        assetOut: tokenOutAddress,
        amount: amountIn,
        userData: '0x',
      },
      {
        sender: '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8',
        fromInternalBalance: false,
        recipient:'0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8',
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
    '0x125d09ccdca44761a0dbdfbb4b7bd666ed188d8600020000000000000000021e', // poolID
    '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8', // from
    '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8', // recipient
    {
      assets: ["0xD92E713d051C37EbB2561803a3b5FBAbc4962431", "0xFab46E002BbF0b4509813474841E0716E6730136"],
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

    const vault = await deployedAt('v2-vault/Vault', '0xBA12222222228d8Ba445958a75a0704d566BF2C8'); // rinkeby vault

    // await placeLongTermOrder(vault, 1, 0, fp(0.1), 4);

    await swap(vault, "0xFab46E002BbF0b4509813474841E0716E6730136", "0xD92E713d051C37EbB2561803a3b5FBAbc4962431",
    fp(0.1));

    // await swap(vault, "0xD92E713d051C37EbB2561803a3b5FBAbc4962431", "0xFab46E002BbF0b4509813474841E0716E6730136",
    //   fp(1e-13));

    // await withdrawLongTermOrder(vault, 1);
}

main()
.then(() => process.exit(0))
.catch(error => {
  console.error(error);
  process.exit(1);
});