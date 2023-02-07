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
  pool: WeightedPool,
  wallet: SignerWithAddress
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
    public withdrawn: boolean = false) {
  }
}

export class OrderPool {
  constructor(
    public currentSalesRate: Decimal = ZERO,
    public rewardFactor: Decimal = ZERO,
    public salesRateEndingPerBlock: { [Key: number]: Decimal } = {},
    public rewardFactorAtSubmission: { [Key: number]: Decimal } = {},
    public rewardFactorAtBlock: { [Key: number]: Decimal } = {},
    public ordersExpiringAtBlock: { [Key: number]: number } = {}) {
  }

  cancelOrder(orderId: number, lastVirtualOrderBlock: number, orderSaleRate: Decimal, orderExpiryBlock: number) {
    expect(orderExpiryBlock).gte(lastVirtualOrderBlock);
    let result = {
      unsoldAmout: ZERO,
      purchasedAmount: ZERO
    } 

    const blocksRemaining = orderExpiryBlock - lastVirtualOrderBlock;
    result.unsoldAmout = orderSaleRate.mul(blocksRemaining);
    const rewardFactorAtSubmission = this.rewardFactorAtSubmission[orderId];
    result.purchasedAmount = this.rewardFactor.sub(rewardFactorAtSubmission).mul(orderSaleRate);

    this.currentSalesRate = this.currentSalesRate.sub(orderSaleRate);
    this.salesRateEndingPerBlock[orderExpiryBlock] = this.salesRateEndingPerBlock[orderExpiryBlock].sub(orderSaleRate);
    this.ordersExpiringAtBlock[orderExpiryBlock] -= 1;

    return result;
  }

  depositOrder(orderId: number, amountPerBlock: Decimal, orderExpiryBlock: number) {
    this.currentSalesRate = this.currentSalesRate.add(amountPerBlock);
    this.rewardFactorAtSubmission[orderId] = this.rewardFactor;
    let salesRateEndingOnBlock = this.salesRateEndingPerBlock[orderExpiryBlock] || ZERO;
    this.salesRateEndingPerBlock[orderExpiryBlock] = salesRateEndingOnBlock.add(
      amountPerBlock
    );
    this.ordersExpiringAtBlock[orderExpiryBlock] += 1;
  }

  distributePayment(amount: Decimal) {
    if(this.currentSalesRate.gt(0)) {
      this.rewardFactor = this.rewardFactor.add(amount.div(this.currentSalesRate));
    }
  }

  updateStateFromBlockExpiry(blockNumber: number) {
    let expiringSalesRate = this.salesRateEndingPerBlock[blockNumber] || ZERO;
    this.currentSalesRate = this.currentSalesRate.sub(expiringSalesRate);
    this.rewardFactorAtBlock[blockNumber] = this.rewardFactor;
  }

  withdrawProceeds(orderId: number, lastVirtualOrderBlock: number, orderSaleRate: Decimal, orderExpiryBlock: number) {
    let result = {
      proceeds: ZERO,
      isPartialWithdrawal: false
    } 
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

    return result;
  }
}


export class TwammModel {
  lps: { [Key: string]: Decimal } = {};
  tokenBalances = [decimal(100.0), decimal(400.0)];
  wallet: SignerWithAddress;

  longTermBalances = [ZERO, ZERO];
  currentSalesRate = [ZERO, ZERO]; // TODO: create and move to separate orderPool class
  lastOrderId = 0;
  lastVirtualOrderBlock = 0;
  orderBlockInterval: number;
  orderExpiryBlocks: Set<number> = new Set();
  orderPoolMap: { [Key: number]: OrderPool };  // TODO: add Order class and create id->order mapping.
  orderMap: { [Key: number]: Order };

  constructor(wallet: SignerWithAddress, orderBlockInterval: number) {
    this.wallet = wallet;
    this.lps[wallet.address] = ZERO;
    this.orderBlockInterval = orderBlockInterval;
    this.orderPoolMap = { 0: new OrderPool(), 1: new OrderPool() };
    this.orderMap = {};
  }

