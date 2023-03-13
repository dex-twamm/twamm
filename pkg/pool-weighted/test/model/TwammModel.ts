import WeightedPool from '@balancer-labs/v2-helpers/src/models/pools/weighted/WeightedPool';
import { decimal, fp, fromFp } from '@balancer-labs/v2-helpers/src/numbers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';

import Decimal from 'decimal.js';
import { BigNumber } from 'ethers';
import { testUtils } from 'hardhat';
import { convertAmountsArrayToBn } from './ModelUtils';
const { block } = testUtils;

export interface Contracts {
  pool: WeightedPool;
  wallets: SignerWithAddress[];
}

type BigNumberish = string | number | BigNumber;

const ZERO = decimal(0);

export class Order {
  constructor(
    public id: number,
    public expirationBlock: number,
    public saleRate: Decimal,
    public owner: string,
    public sellTokenIndex: number,
    public buyTokenIndex: number,
    public withdrawn: boolean = false
  ) {}
}

export class OrderPool {
  constructor(
    public currentSalesRate: Decimal = ZERO,
    public rewardFactor: Decimal = ZERO,
    public salesRateEndingPerBlock: { [Key: number]: Decimal } = {},
    public rewardFactorAtSubmission: { [Key: number]: Decimal } = {},
    public rewardFactorAtBlock: { [Key: number]: Decimal } = {},
    public ordersExpiringAtBlock: { [Key: number]: number } = {}
  ) {}

  cancelOrder(orderId: number, lastVirtualOrderBlock: number, orderSaleRate: Decimal, orderExpiryBlock: number) {
    expect(orderExpiryBlock).gte(lastVirtualOrderBlock);
    const result = {
      unsoldAmount: ZERO,
      purchasedAmount: ZERO,
    };

    const blocksRemaining = orderExpiryBlock - lastVirtualOrderBlock;
    result.unsoldAmount = orderSaleRate.mul(blocksRemaining);
    const rewardFactorAtSubmission = this.rewardFactorAtSubmission[orderId];
    result.purchasedAmount = this.rewardFactor.sub(rewardFactorAtSubmission).mul(orderSaleRate);

    this.currentSalesRate = this.currentSalesRate.sub(orderSaleRate);
    this.salesRateEndingPerBlock[orderExpiryBlock] = this.salesRateEndingPerBlock[orderExpiryBlock].sub(orderSaleRate);
    this.ordersExpiringAtBlock[orderExpiryBlock] -= 1;

    return result;
  }

  depositOrder(orderId: number, amountPerBlock: Decimal, orderExpiryBlock: number): void {
    this.currentSalesRate = this.currentSalesRate.add(amountPerBlock);
    this.rewardFactorAtSubmission[orderId] = this.rewardFactor;
    const salesRateEndingOnBlock = this.salesRateEndingPerBlock[orderExpiryBlock] || ZERO;
    this.salesRateEndingPerBlock[orderExpiryBlock] = salesRateEndingOnBlock.add(amountPerBlock);
    this.ordersExpiringAtBlock[orderExpiryBlock] += 1;
  }

  distributePayment(amount: Decimal): void {
    if (this.currentSalesRate.gt(0)) {
      this.rewardFactor = this.rewardFactor.add(amount.div(this.currentSalesRate));
    }
  }

  updateStateFromBlockExpiry(blockNumber: number): void {
    const expiringSalesRate = this.salesRateEndingPerBlock[blockNumber] || ZERO;
    this.currentSalesRate = this.currentSalesRate.sub(expiringSalesRate);
    this.rewardFactorAtBlock[blockNumber] = this.rewardFactor;
  }

  withdrawProceeds(orderId: number, lastVirtualOrderBlock: number, orderSaleRate: Decimal, orderExpiryBlock: number) {
    const result = {
      proceeds: ZERO,
      isPartialWithdrawal: false,
    };
    const rewardFactorAtSubmission = this.rewardFactorAtSubmission[orderId];
    // If order has expired, we need to calculate the reward factor at expiry
    if (lastVirtualOrderBlock >= orderExpiryBlock) {
      const rewardFactorAtExpiry = this.rewardFactorAtBlock[orderExpiryBlock];
      result.proceeds = rewardFactorAtExpiry.sub(rewardFactorAtSubmission).mul(orderSaleRate);
      result.isPartialWithdrawal = false;
      this.ordersExpiringAtBlock[orderExpiryBlock] = this.ordersExpiringAtBlock[orderExpiryBlock] - 1;
    } else {
      // If order has not yet expired (i.e. partial withdrawal), we just adjust the start.
      result.proceeds = this.rewardFactor.sub(rewardFactorAtSubmission).mul(orderSaleRate);
      this.rewardFactorAtSubmission[orderId] = this.rewardFactor;
      result.isPartialWithdrawal = true;
    }
    if (result['proceeds'] === new Decimal(0)) {
      throw new Error('BAL#349');
    }

    return result;
  }
}

