import fc from 'fast-check';
import { Contracts, TwammModel } from './TwammModel';
import { decimal, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import { expect } from 'chai';
import { testUtils } from 'hardhat';
import { convertAmountsArrayToBn, getWalletFromList } from './ModelUtils';
import { getEventLog } from '@balancer-labs/v2-helpers/src/test/expectEvent';
const { block } = testUtils;
import { JoinResult } from '../../../../pvt/helpers/src/models/pools/weighted/types';

const EXPECTED_RELATIVE_ERROR = 0.00001;
const BN_ZERO = fp(0);

export class SwapGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly tokenIn: number, readonly amountIn: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>): boolean => {
    return decimal(this.amountIn) < m.tokenBalances[this.tokenIn];
  };
  async run(m: TwammModel, r: Contracts): Promise<void> {
    const wallet = r.wallets[this.walletNo];

    let swapAmount, modelException;
    try {
      const swapAmount = await m.swapGivenIn(r.pool, this.tokenIn, fp(this.amountIn));
    } catch (exception: any) {
      modelException = exception;
    }

    try {
      const swapResult = await r.pool.swapTokensGivenIn(
        this.tokenIn,
        1 - this.tokenIn,
        fp(this.amountIn),
        fp(swapAmount ?? 0),
        wallet,
        wallet
      );
      if (modelException) {
        throw modelException;
      }
    } catch (exception: e) {}

    expectEqualWithError(swapResult.amount, swapAmount, EXPECTED_RELATIVE_ERROR);
  }
  toString = (): string => `wallet${this.walletNo}.swapGivenIn(${this.tokenIn}, ${this.amountIn})`;
}

export class SwapGivenOutCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly tokenOut: number, readonly amountOut: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>): boolean => {
    return decimal(this.amountOut) < m.tokenBalances[this.tokenOut];
  };
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const wallet = r.wallets[this.walletNo];

      const swapAmount = await m.swapGivenOut(r.pool, this.tokenOut, fp(this.amountOut));

      const swapResult = await r.pool.swapTokensGivenOut(
        1 - this.tokenOut,
        this.tokenOut,
        fp(this.amountOut),
        fp(swapAmount),
        wallet,
        wallet
      );

      expectEqualWithError(swapResult.amount, swapAmount, EXPECTED_RELATIVE_ERROR);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `wallet${this.walletNo}.swapGivenOut(${this.tokenOut}, ${this.amountOut})`;
}

export class JoinGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly amountIn: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>): boolean => true;
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const amountsIn = [this.amountIn, this.amountIn * 4];
      const wallet = r.wallets[this.walletNo];
      const mockBptOut = await m.joinGivenIn(r.pool, wallet, amountsIn);

      const initialBptBalance = await r.pool.balanceOf(wallet);
      await r.pool.joinGivenIn({ from: wallet, amountsIn: convertAmountsArrayToBn(amountsIn) });
      const realBptOut = (await r.pool.balanceOf(wallet)).sub(initialBptBalance);

      expectEqualWithError(realBptOut, mockBptOut, EXPECTED_RELATIVE_ERROR);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `wallet${this.walletNo}.joinGivenIn(${this.amountIn}, ${this.amountIn * 4})`;
}

export class JoinGivenOutCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly tokenIndex: number, readonly btpOut: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>): boolean => true;
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const wallet = r.wallets[this.walletNo];
      const amountIn = await m.joinGivenOut(r.pool, wallet, this.btpOut, this.tokenIndex);

      const joinResult: JoinResult = await r.pool.joinGivenOut({
        from: wallet,
        bptOut: this.btpOut,
        token: this.tokenIndex,
      });

      console.log(joinResult.amountsIn, amountIn);
      expectEqualWithError(joinResult.amountsIn[this.tokenIndex], amountIn, EXPECTED_RELATIVE_ERROR);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `wallet${this.walletNo}.joinGivenOut(${this.tokenIndex}, ${this.btpOut})`;
}

export class MultiExitGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly bptIn: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>): boolean => {
    return m.lps[m.wallets[this.walletNo].address].gte(decimal(this.bptIn));
  };
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const wallet = r.wallets[this.walletNo];
      const mockTokensOut = await m.multiExitGivenIn(r.pool, wallet, decimal(this.bptIn));

      const realTokensOut = (await r.pool.multiExitGivenIn({ from: wallet, bptIn: fp(this.bptIn) })).amountsOut;

      expectEqualWithError(realTokensOut[0], mockTokensOut[0], EXPECTED_RELATIVE_ERROR);
      expectEqualWithError(realTokensOut[1], mockTokensOut[1], EXPECTED_RELATIVE_ERROR);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `wallet${this.walletNo}.multiExitGivenIn(${this.bptIn})`;
}

