import { expect } from 'chai';
import { Contract, BigNumber } from 'ethers';
import { bn, fp } from '@balancer-labs/v2-helpers/src/numbers';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';

describe('SignedFixedPointTest', () => {
  let testContract: Contract;
  beforeEach('setup', async function () {
    testContract = await deploy('SignedFixedPointTest');
  });

  it('should compute 2/1 = 2', async () => {
    let result = await testContract.divUp(fp(2), fp(1));
    expect(result).to.be.equal(fp(2));
  });

  it('should compute 12/3 = 4', async () => {
    let result = await testContract.divUp(fp(12), fp(3));
    expect(result).to.be.equal(fp(4));
  });

  it('should compute -12/3 = 4', async () => {
    let result = await testContract.divUp(fp(-12), fp(3));
    expect(result).to.be.equal(fp(-4));
  });

  it('should compute 12/-3 = 4', async () => {
    let result = await testContract.divUp(fp(12), fp(-3));
    expect(result).to.be.equal(fp(-4));
  });

  it('should compute -12/-3 = 4', async () => {
    let result = await testContract.divUp(fp(-12), fp(-3));
    expect(result).to.be.equal(fp(4));
  });
});