export class TwammModel {
  lps: { [Key: string]: Decimal } = {};
  tokenBalances = [decimal(100.0), decimal(400.0)];
  lastInvariant = decimal(200.0);
  collectedManagementFees = [decimal(0), decimal(0)];
  wallets: SignerWithAddress[];
  isVirtualOrderExecutionPaused: boolean;

  longTermBalances = [ZERO, ZERO];
  currentSalesRate = [ZERO, ZERO]; // TODO: create and move to separate orderPool class
  lastOrderId = 0;
  lastVirtualOrderBlock = 0;
  orderBlockInterval: number;
  orderExpiryBlocks: Set<number> = new Set();
  orderPoolMap: { [Key: number]: OrderPool }; // TODO: add Order class and create id->order mapping.
  orderMap: { [Key: number]: Order };

  constructor(wallets: SignerWithAddress[], orderBlockInterval: number, ownerBalance: Decimal) {
    this.wallets = wallets;
    wallets.map((wallet) => (this.lps[wallet.address] = ZERO));
    this.lps[wallets[0].address] = ownerBalance;
    this.orderBlockInterval = orderBlockInterval;
    this.orderPoolMap = { 0: new OrderPool(), 1: new OrderPool() };
    this.orderMap = {};
    this.isVirtualOrderExecutionPaused = false;
  }

  async calcOrderExpiry(numberOfBlockIntervals: number): Promise<number> {
    const mod = ((await block.latestBlockNumber()) + 1) % this.orderBlockInterval;
    if (mod > 0) {
      numberOfBlockIntervals += 1;
    }
    const numberOfBlocks = this.orderBlockInterval * numberOfBlockIntervals - mod;
    return (await block.latestBlockNumber()) + 1 + numberOfBlocks;
  }

  nextExpiryBlock(): number {
    return Array.from(this.orderExpiryBlocks).sort((a, b) => a - b)[0];
  }

  _computeAmmEndTokenA(tokenAIn: Decimal, tokenBIn: Decimal): Decimal {
    const k = this.tokenBalances[0].mul(this.tokenBalances[1]);
    const ePow = tokenAIn.mul(tokenBIn).mul(4).div(k).pow(0.5);
    // let ePow = fp(4).mul(tokenAIn).mul(tokenBIn).div(k).pow(0.5);
    const exponent = ePow.exp();

    const c = this._computeC(tokenAIn, tokenBIn);
    const fraction = exponent.add(c).div(exponent.sub(c));
    const scaling = tokenAIn.mul(k).div(tokenBIn).pow(0.5);
    return fraction.mul(scaling);
  }

  _computeC(tokenAIn: Decimal, tokenBIn: Decimal): Decimal {
    const c1 = this.tokenBalances[0].mul(tokenBIn).pow(0.5);
    const c2 = this.tokenBalances[1].mul(tokenAIn).pow(0.5);
    const cNumerator = c1.sub(c2);
    const cDenominator = c1.add(c2);

    // TODO: verify this.
    return cNumerator.div(cDenominator);
  }

