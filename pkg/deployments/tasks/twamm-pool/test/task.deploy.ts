import hre from 'hardhat';
import { expect } from 'chai';

import Task from '../../../src/task';

describe('TwammPoolFactory', function () {
  const task = Task.fromHRE('twamm-pool', hre);

  it('references the vault correctly', async () => {
    const input = task.input();

    const factory = await task.deployedInstance('TwammPoolFactory');

    expect(await factory.getVault()).to.be.equal(input.Vault);
  });
});
