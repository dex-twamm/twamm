import { MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';
import { lt } from 'lodash';
import { fp, decimal } from '@balancer-labs/v2-helpers/src/numbers';
import { join } from 'path';

const POOL_ID = '0xdab1b8c505867ec1e7292b17d7a4b42b6e1626680002000000000000000002c1';
const LTO_CONTRACT = '0x04143AA32FB58bcB943dfF29C3aad9C51FcF9630';
const OWNER_ADDRESS = '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8';
const MATIC_TOKEN_ADDRESS = '0x499d11E0b6eAC7c0593d8Fb292DCBbF815Fb29Ae';
const FAUCET_TOKEN_ADDRESS = '0xBA62BCfcAaFc6622853cca2BE6Ac7d845BC0f2Dc';

const VAULT_RINKEBY = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const VAULT_GOERLI = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

const WHALE = '0x51Ac1DB1A27Ec7CD51a21523a935b26ad53DBEb7';

async function joinPool(vault: Contract, ownerAddress: string) {
  const encodedRequest = defaultAbiCoder.encode(['uint256', 'uint256[]', 'uint256'], [1, [fp(0.1), fp(1)], 0]);
  const joinPoolResult = await vault.callStatic.joinPool(
    POOL_ID,
    ownerAddress,
    ownerAddress,
    {
      assets: [MATIC_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      maxAmountsIn: [MAX_UINT256, MAX_UINT256],
      fromInternalBalance: false,
      userData: encodedRequest,
    },
    {
      gasLimit: 500000,
    }
  );
  console.log(await joinPoolResult.wait());
}

async function placeLongTermOrder(
  vault: Contract,
  tokenInIndex: number,
  tokenOutIndex: number,
  amountIn: BigNumber,
  numberOfBlockIntervals: number
) {
  const encodedRequest = defaultAbiCoder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [4, tokenInIndex, tokenOutIndex, amountIn, numberOfBlockIntervals]
  );
  const placeLtoTx = await vault.joinPool(POOL_ID, OWNER_ADDRESS, OWNER_ADDRESS, {
    assets: [MATIC_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
    maxAmountsIn: [MAX_UINT256, MAX_UINT256],
    fromInternalBalance: false,
    userData: encodedRequest,
  });
  const placeLtoResult = await placeLtoTx.wait();
  console.log(placeLtoResult);
}

async function swap(vault: Contract, tokenInAddress: string, tokenOutAddress: string, amountIn: BigNumber) {
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
      recipient: OWNER_ADDRESS,
      toInternalBalance: false,
    },
    kind === 0 ? 0 : MAX_UINT256, // 0 if given in, infinite if given out.
    MAX_UINT256
  );

  const swapResult = await swapTx.wait();
  console.log(swapResult);
}

async function withdrawLongTermOrder(vault: Contract, orderId: number) {
  const encodedRequest = defaultAbiCoder.encode(['uint256', 'uint256'], [5, orderId]);
  const withdrawLtoTx = await vault.exitPool(
    POOL_ID, // poolID
    OWNER_ADDRESS, // from
    OWNER_ADDRESS, // recipient
    {
      assets: [MATIC_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      minAmountsOut: [0, 0],
      fromInternalBalance: false,
      userData: encodedRequest,
    }
  );
  const withdrawLtoResult = await withdrawLtoTx.wait();
  console.log(withdrawLtoResult);
}

async function cancelLongTermOrder(vault: Contract, orderId: number) {
  const encodedRequest = defaultAbiCoder.encode(['uint256', 'uint256'], [4, orderId]);
  const withdrawLtoTx = await vault.exitPool(
    POOL_ID, // poolID
    OWNER_ADDRESS, // from
    OWNER_ADDRESS, // recipient
    {
      assets: [MATIC_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS],
      minAmountsOut: [0, 0],
      fromInternalBalance: false,
      userData: encodedRequest,
    }
  );
  const withdrawLtoResult = await withdrawLtoTx.wait();
  console.log(withdrawLtoResult);
}

async function readLtoContract(vault: Contract) {
  const ltoContract = await deployedAt('LongTermOrders', LTO_CONTRACT);
  const longTermOrderValues = await ltoContract.longTermOrders();
  const tokenValues = await vault.getPoolTokens(POOL_ID);
  console.log('BalanceA', decimal(tokenValues.balances[0] - longTermOrderValues.balanceA));
  console.log('BalanceB', decimal(tokenValues.balances[1] - longTermOrderValues.balanceB));
  console.log(tokenValues);
}

async function setupBalances(lp: SignerWithAddress) {
  const hre = await import('hardhat');
  await hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [WHALE],
  });
  const whale = ethers.provider.getSigner(WHALE);
  // console.log('Whale account:', whale._address);
  // console.log('Whale balance:', (await whale.getBalance()).toString());

  // const artifact = await getArtifact('IERC20');
  // const usdc = await ethers.getContractAt(artifact.abi, USDC_TOKEN_ADDRESS, whale);
  // const weth = await ethers.getContractAt(artifact.abi, WETH_TOKEN_ADDRESS, whale);

  // console.log('USDC balances:');
  // console.log('whale:', await usdc.balanceOf(whale._address));

  // console.log('WETH balances:');
  // console.log('whale:', await weth.balanceOf(whale._address));

  // await usdc.approve(lp.address, 105e6 * 1e6); // $60M
  // await usdc.transfer(lp.address, 105e6 * 1e6);

  // await weth.approve(lp.address, ethers.utils.parseUnits('62000', 18)); // $60M = ~35000 WETH
  // await weth.transfer(lp.address, ethers.utils.parseUnits('62000', 18));

  // const arbAddress = '0x1129b9F2861756DE70228440488fd5675Bc1091F';
  // await usdc.approve(arbAddress, 15e6 * 1e6); // $60M
  // await usdc.transfer(arbAddress, 15e6 * 1e6);

  // await weth.approve(arbAddress, ethers.utils.parseUnits('10000', 18)); // $60M = ~35000 WETH
  // await weth.transfer(arbAddress, ethers.utils.parseUnits('10000', 18));

  // console.log('LP balances:');
  // console.log('USDC:', await usdc.balanceOf(lp.address));
  // console.log('WETH:', await weth.balanceOf(lp.address));
}

async function main() {
  const [myAccount] = await ethers.getSigners();
  console.log('Using account:', myAccount.address);
  console.log('Account balance:', (await myAccount.getBalance()).toString());

  const vault = await deployedAt('v2-vault/Vault', VAULT_GOERLI);

  // const lto = await deployedAt('LongTermOrders', '0xC392dF9Ee383d6Bce110757FdE7762f0372f6A5D');
  // const transferTx = await lto.transferOwnership('0x20C0b25acE39df183b9CCBbD1D575764544AEB19');
  // console.log(await transferTx.wait());

  // await placeLongTermOrder(vault, 1, 0, fp(0.1), 5);

  // await swap(vault, FAUCET_TOKEN_ADDRESS, MATIC_TOKEN_ADDRESS, fp(0.1));

  // await swap(vault, MATIC_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS, fp(0.001));

  // await withdrawLongTermOrder(vault, 0);

  // await cancelLongTermOrder(vault, 3);

  // await joinPool(vault, myAccount.address);

  await readLtoContract(vault);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