  _computeVirtualBalances(tokenAIn: Decimal, tokenBIn: Decimal) {
    let tokenAOut = ZERO,
      tokenBOut = ZERO;
    if (tokenAIn.eq(ZERO)) {
      // Only one pool is selling, we just perform a normal swap
      this.tokenBalances[1] = this.tokenBalances[1].add(tokenBIn);
      tokenAOut = this.tokenBalances[0].mul(tokenBIn).div(this.tokenBalances[1]);
      this.tokenBalances[0] = this.tokenBalances[0].sub(tokenAOut);
    } else if (tokenBIn.eq(ZERO)) {
      // Only one pool is selling, we just perform a normal swap
      this.tokenBalances[0] = this.tokenBalances[0].add(tokenAIn);
      tokenBOut = this.tokenBalances[1].mul(tokenAIn).div(this.tokenBalances[0]);
      this.tokenBalances[1] = this.tokenBalances[1].sub(tokenBOut);
    } else {
      // When both pools sell, we use the TWAMM formula
      const tokenAStart = this.tokenBalances[0];
      const tokenBStart = this.tokenBalances[1];
      this.tokenBalances[0] = this._computeAmmEndTokenA(tokenAIn, tokenBIn);
      this.tokenBalances[1] = tokenAStart.div(this.tokenBalances[0]).mul(tokenBStart);
      tokenAOut = tokenAStart.add(tokenAIn).sub(this.tokenBalances[0]);
      tokenBOut = tokenBStart.add(tokenBIn).sub(this.tokenBalances[1]);
    }
    return [tokenAOut, tokenBOut];
  }

  _deductProtocolFees(purchasedAmounts: Decimal[]): Decimal[] {
    for (let i = 0; i < 2; i++) {
      const fee = purchasedAmounts[i].mul(0.0025);
      this.tokenBalances[i] = this.tokenBalances[i].add(fee);
      purchasedAmounts[i] = purchasedAmounts[i].sub(fee);
    }
    return purchasedAmounts;
  }

  async _sendDueProtocolFees(pool: WeightedPool): Promise<void> {
    const fee = fromFp(
      await pool.estimateSwapFeeAmount(0, fp(0.5), this.tokenBalances.map(fp), fp(this.lastInvariant))
    );
    this.tokenBalances[0] = this.tokenBalances[0].sub(fee);
    this.collectedManagementFees[0] = this.collectedManagementFees[0].add(fee.div(2));
  }

  async _updateLastInvariant(pool: WeightedPool): Promise<void> {
    this.lastInvariant = fromFp(await pool.estimateInvariant(this.tokenBalances.map(fp)));
  }

  async collectLtoManagementFees(pool: WeightedPool): Promise<Decimal> {
    if (!this.isVirtualOrderExecutionPaused) {
      await this.executeVirtualOrders();
    }

    const collectedFees = this.collectedManagementFees[0];
    this.collectedManagementFees[0] = decimal(0);

    // New Lto collected fee gets updated at the end of collectLtoManagementFee operation.
    await this._sendDueProtocolFees(pool);
    await this._updateLastInvariant(pool);
    return collectedFees;
  }

  async pauseVirtualOrderExecution(newVirtualOrderExecutionState: boolean): Promise<void> {
    this.isVirtualOrderExecutionPaused = newVirtualOrderExecutionState;
  }

  _executeVirtualTradesUntilBlock(blockNumber: number, isExpiryBlock = false): void {
    const blockNumberIncrement = blockNumber - this.lastVirtualOrderBlock;
    const tokenASellAmount = this.orderPoolMap[0].currentSalesRate.mul(blockNumberIncrement);
    const tokenBSellAmount = this.orderPoolMap[1].currentSalesRate.mul(blockNumberIncrement);

    let tokensOut = this._computeVirtualBalances(tokenASellAmount, tokenBSellAmount);
    tokensOut = this._deductProtocolFees(tokensOut);

    this.longTermBalances[0] = this.longTermBalances[0].add(tokensOut[0]).sub(tokenASellAmount);
    this.longTermBalances[1] = this.longTermBalances[1].add(tokensOut[1]).sub(tokenBSellAmount);
    this.orderPoolMap[0].distributePayment(tokensOut[1]);
    this.orderPoolMap[1].distributePayment(tokensOut[0]);

    if (isExpiryBlock) {
      this.orderPoolMap[0].updateStateFromBlockExpiry(blockNumber);
      this.orderPoolMap[1].updateStateFromBlockExpiry(blockNumber);
    }
    this.lastVirtualOrderBlock = blockNumber;
  }

  async executeVirtualOrders(): Promise<void> {
    const currentBlock = (await block.latestBlockNumber()) + 1;
    if (this.lastVirtualOrderBlock >= currentBlock) return;

    while (this.orderExpiryBlocks.size > 0) {
      const nextExpiryBlock = this.nextExpiryBlock();

      if (nextExpiryBlock >= currentBlock) {
        // Jump to current block.
        this._executeVirtualTradesUntilBlock(currentBlock, nextExpiryBlock == currentBlock);
        if (nextExpiryBlock == currentBlock) {
          this.orderExpiryBlocks.delete(currentBlock);
        }
        break;
      } else {
        // Jump to next order expiry block.
        this._executeVirtualTradesUntilBlock(nextExpiryBlock, true);
        this.orderExpiryBlocks.delete(nextExpiryBlock);
      }
    }

    if (this.orderExpiryBlocks.size == 0) this.lastVirtualOrderBlock = currentBlock;
  }