  async calcOrderExpiry(numberOfBlockIntervals: number) {
    let mod = (await block.latestBlockNumber() + 1) % this.orderBlockInterval;
    if (mod > 0) {
      numberOfBlockIntervals += 1;
    }
    let numberOfBlocks = (this.orderBlockInterval * numberOfBlockIntervals) - mod;
    return (await block.latestBlockNumber() + 1) + numberOfBlocks;
  }

  nextExpiryBlock(): number {
    return Array.from(this.orderExpiryBlocks).sort((a, b) => a - b)[0];
  }

  _computeAmmEndTokenA(tokenAIn: Decimal, tokenBIn: Decimal) {
    let k = this.tokenBalances[0].mul(this.tokenBalances[1]);
    let ePow = tokenAIn.mul(tokenBIn).mul(4).div(k).pow(0.5);
    // let ePow = fp(4).mul(tokenAIn).mul(tokenBIn).div(k).pow(0.5);
    let exponent = ePow.exp();

    let c = this._computeC(tokenAIn, tokenBIn);
    let fraction = (exponent.add(c)).div(exponent.sub(c));
    let scaling = tokenAIn.mul(k).div(tokenBIn).pow(0.5);
    return fraction.mul(scaling);
  }

  _computeC(tokenAIn: Decimal, tokenBIn: Decimal) {
    let c1 = this.tokenBalances[0].mul(tokenBIn).pow(0.5);
    let c2 = this.tokenBalances[1].mul(tokenAIn).pow(0.5);
    let cNumerator = c1.sub(c2);
    let cDenominator = c1.add(c2);

    // TODO: verify this.
    return cNumerator.div(cDenominator);
  }