export class SingleTokenExitGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly bptIn: number, readonly tokenIndex: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>): boolean => {
    return m.lps[m.wallets[this.walletNo].address].gte(decimal(this.bptIn));
  };
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const wallet = r.wallets[this.walletNo];
      const mockTokenOut = await m.singleTokenExitGivenIn(r.pool, wallet, decimal(this.bptIn), this.tokenIndex);

      const realAmountsOut = (
        await r.pool.singleExitGivenIn({ from: wallet, bptIn: fp(this.bptIn), token: this.tokenIndex })
      ).amountsOut;

      expectEqualWithError(realAmountsOut[this.tokenIndex], mockTokenOut, EXPECTED_RELATIVE_ERROR);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `wallet${this.walletNo}.singleTokenExitGivenIn(${this.bptIn}, ${this.tokenIndex})`;
}

export class PlaceLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(
    readonly amountIn: number,
    readonly tokenIndexIn: number,
    readonly numberOfBlockIntervals: number,
    readonly walletNo: number
  ) {}
  check = (m: Readonly<TwammModel>): boolean => {
    const saleRate = this.amountIn / (this.numberOfBlockIntervals * 100);
    const maxAllowedSaleRate = m.tokenBalances[this.tokenIndexIn].div(100);
    const minSaleAmount = m.tokenBalances[this.tokenIndexIn].div(1e4);

    const currentSalesRate = m.orderPoolMap[this.tokenIndexIn].currentSalesRate;
    if (currentSalesRate.add(saleRate).gte(maxAllowedSaleRate)) return false;
    if (this.amountIn < minSaleAmount.toNumber()) return false;

    return true;
  };

  async run(m: TwammModel, r: Contracts): Promise<void> {
    let mockException;
    try {
      await m.placeLto(r.pool, decimal(this.amountIn), this.tokenIndexIn, this.numberOfBlockIntervals, this.walletNo);
    } catch (e: any) {
      mockException = e;
    }

    const wallet = r.wallets[this.walletNo];
    try {
      await r.pool.placeLongTermOrder({
        from: wallet,
        amountIn: fp(this.amountIn),
        tokenInIndex: this.tokenIndexIn,
        tokenOutIndex: 1 - this.tokenIndexIn,
        numberOfBlockIntervals: this.numberOfBlockIntervals,
      });

      if (mockException) {
        throw mockException;
      }
    } catch (exception: any) {
      if (!mockException || !(exception.message.includes(mockException.message) ?? true)) {
        throw exception;
      }
    }
  }
  toString = (): string =>
    `wallet${this.walletNo}.placeLto(${this.amountIn}, ${this.tokenIndexIn}, ${1 - this.tokenIndexIn}, ${
      this.numberOfBlockIntervals
    })`;
}

export class WithdrawLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly orderId: number) {}
  check = (m: Readonly<TwammModel>): boolean => {
    if (this.orderId >= m.lastOrderId) return false; // TODO: allow invalid Ids as well?
    if (m.orderMap[this.orderId].withdrawn) return false;

    // Withdraw LTO not possible if VO execution paused.
    // Cancel LTO should be done instead.
    if (m.isVirtualOrderExecutionPaused) return false;

    return true;
  };

  async run(m: TwammModel, r: Contracts): Promise<void> {
    let mockResult, mockException;
    try {
      mockResult = await m.withdrawLto(r.pool, this.orderId);
    } catch (exception: any) {
      mockException = exception;
    }

    // Call withdraw LTO using order owner, based on model.
    const wallet = getWalletFromList(r.wallets, m.orderMap[this.orderId].owner);

    let withdrawResult;
    try {
      withdrawResult = await r.pool.withdrawLongTermOrder({
        from: wallet,
        orderId: this.orderId,
      });

      if (mockResult) {
        expect(withdrawResult.isPartialWithdrawal).to.be.equal(mockResult.isPartialWithdrawal);
        expectEqualWithError(withdrawResult.amountsOut[mockResult.order.buyTokenIndex], fp(mockResult.proceeds));
        expect(withdrawResult.amountsOut[mockResult.order.sellTokenIndex]).to.be.equal(BN_ZERO);
      }

      if (mockException) {
        throw mockException;
      }
    } catch (exception: any) {
      if (!mockException || !exception.message.includes(mockException.message)) {
        throw exception;
      }
    }
  }
  toString = (): string => `new WithdrawLtoCommand(${this.orderId})`;
}

