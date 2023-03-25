import { MAX_UINT256, ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';
import { deployedAt, getArtifact } from '@balancer-labs/v2-helpers/src/contract';
import { defaultAbiCoder } from '@ethersproject/abi';
import { BigNumber, Contract } from 'ethers';
import { ethers } from 'hardhat';
import { fp, decimal } from '@balancer-labs/v2-helpers/src/numbers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { POOLS } from './pool';

// TODO: create a list of pools and use by identifier.
const POOL_ID = '0xf7a3ffd8d6ae4b2564a18591d6f3783ec5f79d3a000200000000000000000417';
const POOL_ADDRESS = '0xF7A3Ffd8d6aE4B2564A18591D6F3783ec5F79D3a';
const LTO_CONTRACT = '0x04143AA32FB58bcB943dfF29C3aad9C51FcF9630';
const OWNER_ADDRESS = '0xdD88DB355D6beb64813fd3b29B73A246DAed6FC8';
const MATIC_TOKEN_ADDRESS = '0x499d11E0b6eAC7c0593d8Fb292DCBbF815Fb29Ae';
const FAUCET_TOKEN_ADDRESS = '0xBA62BCfcAaFc6622853cca2BE6Ac7d845BC0f2Dc';

const VAULT_RINKEBY = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const VAULT_GOERLI = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

const WHALE = '0x51Ac1DB1A27Ec7CD51a21523a935b26ad53DBEb7';

// TODO: Refactor.
const BALANCER_HELPER_ABI = [
  {
    inputs: [
      {
        internalType: 'contract IVault',
        name: '_vault',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'poolId',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'sender',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'recipient',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'contract IAsset[]',
            name: 'assets',
            type: 'address[]',
          },
          {
            internalType: 'uint256[]',
            name: 'minAmountsOut',
            type: 'uint256[]',
          },
          {
            internalType: 'bytes',
            name: 'userData',
            type: 'bytes',
          },
          {
            internalType: 'bool',
            name: 'toInternalBalance',
            type: 'bool',
          },
        ],
        internalType: 'struct IVault.ExitPoolRequest',
        name: 'request',
        type: 'tuple',
      },
    ],
    name: 'queryExit',
    outputs: [
      {
        internalType: 'uint256',
        name: 'bptIn',
        type: 'uint256',
      },
      {
        internalType: 'uint256[]',
        name: 'amountsOut',
        type: 'uint256[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'bytes32',
        name: 'poolId',
        type: 'bytes32',
      },
      {
        internalType: 'address',
        name: 'sender',
        type: 'address',
      },
      {
        internalType: 'address',
        name: 'recipient',
        type: 'address',
      },
      {
        components: [
          {
            internalType: 'contract IAsset[]',
            name: 'assets',
            type: 'address[]',
          },
          {
            internalType: 'uint256[]',
            name: 'maxAmountsIn',
            type: 'uint256[]',
          },
          {
            internalType: 'bytes',
            name: 'userData',
            type: 'bytes',
          },
          {
            internalType: 'bool',
            name: 'fromInternalBalance',
            type: 'bool',
          },
        ],
        internalType: 'struct IVault.JoinPoolRequest',
        name: 'request',
        type: 'tuple',
      },
    ],
    name: 'queryJoin',
    outputs: [
      {
        internalType: 'uint256',
        name: 'bptOut',
        type: 'uint256',
      },
      {
        internalType: 'uint256[]',
        name: 'amountsIn',
        type: 'uint256[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'vault',
    outputs: [
      {
        internalType: 'contract IVault',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

async function joinPool(vault: Contract, ownerAddress: string, poolId: string, pool: any, amounts: number[]) {
  // joinKind, amounts, minBptOut
  const encodedRequest = defaultAbiCoder.encode(['uint256', 'uint256[]', 'uint256'], [1, amounts.map(fp), 0]);
  const joinPoolResult = await vault.joinPool(
    poolId,
    ownerAddress,
    ownerAddress,
    {
      assets: [pool.tokens[0].address, pool.tokens[1].address],
      maxAmountsIn: [MAX_UINT256, MAX_UINT256],
      fromInternalBalance: false,
      userData: encodedRequest,
    },
    {
      gasLimit: 500000,
    }
  );
  console.log(joinPoolResult.hash);
  console.log(await joinPoolResult.wait());
}

async function withdrawCollectedManagementFees(ownerAddress: string) {
  const pool = await deployedAt('TwammWeightedPool', POOL_ADDRESS);
  // const tx = await pool.getCollectedManagementFees();
  const ltoContractAddress = await pool.getLongTermOrderContractAddress();
  console.log(ltoContractAddress);

  const ltoContract = await deployedAt('LongTermOrders', ltoContractAddress);
  console.log(await ltoContract.getLongTermOrdersBalances());

  // console.log(await tx.wait());
}

async function exitPool(vault: Contract, ownerAddress: string) {
  const pool = await deployedAt('TwammWeightedPool', POOL_ADDRESS);
  console.log(await pool.balanceOf(ownerAddress));
  console.log(await pool.totalSupply());
  console.log(await vault.getPoolTokens(POOL_ID));

  // let bptIn = (await pool.totalSupply()).toString();
  const bptIn = '57000000000000000000';
  console.log(bptIn, BigNumber.from(bptIn).toString());

  // const balHelpers = await deployedAt('BalancerHelpers', '0x5aDDCCa35b7A0D07C74063c48700C8590E87864E');

  const balHelpers = new Contract('0x5aDDCCa35b7A0D07C74063c48700C8590E87864E', BALANCER_HELPER_ABI, pool.signer);

  console.log(await vault.provider.getGasPrice());

  const encodedRequest = defaultAbiCoder.encode(['uint256', 'uint256'], [1, BigNumber.from(bptIn)]);
  // const queryResult = await balHelpers.queryExit(
  const exitPoolResult = await vault.exitPool(
    // const data = [
    POOL_ID,
    ownerAddress,
    ownerAddress,
    {
      assets: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
      minAmountsOut: [0, 0],
      fromInternalBalance: false,
      userData: encodedRequest,
    },
    {
      gasLimit: 500000,
      // nonce: 16,
      gasPrice: await vault.provider.getGasPrice(),
    }
  );
  // ];
  // console.log(data);
  // console.log(await queryResult);

  console.log(await exitPoolResult.wait());

  console.log('after', await pool.balanceOf('0xd3c5DDB9E57d961302D4BDd12106485E25E21508'));
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

async function getAllShortSwaps() {
  const vault = await deployedAt('v2-vault/Vault', VAULT_GOERLI);
  const eventFilter = vault.filters.Swap('0xf7a3ffd8d6ae4b2564a18591d6f3783ec5f79d3a000200000000000000000417');
  const events = await vault.queryFilter(eventFilter);

  events.map((e) => console.log(e.blockNumber, e.args ? e.args[3].toString() + ' ' + e.args[4].toString() : ''));
}

async function getAllLongSwaps() {
  const vault = await deployedAt('TwammWeightedPool', POOL_ADDRESS);
  const eventFilter = vault.filters.LongTermOrderPlaced();
  const events = await vault.queryFilter(eventFilter);

  events.map((e) => {
    console.log(e.blockNumber, e.args ? `Order Id: ${e.args[0].toString()} Owner: ${e.args[4].toString()}` : '');
    console.log(
      e.blockNumber,
      e.args
        ? `Token In: ${e.args[2].toString()} Sale Rate: ${e.args[3].toString()} Exp block: ${e.args[5].toString()}`
        : ''
    );
  });
}

async function approveForJoin(pool: any, myAccount: SignerWithAddress, vault: Contract) {
  const artifact = await getArtifact('IERC20');
  const token0 = await ethers.getContractAt(artifact.abi, pool.tokens[0].address, myAccount);
  const token1 = await ethers.getContractAt(artifact.abi, pool.tokens[1].address, myAccount);

  console.log('token0 balances:');
  console.log(await token0.balanceOf(myAccount.address));

  console.log('token1 balances:');
  console.log(await token1.balanceOf(myAccount.address));

  console.log('token0 allowance:');
  console.log(await token0.allowance(myAccount.address, vault.address));

  console.log('token1 allowance:');
  console.log(await token1.allowance(myAccount.address, vault.address));

  // await usdc.approve(lp.address, 105e6 * 1e6); // $60M
  // await usdc.transfer(lp.address, 105e6 * 1e6);

  // await weth.approve(lp.address, ethers.utils.parseUnits('62000', 18)); // $60M = ~35000 WETH
  // await weth.transfer(lp.address, ethers.utils.parseUnits('62000', 18));
}

async function main() {
  const [myAccount] = await ethers.getSigners();
  console.log('Using account:', myAccount.address);
  console.log('Account balance:', (await myAccount.getBalance()).toString());

  // await getAllLongSwaps();

  // await withdrawCollectedManagementFees('0xd3c5DDB9E57d961302D4BDd12106485E25E21508');
  const vault = await deployedAt('v2-vault/Vault', VAULT_GOERLI);

  // await exitPool(vault, '0xd3c5DDB9E57d961302D4BDd12106485E25E21508');

  // const lto = await deployedAt('LongTermOrders', '0xC392dF9Ee383d6Bce110757FdE7762f0372f6A5D');
  // const transferTx = await lto.transferOwnership('0x20C0b25acE39df183b9CCBbD1D575764544AEB19');
  // console.log(await transferTx.wait());

  // await placeLongTermOrder(vault, 1, 0, fp(0.1), 5);

  // await swap(vault, FAUCET_TOKEN_ADDRESS, MATIC_TOKEN_ADDRESS, fp(0.1));

  // await swap(vault, MATIC_TOKEN_ADDRESS, FAUCET_TOKEN_ADDRESS, fp(0.001));

  // await withdrawLongTermOrder(vault, 0);

  // await cancelLongTermOrder(vault, 3);

  const poolId = POOLS.Ethereum[0].poolId;
  // await approveForJoin(POOLS.Ethereum[0], myAccount, vault);
  await joinPool(vault, myAccount.address, poolId, POOLS.Ethereum[0], [5000e-12, 2.91]);

  // await readLtoContract(vault);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