  async placeLto(
    pool: WeightedPool,
    amountIn: Decimal,
    tokenIndexIn: number,
    numberOfBlockIntervals: number,
    walletNo: number
  ): Promise<void> {
    if (this.isVirtualOrderExecutionPaused) {
      throw new Error('BAL#354');
    }

    await this.preJoinExitPool(pool);

    const orderId = this.lastOrderId;
    const orderExpiryBlock = await this.calcOrderExpiry(numberOfBlockIntervals);
    const numberOfBlocks = orderExpiryBlock - (await block.latestBlockNumber()) - 1;
    const sellingRate = amountIn.div(numberOfBlocks);

    this.orderExpiryBlocks.add(orderExpiryBlock);
    this.orderPoolMap[tokenIndexIn].depositOrder(orderId, sellingRate, orderExpiryBlock);
    // TODO: fail if new sales rate too high.
    this.orderMap[orderId] = new Order(
      orderId,
      orderExpiryBlock,
      sellingRate,
      this.wallets[walletNo].address,
      tokenIndexIn,
      1 - tokenIndexIn
    );

    this.longTermBalances[tokenIndexIn] = this.longTermBalances[tokenIndexIn].add(amountIn);
    await this._updateLastInvariant(pool);

    this.lastOrderId += 1;
  }

  async withdrawLto(pool: WeightedPool, orderId: number) {
    await this.preJoinExitPool(pool);

    const order = this.orderMap[orderId];
    // TODO: fail if order owner is not caller.
    const orderPool = this.orderPoolMap[order.sellTokenIndex];
    const withdrawResult = orderPool.withdrawProceeds(
      orderId,
      this.lastVirtualOrderBlock,
      order.saleRate,
      order.expirationBlock
    );
    this.longTermBalances[order.buyTokenIndex] = this.longTermBalances[order.buyTokenIndex].sub(
      withdrawResult.proceeds
    );

    if (!withdrawResult.isPartialWithdrawal) this.orderMap[orderId].withdrawn = true;
    await this._updateLastInvariant(pool);
    return {
      order: order,
      ...withdrawResult,
    };
  }

  async cancelLto(pool: WeightedPool, orderId: number) {
    await this.preJoinExitPool(pool);

    const order = this.orderMap[orderId];
    // TODO: fail if order owner is not caller.
    const orderPool = this.orderPoolMap[order.sellTokenIndex];
    const cancelResult = orderPool.cancelOrder(
      orderId,
      this.lastVirtualOrderBlock,
      order.saleRate,
      order.expirationBlock
    );
    this.longTermBalances[order.buyTokenIndex] = this.longTermBalances[order.buyTokenIndex].sub(
      cancelResult.purchasedAmount
    );
    this.longTermBalances[order.sellTokenIndex] = this.longTermBalances[order.sellTokenIndex].sub(
      cancelResult.unsoldAmount
    );

    this.orderMap[orderId].withdrawn = true;
    await this._updateLastInvariant(pool);
    return {
      order: order,
      ...cancelResult,
    };
  }

  // Swap
  async swapGivenIn(pool: WeightedPool, tokenIn: number, amountIn: BigNumberish): Promise<BigNumberish> {
    await this.swapPreHook();

    const amountOut = await pool.estimateGivenIn(
      { in: tokenIn, out: 1 - tokenIn, amount: amountIn },
      convertAmountsArrayToBn(this.tokenBalances)
    );

    if (this.tokenBalances[1 - tokenIn].div(0.3).lessThan(decimal(amountOut))) {
      throw new Error('BAL#305');
    }

    await this.swapPostHook(tokenIn, amountIn, amountOut);

    return amountOut;
  }

  async swapGivenOut(pool: WeightedPool, tokenOut: number, amountOut: BigNumberish): Promise<BigNumberish> {
    await this.swapPreHook();

    const amountIn = await pool.estimateGivenOut(
      { in: tokenOut, out: 1 - tokenOut, amount: amountOut },
      convertAmountsArrayToBn(this.tokenBalances)
    );

    if (this.tokenBalances[1 - tokenOut].div(0.3).lessThan(decimal(amountIn))) {
      throw new Error('BAL#305');
    }

    await this.swapPostHook(1 - tokenOut, amountIn, amountOut);

    return amountOut;
  }

