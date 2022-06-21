import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';

import { hardhatBaseConfig } from '@balancer-labs/v2-common';
import { name } from './package.json';

require('dotenv').config();


const { API_URL, PRIVATE_KEY } = process.env;

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
      url: API_URL,
      accounts: [`0x${PRIVATE_KEY}`],
      gasPrice: 20000000000,
      gas: 1000000000000000,
      blockGasLimit: 1000000000000000
   }
  },
  solidity: {
    compilers: [
      {
        version: '0.7.1',
      }
    ],
    overrides: { ...hardhatBaseConfig.overrides(name) },
  },
};
