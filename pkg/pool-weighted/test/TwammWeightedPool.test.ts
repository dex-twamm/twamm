import { ethers, testUtils } from 'hardhat';
import { expect } from 'chai';
import { bn, fp, fromFp, toFp, pct } from '@balancer-labs/v2-helpers/src/numbers';
import { Decimal } from 'decimal.js';
import { BigNumber, Contract } from 'ethers';

import { MAX_UINT256 } from '@balancer-labs/v2-helpers/src/constants';

import { sharedBeforeEach } from '@balancer-labs/v2-common/sharedBeforeEach';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import TokenList from '@balancer-labs/v2-helpers/src/models/tokens/TokenList';
import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { WeightedPoolType } from '@balancer-labs/v2-helpers/src/models/pools/weighted/types';
import { lastBlockNumber } from '@balancer-labs/v2-helpers/src/time';
import * as expectEvent from '@balancer-labs/v2-helpers/src/test/expectEvent';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';

import { itBehavesAsWeightedPool } from './BaseWeightedPool.behavior';

import executeVirtualOrders from './TwammHelper';

const { block } = testUtils;

async function moveForwardNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine', []);
  }
}

export type BigNumberish = string | number | BigNumber;

function fpDec6(x: BigNumberish | Decimal): BigNumber {
  return fp(x).div(1e12);
}

function getOrderExpiryBlock(orderBlockInterval: number, numberOfBlockIntervals: number, blockNumber: number): number {
  return orderBlockInterval * (numberOfBlockIntervals + 1) + blockNumber - (blockNumber % orderBlockInterval);
}

function getOrderSalesRate(amount: BigNumber, expiryBlock: number, orderPlacedBlock: number) {
  return bn(
    new Decimal(amount.toString())
      .div(new Decimal(expiryBlock - orderPlacedBlock))
      .toDecimalPlaces(0, Decimal.ROUND_DOWN)
  );
}

async function swap(
  pool: WeightedPool,
  tokenInIndex: number,
  tokenOutIndex: number,
  amountIn: BigNumber,
  sender: SignerWithAddress,
  recipient: SignerWithAddress
) {
  const kind = 0; // GivenIn

  const tokens = (await pool.getTokens()).tokens;

  const swapTx = await pool.vault.instance.connect(sender).swap(
    {
      poolId: await pool.getPoolId(),
      kind: kind,
      assetIn: tokens[tokenInIndex],
      assetOut: tokens[tokenOutIndex],
      amount: amountIn,
      userData: '0x',
    },
    {
      sender: sender.address,
      fromInternalBalance: false,
      recipient: recipient.address,
      toInternalBalance: false,
    },
    0,
    MAX_UINT256
  );

  const receipt = await swapTx.wait();

  // Uncomment for gas measurement.
  // console.log('swap: ', receipt.gasUsed.toString());

  return receipt;
}

async function estimateSpotPrice(pool: WeightedPool, longTermOrdersContract: Contract) {
  const fpBalances = await pool.getBalances();
  const adjustedBalances = [];

  const longTermOrdersStruct = await longTermOrdersContract.longTermOrders();

  adjustedBalances[0] = fpBalances[0].sub(longTermOrdersStruct.balanceA);
  adjustedBalances[1] = fpBalances[1].sub(longTermOrdersStruct.balanceB);

  const fpWeights = pool.weights;
  const numerator = fromFp(adjustedBalances[0]).div(fromFp(fpWeights[0]));
  const denominator = fromFp(adjustedBalances[1]).div(fromFp(fpWeights[1]));
  return bn(toFp(numerator.div(denominator)).toFixed(0));
}

async function doShortSwapsUntil(
  blockNumber: number,
  pool: WeightedPool,
  owner: SignerWithAddress,
  other: SignerWithAddress
) {
  let i = 0;
  // Move forward beyond expiry block with one swap after every 20 blocks.
  while ((await lastBlockNumber()) < blockNumber) {
    await moveForwardNBlocks(4);
    if (i % 2) {
      await swap(pool, 0, 1, fp(0.01), owner, other);
    } else {
      await swap(pool, 1, 0, fpDec6(0.04), owner, other);
    }
    i++;
  }
}

