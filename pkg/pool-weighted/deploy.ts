import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { ethers } from 'hardhat';

async function main() {

    const [deployer] = await ethers.getSigners();

    console.log("Deploying contracts with the account:", deployer.address);

    console.log("Account balance:", (await deployer.getBalance()).toString());

    let ltoContract = await deploy('LongTermOrdersContract', {from:deployer, args: [100]});
    console.log("LTO contract deployed to address:", ltoContract.address);

    const vaultContract = await deployedAt("IVault", "0xBA12222222228d8Ba445958a75a0704d566BF2C8");
    let factoryContract = await deploy('TwammWeightedPoolFactory', {from:deployer, args: [vaultContract.address]});
    // let factoryContract = await deploy('WeightedPoolFactory', {from:deployer, args: [vaultContract.address]});
    console.log("Factory contract deployed to address:", factoryContract.address);

    
}

main()
.then(() => process.exit(0))
.catch(error => {
  console.error(error);
  process.exit(1);
});