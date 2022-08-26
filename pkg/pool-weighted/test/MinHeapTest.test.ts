import { expect } from 'chai';
import { Contract, BigNumber } from 'ethers';
import { bn } from '@balancer-labs/v2-helpers/src/numbers';

import { deploy } from '@balancer-labs/v2-helpers/src/contract';

describe('MinHeapTest', () => {
    let heap: Contract;
    beforeEach('setup', async function () {
        heap = await deploy('MinHeapTest');
    });

    it('should handle isEmpty properly', async () => {
        expect(await heap.isEmpty()).to.equal(true);

        await heap.insert(1);
        expect(await heap.isEmpty()).to.equal(false);

        await heap.removeMin();
        expect(await heap.isEmpty()).to.equal(true);
    });

    it("should create a valid heap by calling insert", async() => {
        let testData = [6, 5, 4, 2, 1, 3, 34];
        for(let i = 0; i < testData.length; i++) {
          await heap.insert(testData[i]);
        }
      
        let finalHeap = (await heap.getHeap())
        let answer = [0, 1, 2, 3, 6, 4, 5, 34];
        await assertArrayEqual(finalHeap, answer)
    });
  

    it('should removeMin from a valid heap', async () => {
        let testData = [34, 26, 33, 15, 24, 5, 4, 12, 1, 23, 21, 2];
        for(let i = 0; i < testData.length; i++) {
          await heap.insert(testData[i]);
        }

        let finalHeap = (await heap.getHeap());

        let answer = [0, 1, 4, 2, 12, 21, 5, 15, 34, 24, 26, 23, 33];
        await assertArrayEqual(finalHeap, answer);

        answer = [0, 2, 4, 5, 12, 21, 33, 15, 34, 24, 26, 23];
        await removeMin(heap, 1, answer);

        answer = [0, 4, 12, 5, 23, 21, 33, 15, 34, 24, 26];
        await removeMin(heap, 2, answer);

        answer = [0, 5, 12, 15, 23, 21, 33, 26, 34, 24];
        await removeMin(heap, 4, answer);
    });

    async function removeMin(heap: Contract, root: number, answer: Array<number>) {
        // Get Min
        let min = await heap.getMin();
        expect(min).to.equal(bn(root));

        // Remove Min
        await heap.removeMin();
      
        // Compare with expected leftover heap
        let finalHeap = (await heap.getHeap());
        // expect(answer).to.equal(finalHeap);
        await assertArrayEqual(finalHeap, answer);
      }
    
    async function assertArrayEqual(actual: Array<BigNumber>, expected: Array<number>) {
        expect(expected.length).to.equal(actual.length);
        for(let i = 0; i < expected.length; i++) {
            expect(expected[i]).to.equal(bn(actual[i]));
          }
    }
  });