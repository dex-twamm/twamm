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

        await insert(1);
        expect(await heap.isEmpty()).to.equal(false);

        await remove();
        expect(await heap.isEmpty()).to.equal(true);
    });

    it("should create a valid heap by calling insert", async() => {
        let testData = [6, 5, 4, 2, 1, 3, 34];
        for(let i = 0; i < testData.length; i++) {
          await insert(testData[i]);
        }
      
        let finalHeap = (await heap.getHeap())
        let answer = [0, 1, 2, 3, 6, 4, 5, 34];
        await assertArrayEqual(finalHeap, answer)
    });
  

    it('should removeMin from a valid heap', async () => {
        let testData = [34, 26, 33, 15, 24, 5, 4, 12, 1, 23, 21, 2];
        for(let i = 0; i < testData.length; i++) {
          await insert(testData[i]);
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

        answer = [0, 12, 21, 15, 23, 24, 33, 26, 34];
        await removeMin(heap, 5, answer);

        answer = [0, 15, 21, 26, 23, 24, 33, 34];
        await removeMin(heap, 12, answer);

        answer = [0, 21, 23, 26, 34, 24, 33];
        await removeMin(heap, 15, answer);

        answer = [0, 23, 24, 26, 34, 33];
        await removeMin(heap, 21, answer);

        answer = [0, 24, 33, 26, 34];
        await removeMin(heap, 23, answer);

        answer = [0, 26, 33, 34];
        await removeMin(heap, 24, answer);

        answer = [0, 33, 34];
        await removeMin(heap, 26, answer);

        answer = [0, 34];
        await removeMin(heap, 33, answer);

        answer = [0];
        await removeMin(heap, 34, answer);
    });

    async function insert(x: number) {
      let tx = await heap.insert(x);
      let receipt = await tx.wait();
      console.log("insert: ", receipt.cumulativeGasUsed.toString(), receipt.effectiveGasPrice.toString());
    }

    async function remove() {
      let tx = await heap.removeMin();
      let receipt = await tx.wait();
      console.log("remove: ", receipt.cumulativeGasUsed.toString(), receipt.effectiveGasPrice.toString());
    }

    async function removeMin(heap: Contract, root: number, answer: Array<number>) {
        // Get Min
        let min = await heap.getMin();
        expect(min).to.equal(bn(root));

        // Remove Min
        await remove();
      
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