  _computeVirtualBalances(tokenAIn: Decimal, tokenBIn: Decimal) {
    let tokenAOut = ZERO, tokenBOut = ZERO;
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
      let tokenAStart = this.tokenBalances[0];
      let tokenBStart = this.tokenBalances[1];
      this.tokenBalances[0] = this._computeAmmEndTokenA(tokenAIn, tokenBIn);
      this.tokenBalances[1] = tokenAStart.div(this.tokenBalances[0]).mul(tokenBStart);
      tokenAOut = tokenAStart.add(tokenAIn).sub(this.tokenBalances[0]);
      tokenBOut = tokenBStart.add(tokenBIn).sub(this.tokenBalances[1]);
    }
    return {
      tokenAOut: tokenAOut,
      tokenBOut: tokenBOut
    }
  }

  _executeVirtualTradesUntilBlock(blockNumber: number, isExpiryBlock: boolean = false) {
    let blockNumberIncrement = blockNumber - this.lastVirtualOrderBlock;
    let tokenASellAmount = this.orderPoolMap[0].currentSalesRate.mul(blockNumberIncrement);
    let tokenBSellAmount = this.orderPoolMap[1].currentSalesRate.mul(blockNumberIncrement);

    let {tokenAOut, tokenBOut} = this._computeVirtualBalances(tokenASellAmount, tokenBSellAmount);
    this.longTermBalances[0] = this.longTermBalances[0].add(tokenAOut).sub(tokenASellAmount);
    this.longTermBalances[1] = this.longTermBalances[1].add(tokenBOut).sub(tokenBSellAmount);
    this.orderPoolMap[0].distributePayment(tokenBOut);
    this.orderPoolMap[1].distributePayment(tokenAOut);

    if(isExpiryBlock) {
      this.orderPoolMap[0].updateStateFromBlockExpiry(blockNumber);
      this.orderPoolMap[1].updateStateFromBlockExpiry(blockNumber);
    }
    this.lastVirtualOrderBlock = blockNumber;
  }

  async executeVirtualOrders() {
    let currentBlock = await block.latestBlockNumber() + 1;
    if(this.lastVirtualOrderBlock >= currentBlock) return;

    while(this.orderExpiryBlocks.size > 0) {
      let nextExpiryBlock = this.nextExpiryBlock();
      
      if(nextExpiryBlock >= currentBlock) {
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

    if(this.orderExpiryBlocks.size == 0) this.lastVirtualOrderBlock = currentBlock;
  }

  async placeLto(amountIn: Decimal, tokenIndexIn: number, numberOfBlockIntervals: number) {
    await this.executeVirtualOrders();
    let orderId = this.lastOrderId;
    let orderExpiryBlock = await this.calcOrderExpiry(numberOfBlockIntervals);
    let numberOfBlocks = orderExpiryBlock - await block.latestBlockNumber() - 1;
    let sellingRate = amountIn.div(numberOfBlocks);

    this.orderExpiryBlocks.add(orderExpiryBlock);
    this.orderPoolMap[tokenIndexIn].depositOrder(orderId, sellingRate, orderExpiryBlock);
    // TODO: fail if new sales rate too high.
    this.orderMap[orderId] = new Order(orderId, orderExpiryBlock, sellingRate, this.wallet.address, tokenIndexIn, 1 - tokenIndexIn);

    this.longTermBalances[tokenIndexIn] = this.longTermBalances[tokenIndexIn].add(amountIn);

    this.lastOrderId += 1;
  }

  async withdrawLto(orderId: number) {
    await this.executeVirtualOrders();
    const order = this.orderMap[orderId];
    // TODO: fail if order owner is not caller.
    const orderPool = this.orderPoolMap[order.sellTokenIndex];
    const withdrawResult = orderPool.withdrawProceeds(orderId, this.lastVirtualOrderBlock, order.saleRate, order.expirationBlock);
    this.longTermBalances[order.buyTokenIndex] = this.longTermBalances[order.buyTokenIndex].sub(withdrawResult.proceeds);

    if(!withdrawResult.isPartialWithdrawal) this.orderMap[orderId].withdrawn = true;
    return {
      order: order,
      ...withdrawResult
    }
  }

  async cancelLto(orderId: number) {
    await this.executeVirtualOrders();
    const order = this.orderMap[orderId];
    // TODO: fail if order owner is not caller.
    const orderPool = this.orderPoolMap[order.sellTokenIndex];
    const cancelResult = orderPool.cancelOrder(orderId, this.lastVirtualOrderBlock, order.saleRate, order.expirationBlock);
    this.longTermBalances[order.buyTokenIndex] = this.longTermBalances[order.buyTokenIndex].sub(cancelResult.purchasedAmount);
    this.longTermBalances[order.sellTokenIndex] = this.longTermBalances[order.sellTokenIndex].sub(cancelResult.unsoldAmout);

    this.orderMap[orderId].withdrawn = true;
    return {
      order: order,
      ...cancelResult
    }
  }

  async joinGivenIn(pool: WeightedPool, wallet: SignerWithAddress, amountsIn: Array<number>): Promise<BigNumberish> {
    await this.executeVirtualOrders();
    let mockBptOut = await pool.estimateBptOut(convertAmountsArrayToBn(amountsIn), this.tokenBalances.map(fp));

    // Update LP bpt balance
    if (!this.lps[wallet.address]) this.lps[wallet.address] = ZERO;
    this.lps[wallet.address] = this.lps[wallet.address].add(fromFp(mockBptOut));

    // Update token balances.
    this.tokenBalances = this.tokenBalances.map(function (num, idx) {
      return num.add(amountsIn[idx]);
    });

    return mockBptOut;
  }

  async multiExitGivenIn(pool: WeightedPool, wallet: SignerWithAddress, bptIn: Decimal): Promise<Array<BigNumberish>> {
    await this.executeVirtualOrders();
    
    let mockTokensOut = await pool.estimateTokensOutBptIn(fp(bptIn), this.tokenBalances.map(fp));
    // Update token balances.
    this.tokenBalances = this.tokenBalances.map(function (num, idx) {
      return num.sub(fromFp(mockTokensOut[idx]));
    });

    // Update LP bpt balance
    this.lps[wallet.address] = this.lps[wallet.address].sub(bptIn);

    // return mockBptOut;
    return mockTokensOut;
  }

};