function expectBalanceToBeApprox(actualBalance: BigNumber, expectedBalance: BigNumber) {
  // Expect both balances to be within 1e-3 of expected values.
  expect(actualBalance).to.be.lt(expectedBalance.add(1e15));
  expect(actualBalance).to.be.gt(expectedBalance.sub(1e15));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EXPECTED_RELATIVE_ERROR = 1e-15;

describe('TwammWeightedPool', function () {
  describe('long term order tests', () => {
    let owner: SignerWithAddress, other: SignerWithAddress;

    before('setup signers', async () => {
      [, owner, other] = await ethers.getSigners();
    });
    let tokens: TokenList;
    let sender: SignerWithAddress;
    let pool: WeightedPool;
    const weights = [fp(0.5), fp(0.5)];
    // 1 token A = 4 token B
    const initialBalances = [fp(100.0), fpDec6(400.0)];

    let longTermOrdersContract: Contract;

    async function placeLongTermOrder(
      address: SignerWithAddress,
      tokenInIndex: number,
      tokenOutIndex: number,
      amount: BigNumber,
      numberOfBlockIntervals: number,
      orderBlockInterval: number
    ): Promise<[number, BigNumber]> {
      await pool.placeLongTermOrder({
        from: address,
        tokenInIndex,
        tokenOutIndex,
        amountIn: amount,
        numberOfBlockIntervals,
      });

      const lastBlock = await lastBlockNumber();

      return [lastBlock, getSaleRate(amount, numberOfBlockIntervals, lastBlock, orderBlockInterval)];
    }

    function getSaleRate(
      amount: BigNumber,
      numberOfBlockIntervals: number,
      blockNumber: number,
      orderBlockInterval: number
    ): BigNumber {
      return amount.div(orderBlockInterval * (numberOfBlockIntervals + 1) - (blockNumber % orderBlockInterval));
    }

    sharedBeforeEach('deploy tokens', async () => {
      tokens = await TokenList.create(
        [
          { decimals: 18, symbol: 'DAI' },
          { decimals: 6, symbol: 'USDT' },
        ],
        { sorted: true }
      );
      await tokens.mint({ to: [owner, other], amount: fp(100000.0) });
    });

    context('when initialized with swaps enabled', () => {
      const orderBlockInterval = 10;
      sharedBeforeEach('deploy pool', async () => {
        const params = {
          tokens,
          weights,
          owner: owner.address,
          poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
          swapEnabledOnStart: true,
          orderBlockInterval: orderBlockInterval,
          fromFactory: true,
        };
        pool = await WeightedPool.create(params);
        longTermOrdersContract = await deployedAt('LongTermOrders', await pool.getLongTermOrderContractAddress());
      });

      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            sender = owner;

            // tokens = allTokens.subset(2);
            await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, other] });

            await pool.init({ from: owner, initialBalances });
          });

          it('can get long term order contract address', async () => {
            const longTermOrdersContractAddress = await pool.getLongTermOrderContractAddress();
            expect(longTermOrdersContractAddress).to.be.equal(longTermOrdersContract.address);
          });

          it('can execute one-way Long Term Order', async () => {
            const placeResult = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            const expectedExpiryBlock = getOrderExpiryBlock(10, 10, await lastBlockNumber());

            expectEvent.inIndirectReceipt(placeResult.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              expirationBlock: expectedExpiryBlock,
            });

            await doShortSwapsUntil(expectedExpiryBlock, pool, owner, other);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fpDec6(3.96));
          });

          it('can get long term order', async () => {
            const placeResult = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            const longTermOrder = await pool.getLongTermOrder(0);

            expectEvent.inIndirectReceipt(placeResult.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: longTermOrder.orderId,
              sellTokenIndex: longTermOrder.sellTokenIndex,
              buyTokenIndex: longTermOrder.buyTokenIndex,
              owner: longTermOrder.owner,
              expirationBlock: longTermOrder.expirationBlock,
            });
          });

          it('can place long term order and receive order placed event', async () => {
            const amount = fp(1.0);

            const buyTokenIndex = 1,
              sellTokenIndex = 0;
            const placeResult = await pool.placeLongTermOrder({
              from: other,
              amountIn: amount,
              tokenInIndex: sellTokenIndex,
              tokenOutIndex: buyTokenIndex,
              numberOfBlockIntervals: 10,
            });

            const orderPlacedBlock = await lastBlockNumber();
            const expiryBlock = getOrderExpiryBlock(10, 10, orderPlacedBlock);

            expectEvent.inIndirectReceipt(placeResult.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: sellTokenIndex,
              buyTokenIndex: buyTokenIndex,
              saleRate: getOrderSalesRate(amount, expiryBlock, orderPlacedBlock),
              owner: other.address,
              expirationBlock: expiryBlock,
            });
          });

          it('can cancel long term order and receive order cancelled event', async () => {
            const buyTokenIndex = 1,
              sellTokenIndex = 0,
              amount = fp(1.0);

            await pool.placeLongTermOrder({
              from: other,
              amountIn: amount,
              tokenInIndex: sellTokenIndex,
              tokenOutIndex: buyTokenIndex,
              numberOfBlockIntervals: 10,
            });

            const orderPlacedBlock = await lastBlockNumber();
            const expiryBlock = getOrderExpiryBlock(10, 10, orderPlacedBlock);
            const expectedSalesRate = getOrderSalesRate(amount, expiryBlock, orderPlacedBlock);

            const cancelTx = await pool.cancelLongTermOrder({ orderId: 0, from: other });

            const [, , balanceA, balanceB] = executeVirtualOrders(
              initialBalances[0],
              initialBalances[1],
              expectedSalesRate,
              fp(0),
              amount,
              fp(0),
              orderPlacedBlock,
              orderPlacedBlock + 1
            );

            const events = expectEvent.getEventLog(cancelTx.receipt, pool.instance.interface, 'LongTermOrderCancelled');

            // Check for single order cancelled event
            expect(events.length).to.be.equal(1);
            const orderCancelledEvent = events[0];

            expect(orderCancelledEvent.args['orderId']).to.be.equal(0);
            expect(orderCancelledEvent.args['sellTokenIndex']).to.be.equal(sellTokenIndex);
            expect(orderCancelledEvent.args['buyTokenIndex']).to.be.equal(buyTokenIndex);
            expect(orderCancelledEvent.args['saleRate']).to.be.equal(expectedSalesRate);
            expect(orderCancelledEvent.args['owner']).to.be.equal(other.address);
            expect(orderCancelledEvent.args['expirationBlock']).to.be.equal(expiryBlock);
            expect(orderCancelledEvent.args['proceeds']).to.be.lt(balanceB);
            expect(orderCancelledEvent.args['proceeds']).to.be.gt(balanceB.sub(3));
            expectEqualWithError(orderCancelledEvent.args['unsoldAmount'], balanceA, EXPECTED_RELATIVE_ERROR);
          });

          it('can withdraw partial long term order and receive order withdrawn event', async () => {
            const buyTokenIndex = 1,
              sellTokenIndex = 0,
              amount = fp(1.0);

            await pool.placeLongTermOrder({
              from: other,
              amountIn: amount,
              tokenInIndex: sellTokenIndex,
              tokenOutIndex: buyTokenIndex,
              numberOfBlockIntervals: 10,
            });

            const orderPlacedBlock = await lastBlockNumber();
            const expiryBlock = getOrderExpiryBlock(10, 10, orderPlacedBlock);
            const expectedSalesRate = getOrderSalesRate(amount, expiryBlock, orderPlacedBlock);

            await moveForwardNBlocks(expiryBlock - 50);

            const withdrawTx = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            const [, , , balanceB] = executeVirtualOrders(
              initialBalances[0],
              initialBalances[1],
              expectedSalesRate,
              fp(0),
              amount,
              fp(0),
              orderPlacedBlock,
              await lastBlockNumber()
            );

            const events = expectEvent.getEventLog(
              withdrawTx.receipt,
              pool.instance.interface,
              'LongTermOrderWithdrawn'
            );

            // Check for single order cancelled event
            expect(events.length).to.be.equal(1);
            const orderCancelledEvent = events[0];

            expect(orderCancelledEvent.args['orderId']).to.be.equal(0);
            expect(orderCancelledEvent.args['sellTokenIndex']).to.be.equal(sellTokenIndex);
            expect(orderCancelledEvent.args['buyTokenIndex']).to.be.equal(buyTokenIndex);
            expect(orderCancelledEvent.args['saleRate']).to.be.equal(expectedSalesRate);
            expect(orderCancelledEvent.args['owner']).to.be.equal(other.address);
            expect(orderCancelledEvent.args['expirationBlock']).to.be.equal(expiryBlock);
            expect(orderCancelledEvent.args['isPartialWithdrawal']).to.be.equal(true);
            expect(orderCancelledEvent.args['proceeds']).to.be.lte(balanceB);
            expect(orderCancelledEvent.args['proceeds']).to.be.gte(balanceB.sub(2));
          });

          it('can withdraw long term order and receive order withdrawn event', async () => {
            const buyTokenIndex = 1,
              sellTokenIndex = 0,
              amount = fp(1.0);

            await pool.placeLongTermOrder({
              from: other,
              amountIn: amount,
              tokenInIndex: sellTokenIndex,
              tokenOutIndex: buyTokenIndex,
              numberOfBlockIntervals: 10,
            });

            const orderPlacedBlock = await lastBlockNumber();
            const expiryBlock = getOrderExpiryBlock(10, 10, orderPlacedBlock);
            const expectedSalesRate = getOrderSalesRate(amount, expiryBlock, orderPlacedBlock);

            await moveForwardNBlocks(expiryBlock);

            const withdrawTx = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            const [, , , balanceB] = executeVirtualOrders(
              initialBalances[0],
              initialBalances[1],
              expectedSalesRate,
              fp(0),
              amount,
              fp(0),
              orderPlacedBlock,
              expiryBlock
            );

            const events = expectEvent.getEventLog(
              withdrawTx.receipt,
              pool.instance.interface,
              'LongTermOrderWithdrawn'
            );

            // Check for single order cancelled event
            expect(events.length).to.be.equal(1);
            const orderCancelledEvent = events[0];

            expect(orderCancelledEvent.args['orderId']).to.be.equal(0);
            expect(orderCancelledEvent.args['sellTokenIndex']).to.be.equal(sellTokenIndex);
            expect(orderCancelledEvent.args['buyTokenIndex']).to.be.equal(buyTokenIndex);
            expect(orderCancelledEvent.args['saleRate']).to.be.equal(expectedSalesRate);
            expect(orderCancelledEvent.args['owner']).to.be.equal(other.address);
            expect(orderCancelledEvent.args['expirationBlock']).to.be.equal(expiryBlock);
            expect(orderCancelledEvent.args['isPartialWithdrawal']).to.be.equal(false);
            expect(orderCancelledEvent.args['proceeds']).to.be.lt(balanceB);
            expect(orderCancelledEvent.args['proceeds']).to.be.gt(balanceB.sub(2));
          });

          async function joinPoolGivenInAndExpect(
            sender: SignerWithAddress,
            amountsIn: BigNumber[],
            balances: BigNumber[]
          ) {
            const expectedBptOut = await pool.estimateBptOut(amountsIn, balances);
            const previousBptBalance = await pool.balanceOf(other);

            const result = await pool.joinGivenIn({ from: sender, amountsIn: amountsIn });

            // Amounts in should be the same as initial ones
            expect(result.amountsIn).to.deep.equal(amountsIn);

            // Make sure received BPT is close to what we expect
            const currentBptBalance = await pool.balanceOf(other);

            expect(currentBptBalance.sub(previousBptBalance)).to.be.equalWithError(expectedBptOut, 0.0001);
          }

          async function executeVirtualOrdersJoinPoolGivenInAndExpect(
            sender: SignerWithAddress,
            amountsIn: BigNumber[],
            orderPlacementBlock: number,
            currentSaleRateA: BigNumber,
            currentSaleRateB: BigNumber
          ) {
            const ammBalances: BigNumber[] = [fp(0), fp(0)];
            const longTermBalances = await longTermOrdersContract.getLongTermOrdersBalances();
            const currentBalances = await getLtoRemovedPoolBalances();

            [ammBalances[0], ammBalances[1], ,] = executeVirtualOrders(
              currentBalances[0],
              currentBalances[1],
              currentSaleRateA,
              currentSaleRateB,
              longTermBalances[0],
              longTermBalances[1],
              orderPlacementBlock,
              orderPlacementBlock + 1
            );

            joinPoolGivenInAndExpect(sender, amountsIn, ammBalances);
          }

          async function exitPoolSingleTokenGivenInAndExpect(
            lp: SignerWithAddress,
            tokenToExit: number,
            balances: BigNumber[]
          ) {
            const previousBptBalance = await pool.balanceOf(lp);
            const bptIn = pct(previousBptBalance, 0.2);
            const expectedTokenOut = await pool.estimateTokenOut(tokenToExit, bptIn, balances);

            const result = await pool.singleExitGivenIn({ from: lp, bptIn, token: tokenToExit });

            // Protocol fees should be zero
            // TODO check this. Why dueProtocolFeeAmounts is undefined?
            // expect(result.dueProtocolFeeAmounts).to.be.zeros;

            // Only token out should be the one transferred
            expect(result.amountsOut[tokenToExit]).to.be.equalWithError(expectedTokenOut, 0.0001);
            expect(result.amountsOut.filter((_, i) => i != tokenToExit)).to.be.zeros;

            // Current BPT balance should decrease
            expect(await pool.balanceOf(lp)).to.equal(previousBptBalance.sub(bptIn));
          }

          async function executeVirtualOrdersExitPoolSingleTokenGivenInAndExpect(
            lp: SignerWithAddress,
            tokenToExit: number,
            currentSaleRateA: BigNumber,
            currentSaleRateB: BigNumber
          ) {
            const ammBalances: BigNumber[] = [fp(0), fp(0)];
            const currentBalances = await getLtoRemovedPoolBalances();
            const longTermBalances = await longTermOrdersContract.getLongTermOrdersBalances();

            const blockNumber = await lastBlockNumber();

            [ammBalances[0], ammBalances[1], ,] = executeVirtualOrders(
              currentBalances[0],
              currentBalances[1],
              currentSaleRateA,
              currentSaleRateB,
              longTermBalances[0],
              longTermBalances[1],
              blockNumber,
              blockNumber + 1
            );

            exitPoolSingleTokenGivenInAndExpect(sender, tokenToExit, ammBalances);
          }

          async function getLtoRemovedPoolBalances() {
            const currentBalances = await pool.getBalances();
            const longTermBalances = await longTermOrdersContract.getLongTermOrdersBalances();
            const poolBalances: BigNumber[] = [fp(0), fp(0)];

            poolBalances[0] = currentBalances[0].sub(longTermBalances[0]);
            poolBalances[1] = currentBalances[1].sub(longTermBalances[1]);

            return poolBalances;
          }
          it('can execute long term order and do join pool', async () => {
            const buyTokenIndex = 1,
              sellTokenIndex = 0,
              amount = fp(200.0),
              numberOfBlockIntervals = 100;

            const [orderPlacementBlock, saleRate] = await placeLongTermOrder(
              sender,
              sellTokenIndex,
              buyTokenIndex,
              amount,
              numberOfBlockIntervals,
              orderBlockInterval
            );

            // Join pool
            await executeVirtualOrdersJoinPoolGivenInAndExpect(
              other,
              [fp(0.1), fp(0)],
              orderPlacementBlock,
              saleRate,
              fp(0)
            );
          });

          it('can execute long term order, do join pool and then exit pool', async () => {
            const buyTokenIndex = 1,
              sellTokenIndex = 0,
              amount = fp(200.0),
              numberOfBlockIntervals = 100;

            const [orderPlacementBlock, saleRate] = await placeLongTermOrder(
              sender,
              sellTokenIndex,
              buyTokenIndex,
              amount,
              numberOfBlockIntervals,
              orderBlockInterval
            );

            // Join pool
            await executeVirtualOrdersJoinPoolGivenInAndExpect(
              other,
              [fp(0.1), fp(0)],
              orderPlacementBlock,
              saleRate,
              fp(0)
            );

            // Exit pool
            await executeVirtualOrdersExitPoolSingleTokenGivenInAndExpect(other, 0, saleRate, fp(0));
          });

          it('can place long term order, execute completely, do join pool and then exit pool', async () => {
            const buyTokenIndex = 1,
              sellTokenIndex = 0,
              amount = fp(20.0),
              numberOfBlockIntervals = 10;

            const [orderPlacementBlock] = await placeLongTermOrder(
              sender,
              sellTokenIndex,
              buyTokenIndex,
              amount,
              numberOfBlockIntervals,
              orderBlockInterval
            );
            const expiryBlock = getOrderExpiryBlock(orderBlockInterval, numberOfBlockIntervals, orderPlacementBlock);

            // Complete long term order by moving forward and doing swaps on the pool
            await doShortSwapsUntil(expiryBlock + 1, pool, owner, owner);

            let currentBalances = await getLtoRemovedPoolBalances();

            // Join pool
            await joinPoolGivenInAndExpect(other, [fp(0.1), fp(0)], currentBalances);

            currentBalances = await getLtoRemovedPoolBalances();
            // Exit pool
            await exitPoolSingleTokenGivenInAndExpect(other, 0, currentBalances);
          });

          it('can cancel one-way Long Term Order', async () => {
            const currentBlock = await block.latestBlockNumber();
            const baseBlock = currentBlock - (currentBlock % 100);

            await block.setAutomine(false);
            await block.setIntervalMining(0);

            await block.advanceTo(baseBlock + 99);

            // BLOCK 100 //////////////////////////////////////////////////////////////////////
            const longTermOrderTx = pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10, // 10*10 = 100 blocks
            });
            //////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(baseBlock + 149);

            // const startingBlock = await lastBlockNumber();
            // const expectedExpiryBlock =
            //   startingBlock % 10 ? startingBlock + 100 + (10 - (startingBlock % 10)) : startingBlock + 100;

            const longTermOrder = await longTermOrderTx;
            expectEvent.inIndirectReceipt(longTermOrder.receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              expirationBlock: baseBlock + 200,
            });

            // BLOCK 150 //////////////////////////////////////////////////////////////////////
            const cancelTx = pool.cancelLongTermOrder({ orderId: 0, from: other });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(baseBlock + 150);

            const cancelResult = await cancelTx;
            expectEvent.inIndirectReceipt(cancelResult.receipt, pool.instance.interface, 'LongTermOrderCancelled', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              proceeds: cancelResult.amountsOut[1],
              unsoldAmount: cancelResult.amountsOut[0],
            });

            expectBalanceToBeApprox(cancelResult.amountsOut[0], fp(0.5));
            expect(cancelResult.amountsOut[0]).to.be.eq(fp(0.5));
            expect(cancelResult.amountsOut[1]).to.be.lte(fpDec6(2));

            await block.setAutomine(true);
          });

          it('can execute two-way Long Term Order', async () => {
            const longTermOrder1 = await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });
            const longTermOrder2 = await pool.placeLongTermOrder({
              from: other,
              amountIn: fpDec6(0.2),
              tokenInIndex: 1,
              tokenOutIndex: 0,
              numberOfBlockIntervals: 10,
            });

            const startingBlock2 = await lastBlockNumber();
            const expectedExpiryBlock2 =
              startingBlock2 % 10 ? startingBlock2 + 100 + (10 - (startingBlock2 % 10)) : startingBlock2 + 100;

            await doShortSwapsUntil(expectedExpiryBlock2, pool, owner, other);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });

            expectEvent.inIndirectReceipt(withdrawResult.receipt, pool.instance.interface, 'LongTermOrderWithdrawn', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: other.address,
              proceeds: withdrawResult.amountsOut[1],
            });

            const withdrawResult1 = await pool.withdrawLongTermOrder({ orderId: 1, from: other });

            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            expect(withdrawResult.amountsOut[1]).to.be.gte(fpDec6(3.958));

            expect(withdrawResult1.amountsOut[0]).to.be.gte(fp(0.05));
            expect(withdrawResult1.amountsOut[1]).to.be.equal(fp(0));
          });

          it('can complete one-way Long Term Order and withdraw pool owner can withdraw fees', async () => {
            await pool.setLongTermSwapFeePercentage(owner, {
              newLongTermSwapFeePercentage: fp(0.01),
              newLongTermSwapFeeUserCutPercentage: fp(0.5),
            });

            await pool.placeLongTermOrder({
              from: other,
              amountIn: fp(1.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });

            const startingBlock = await lastBlockNumber();
            const expectedExpiryBlock =
              startingBlock % 10 ? startingBlock + 100 + (10 - (startingBlock % 10)) : startingBlock + 100;

            await doShortSwapsUntil(expectedExpiryBlock, pool, owner, other);

            const withdrawResult = await pool.withdrawLongTermOrder({ orderId: 0, from: other });
            expect(withdrawResult.amountsOut[0]).to.be.equal(fp(0));
            // 3.96 - 1% fee = 3.92
            expect(withdrawResult.amountsOut[1]).to.be.gte(fpDec6(3.92));

            await pool.withdrawLongTermOrderCollectedManagementFees(owner, owner);

            pool.instance.once('LongTermOrderManagementFeesCollected', (tokens, collectedFees, event) => {
              expect(collectedFees[0]).to.be.eq(fp(0));
              expectBalanceToBeApprox(collectedFees[1], fpDec6(0.0198));
            });

            await pool.withdrawLongTermOrderCollectedManagementFees(owner, owner);

            pool.instance.once('LongTermOrderManagementFeesCollected', (tokens, collectedFees, event) => {
              expect(collectedFees[0]).to.be.eq(fp(0));
              expect(collectedFees[0]).to.be.eq(fp(0));
            });
          });
        });
      });
    });
  });

  describe('BaseWeightedPool tests', function () {
    context('for a 2 token pool', () => {
      // Should behave as basic weighted pool if no long term orders are placed.
      itBehavesAsWeightedPool(2, WeightedPoolType.TWAMM_WEIGHTED_POOL);
    });
  });

  describe('End to End tests', () => {
    let owner: SignerWithAddress, alice: SignerWithAddress, betty: SignerWithAddress, carl: SignerWithAddress;

    beforeEach('setup signers', async () => {
      [owner, alice, betty, carl] = await ethers.getSigners();
    });

    const MAX_TOKENS = 2;
    let allTokens: TokenList, tokens: TokenList;

    let sender: SignerWithAddress;
    let pool: WeightedPool;
    const weights = [fp(0.5), fp(0.5)];
    // 200k DAI, 100 ETH
    const initialBalances = [fp(200000.0), fp(100.0)];

    let longTermOrdersContract: Contract;

    context('when initialized with swaps enabled', () => {
      sharedBeforeEach('deploy pool', async () => {
        allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
        tokens = allTokens.subset(2);
        await tokens.mint({ to: [owner, alice, betty, carl], amount: fp(600000.0) });
      });

      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            await ethers.provider.send('hardhat_reset', []);
            [owner, alice, betty, carl] = await ethers.getSigners();
            allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
            tokens = allTokens.subset(2);
            await tokens.mint({ to: [owner, alice, betty, carl], amount: fp(300000.0) });

            const params = {
              tokens,
              weights,
              owner: owner.address,
              poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
              swapEnabledOnStart: true,
              orderBlockInterval: 5,
              fromFactory: true,
            };
            pool = await WeightedPool.create(params);
            longTermOrdersContract = await deployedAt('LongTermOrders', await pool.getLongTermOrderContractAddress());
            sender = owner;

            tokens = allTokens.subset(2);
            await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, alice, betty, carl] });

            await pool.init({ from: owner, initialBalances });
          });

          it('Matches predicted constant product formula predicted values', async () => {
            await block.setAutomine(false);
            await block.setIntervalMining(0);

            await block.advanceTo(99);

            // BLOCK 100 //////////////////////////////////////////////////////////////////////
            // Alice puts in an order to buy 1,000 DAI worth of ETH over the next 100 blocks
            const tx1 = pool.placeLongTermOrder({
              from: alice,
              amountIn: fp(1000.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 20, // 20*5 = 100 blocks
            });

            // Betty puts in an order to buy 2,000 DAI worth of ETH over the next 50 blocks
            pool.placeLongTermOrder({
              from: betty,
              amountIn: fp(2000.0),
              tokenInIndex: 0,
              tokenOutIndex: 1,
              numberOfBlockIntervals: 10,
            });
            //////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(124);

            expectEvent.inIndirectReceipt((await tx1).receipt, pool.instance.interface, 'LongTermOrderPlaced', {
              orderId: 0,
              sellTokenIndex: 0,
              buyTokenIndex: 1,
              owner: alice.address,
              expirationBlock: 200,
            });

            // BLOCK 125 //////////////////////////////////////////////////////////////////////
            swap(pool, 1, 0, fp(0.62423925741878552), owner, owner);
            pool.placeLongTermOrder({
              from: carl,
              amountIn: fp(2.0),
              tokenInIndex: 1,
              tokenOutIndex: 0,
              numberOfBlockIntervals: 20,
            });
            //////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(125);

            // Spot price = fp(2000)
            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            let lto0 = await pool.getLongTermOrder(0);
            const lto1 = await pool.getLongTermOrder(1);

            expectBalanceToBeApprox(lto0.boughtAmount, fp(0.124));
            expectBalanceToBeApprox(lto1.boughtAmount, fp(0.497));

            await block.advanceTo(149);

            // BLOCK 150 //////////////////////////////////////////////////////////////////////
            swap(pool, 1, 0, fp(0.12484657552742167), owner, owner);
            const withdrawTx1 = pool.withdrawLongTermOrder({ orderId: 1, from: betty });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(150);

            // Spot price = fp(2000)
            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            lto0 = await pool.getLongTermOrder(0);
            let lto2 = await pool.getLongTermOrder(2);

            expectBalanceToBeApprox(lto0.boughtAmount, fp(0.249));
            expect((await withdrawTx1).amountsOut[0]).to.be.equal(0);
            expectBalanceToBeApprox((await withdrawTx1).amountsOut[1], fp(0.996));
            expectBalanceToBeApprox(lto2.boughtAmount, fp(1001.246));

            await block.advanceTo(199);

            // BLOCK 200 //////////////////////////////////////////////////////////////////////
            swap(pool, 0, 1, fp(1492.59995191032122), owner, owner);
            const withdrawTx0 = pool.withdrawLongTermOrder({ orderId: 0, from: alice });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(200);

            // Spot price = fp(2000)
            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            expect((await withdrawTx0).amountsOut[0]).to.be.equal(0);
            expectBalanceToBeApprox((await withdrawTx0).amountsOut[1], fp(0.501));
            lto2 = await pool.getLongTermOrder(2);
            expectBalanceToBeApprox(lto2.boughtAmount, fp(2986.383));

            await block.advanceTo(224);

            // BLOCK 225 //////////////////////////////////////////////////////////////////////
            swap(pool, 0, 1, fp(1000.02525), owner, owner);
            const withdrawTx2 = pool.withdrawLongTermOrder({ orderId: 2, from: carl });
            ///////////////////////////////////////////////////////////////////////////////////

            await delay(1 * 200);
            await block.advanceTo(225);

            expectBalanceToBeApprox(await estimateSpotPrice(pool, longTermOrdersContract), fp(2000));

            expect((await withdrawTx2).amountsOut[1]).to.be.equal(0);
            expectBalanceToBeApprox((await withdrawTx2).amountsOut[0], fp(3981.408));

            await block.setAutomine(true);
          });
        });
      });
    });

    context('gas tracking', () => {
      describe('permissioned actions', () => {
        context('when the sender is the owner', () => {
          sharedBeforeEach('set sender to owner', async () => {
            allTokens = await TokenList.create(MAX_TOKENS + 1, { sorted: true });
            tokens = allTokens.subset(2);
            await tokens.mint({ to: [owner, alice, betty, carl], amount: fp(600000.0) });

            const params = {
              tokens,
              weights,
              owner: owner.address,
              poolType: WeightedPoolType.TWAMM_WEIGHTED_POOL,
              swapEnabledOnStart: true,
              orderBlockInterval: 5,
              fromFactory: true,
            };
            pool = await WeightedPool.create(params);
            longTermOrdersContract = await deployedAt('LongTermOrders', await pool.getLongTermOrderContractAddress());
            sender = owner;

            tokens = allTokens.subset(2);
            await tokens.approve({ to: pool.vault.address, amount: MAX_UINT256, from: [owner, alice, betty, carl] });
            await pool.init({ from: owner, initialBalances });
          });

          const total = 10;
          for (let n = total; n <= total; n++) {
            it(`can execute n orders: ${n}`, async () => {
              await block.setAutomine(false);
              await block.setIntervalMining(0);

              const txs: any[] = [];
              // BLOCK 100 //////////////////////////////////////////////////////////////////////
              // Alice puts in an order to buy 1,000 DAI worth of ETH over the next 100 blocks
              for (let i = 0; i < n; i++) {
                txs.push(
                  pool.placeLongTermOrder({
                    from: alice,
                    amountIn: fp(1000.0),
                    tokenInIndex: 0,
                    tokenOutIndex: 1,
                    numberOfBlockIntervals: (i % 20) + 1, // 20*5 = 100 blocks
                  })
                );
              }
              // //////////////////////////////////////////////////////////////////////////////////

              await delay(1 * 200);
              await block.advance(550);

              for (let i = 0; i < n; i++) {
                const result = await txs[i];
              }

              const withdrawTxs: any[] = [];
              // BLOCK 225 //////////////////////////////////////////////////////////////////////
              for (let i = 0; i < n; i++) {
                withdrawTxs.push(pool.withdrawLongTermOrder({ orderId: i, from: alice }));
              }
              ///////////////////////////////////////////////////////////////////////////////////

              await delay(1 * 200);
              await block.advance(20);

              for (let i = 0; i < n; i++) {
                const result = await withdrawTxs[i];
              }

              await block.setAutomine(true);
            });
          }
          // TODO: Add test, on withdraw, cancel, remove fees, invariant should remain same
        });
      });
    });
  });
});