export class CancelLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly orderId: number) {}
  check = (m: Readonly<TwammModel>): boolean => {
    if (this.orderId >= m.lastOrderId) return false; // TODO: allow invalid Ids as well?
    if (m.orderMap[this.orderId].withdrawn) return false;

    if (m.orderMap[this.orderId].expirationBlock <= m.lastVirtualOrderBlock) return false;

    return true;
  };

  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const mockResult = await m.cancelLto(r.pool, this.orderId);

      // Call cancel LTO using order owner, based on model.
      const wallet = getWalletFromList(r.wallets, m.orderMap[this.orderId].owner);
      const cancelResult = await r.pool.cancelLongTermOrder({
        from: wallet,
        orderId: this.orderId,
      });
      expectEqualWithError(cancelResult.amountsOut[mockResult.order.buyTokenIndex], fp(mockResult.purchasedAmount));
      expectEqualWithError(cancelResult.amountsOut[mockResult.order.sellTokenIndex], fp(mockResult.unsoldAmount));
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `new CancelLtoCommand(${this.orderId})`;
}

export class MoveFwdNBlocksCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly value: number) {}
  check = (m: Readonly<TwammModel>): boolean => true;
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      await block.advance(this.value);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `new MoveFwdNBlocksCommand(${this.value})`;
}

export class SetVirtualOrderExecutionPaused implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly value: boolean) {}
  check = (m: Readonly<TwammModel>): boolean => true;
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      await m.pauseVirtualOrderExecution(this.value);
      await r.pool.setVirtualOrderExecutionPaused(m.wallets[0], this.value);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `new SetVirtualOrderExecution(${this.value})`;
}

export class WithdrawLtoManagementFeeCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly value: number) {}
  check = (m: Readonly<TwammModel>): boolean => true;
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const mockCollectedFee = await m.collectLtoManagementFees(r.pool);
      const receipt = await r.pool.withdrawLongTermOrderCollectedManagementFees(m.wallets[0], m.wallets[1]);
      const logs = getEventLog(receipt, r.pool.instance.interface, 'LongTermOrderManagementFeesCollected');
      expectEqualWithError(logs[0].args.amounts[0], fp(mockCollectedFee));
      expect(logs[0].args.amounts[1]).to.equal(fp(0));
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = (): string => `WithdrawLtoManagementFeeCommand()`;
}

export function allTwammCommands(numberOfWallets: number): Array<any> {
  return [
    fc
      .tuple(
        fc.float({ min: 0, max: 1 }), // tokenInIndex
        fc.float({ min: 1, max: 10000 }), // amountIn
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new SwapGivenInCommand(v[0], v[1], v[2])),
    fc
      .tuple(
        fc.float({ min: 0, max: 1 }), // tokenOutIndex
        fc.float({ min: 1, max: 10000 }), // amountOut
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new SwapGivenOutCommand(v[0], v[1], v[2])),
    fc
      .tuple(
        fc.float({ min: 1, max: 1000 }), // amountIn
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new JoinGivenInCommand(v[0], v[1])),
    fc
      .tuple(
        fc.float({ min: 0, max: 1 }), // tokenIndex
        fc.float({ min: 1000, max: 100000000 }), // bptOut
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new JoinGivenOutCommand(v[0], v[1], v[2])),
    fc
      .tuple(
        fc.float({ min: 1, max: 100 }), // bptIn
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new MultiExitGivenInCommand(v[0], v[1])),
    fc
      .tuple(
        fc.float({ min: 1, max: 100 }), // bptIn
        fc.float({ min: 0, max: 1 }), // tokenIndex
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new SingleTokenExitGivenInCommand(v[0], v[1], v[2])),
    fc
      .tuple(
        fc.float({ min: 1, max: 10000 }), // amountIn
        fc.nat({ max: 1 }), // tokenIndexIn
        fc.integer({ min: 1, max: 10 }), // numberOfBlockIntervals
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new PlaceLtoCommand(v[0], v[1], v[2], v[3])),
    fc.nat({ max: 5 }).map((v) => new WithdrawLtoCommand(v)),
    fc.nat({ max: 5 }).map((v) => new CancelLtoCommand(v)),
    fc.integer({ min: 1, max: 200 }).map((v) => new MoveFwdNBlocksCommand(v)),
    fc.nat({ max: 0 }).map((v) => new WithdrawLtoManagementFeeCommand(v)),
    fc.boolean().map((v) => new SetVirtualOrderExecutionPaused(v)),
  ];
}
