import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-etherscan';

import { hardhatBaseConfig } from '@balancer-labs/v2-common';
import { name } from './package.json';

require('dotenv').config();

const { GOERLI_API_URL, RINKEBY_API_URL, ETHERSCAN_KEY, PRIVATE_KEY } = process.env;

import { task } from 'hardhat/config';
import { TASK_COMPILE } from 'hardhat/builtin-tasks/task-names';
import overrideQueryFunctions from '@balancer-labs/v2-helpers/plugins/overrideQueryFunctions';

task(TASK_COMPILE).setAction(overrideQueryFunctions);

export default {
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    rinkeby: {
      url: RINKEBY_API_URL,
      accounts: [`0x${PRIVATE_KEY}`],
      gasPrice: 20e9,
      gas: 25e6,
    },
    goerli: {
      url: GOERLI_API_URL,
      accounts: [`0x${PRIVATE_KEY}`],
      gasPrice: 20e9,
      gas: 25e6,
    },
  },
  etherscan: {
    // Your API key for Etherscan
    // Obtain one at https://etherscan.io/
    apiKey: ETHERSCAN_KEY,
  },
  solidity: {
    compilers: [
      {
        version: '0.7.1',
        settings: {
          optimizer: {
            enabled: true,
          },
        },
      },
    ],
    overrides: { ...hardhatBaseConfig.overrides(name) },
  },
};