  // Swap pre/post hooks
  async swapPreHook(): Promise<void> {
    if (!this.isVirtualOrderExecutionPaused) {
      await this.executeVirtualOrders();
    }
  }

  async swapPostHook(tokenIn: number, amountIn: BigNumberish, amountOut: BigNumberish): Promise<void> {
    this.tokenBalances[tokenIn].add(fromFp(amountIn));
    this.tokenBalances[1 - tokenIn].sub(fromFp(amountOut));
  }

  // Join Pool
  async joinGivenIn(pool: WeightedPool, wallet: SignerWithAddress, amountsIn: Array<number>): Promise<BigNumberish> {
    await this.preJoinExitPool(pool);

    const mockBptOut = await pool.estimateBptOut(convertAmountsArrayToBn(amountsIn), this.tokenBalances.map(fp));

    await this.postJoinPool(pool, wallet, fromFp(mockBptOut), amountsIn);

    return mockBptOut;
  }

  async joinGivenOut(
    pool: WeightedPool,
    wallet: SignerWithAddress,
    bptOut: number,
    tokenIndex: number
  ): Promise<BigNumberish> {
    await this.preJoinExitPool(pool);

    const amountIn = await pool.estimateTokenIn(tokenIndex, bptOut, convertAmountsArrayToBn(this.tokenBalances));

    const tokensIn: Array<BigNumberish> = new Array(2).fill(0);
    tokensIn[tokenIndex] = amountIn;

    await this.postJoinPool(pool, wallet, fromFp(bptOut), tokensIn);

    return amountIn;
  }

  // Exit Pool
  async multiExitGivenIn(pool: WeightedPool, wallet: SignerWithAddress, bptIn: Decimal): Promise<Array<BigNumberish>> {
    await this.preJoinExitPool(pool);

    const mockTokensOut = await pool.estimateTokensOutBptIn(fp(bptIn), this.tokenBalances.map(fp));

    await this.postExitPool(pool, wallet, bptIn, mockTokensOut);

    return mockTokensOut;
  }

  async singleTokenExitGivenIn(
    pool: WeightedPool,
    wallet: SignerWithAddress,
    bptIn: Decimal,
    tokenIndex: number
  ): Promise<BigNumberish> {
    await this.preJoinExitPool(pool);

    const tokenOut = await pool.estimateTokenOut(tokenIndex, fp(bptIn), convertAmountsArrayToBn(this.tokenBalances));

    const tokensOut: Array<BigNumberish> = new Array(2).fill(0);
    tokensOut[tokenIndex] = tokenOut;

    await this.postExitPool(pool, wallet, bptIn, tokensOut);

    return tokenOut;
  }

  // Pre/Post Exit/Join hook functions
  async preJoinExitPool(pool: WeightedPool): Promise<void> {
    if (!this.isVirtualOrderExecutionPaused) {
      await this.executeVirtualOrders();
    }
    await this._sendDueProtocolFees(pool);
  }

  async postExitPool(
    pool: WeightedPool,
    wallet: SignerWithAddress,
    bptIn: Decimal,
    tokensOut: Array<BigNumberish>
  ): Promise<void> {
    // Update token balances.
    this.tokenBalances = this.tokenBalances.map(function (num, idx) {
      return num.sub(fromFp(tokensOut[idx]));
    });

    await this._updateLastInvariant(pool);

    // Update LP bpt balance
    this.lps[wallet.address] = this.lps[wallet.address].sub(bptIn);
  }

  async postJoinPool(
    pool: WeightedPool,
    wallet: SignerWithAddress,
    bptOut: Decimal,
    tokensIn: Array<BigNumberish>
  ): Promise<void> {
    // Update LP bpt balance
    if (!this.lps[wallet.address]) this.lps[wallet.address] = ZERO;
    this.lps[wallet.address] = this.lps[wallet.address].add(bptOut);

    // Update token balances.
    this.tokenBalances = this.tokenBalances.map(function (num, idx) {
      return num.add(fromFp(tokensIn[idx]));
    });

    await this._updateLastInvariant(pool);
  }
}
