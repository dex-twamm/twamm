import fc from 'fast-check';
import { Contracts, TwammModel } from './TwammModel';
import { decimal, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import { expect } from 'chai';
import { testUtils } from 'hardhat';
import { convertAmountsArrayToBn, getWalletFromList } from './ModelUtils';
import { getEventLog } from '@balancer-labs/v2-helpers/src/test/expectEvent';
const { block } = testUtils;

const EXPECTED_RELATIVE_ERROR = 0.00001;
const BN_ZERO = fp(0);

export class JoinGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly amountIn: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>) => true;
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
  toString = () => `wallet${this.walletNo}.joinGivenIn(${this.amountIn}, ${this.amountIn * 4})`;
}

export class MultiExitGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly bptIn: number, readonly walletNo: number) {}
  check = (m: Readonly<TwammModel>) => {
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
  toString = () => `wallet${this.walletNo}.multiExitGivenIn(${this.bptIn})`;
}

export class PlaceLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(
    readonly amountIn: number,
    readonly tokenIndexIn: number,
    readonly numberOfBlockIntervals: number,
    readonly walletNo: number
  ) {}
  check = (m: Readonly<TwammModel>) => {
    const saleRate = this.amountIn / (this.numberOfBlockIntervals * 100);
    const maxAllowedSaleRate = m.tokenBalances[this.tokenIndexIn].div(100);
    const minSaleAmount = m.tokenBalances[this.tokenIndexIn].div(1e4);

    const currentSalesRate = m.orderPoolMap[this.tokenIndexIn].currentSalesRate;
    if (currentSalesRate.add(saleRate).gte(maxAllowedSaleRate)) return false;
    if (this.amountIn < minSaleAmount.toNumber()) return false;

    return true;
  };

  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      await m.placeLto(r.pool, decimal(this.amountIn), this.tokenIndexIn, this.numberOfBlockIntervals, this.walletNo);

      const wallet = r.wallets[this.walletNo];
      const placeResult = await r.pool.placeLongTermOrder({
        from: wallet,
        amountIn: fp(this.amountIn),
        tokenInIndex: this.tokenIndexIn,
        tokenOutIndex: 1 - this.tokenIndexIn,
        numberOfBlockIntervals: this.numberOfBlockIntervals,
      });
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = () =>
    `wallet${this.walletNo}.placeLto(${this.amountIn}, ${this.tokenIndexIn}, ${1 - this.tokenIndexIn}, ${
      this.numberOfBlockIntervals
    })`;
}

export class WithdrawLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly orderId: number) {}
  check = (m: Readonly<TwammModel>) => {
    if (this.orderId >= m.lastOrderId) return false; // TODO: allow invalid Ids as well?
    if (m.orderMap[this.orderId].withdrawn) return false;

    return true;
  };

  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      const mockResult = await m.withdrawLto(r.pool, this.orderId);

      // Call withdraw LTO using order owner, based on model.
      const wallet = getWalletFromList(r.wallets, m.orderMap[this.orderId].owner);
      const withdrawResult = await r.pool.withdrawLongTermOrder({
        from: wallet,
        orderId: this.orderId,
      });
      expect(withdrawResult.isPartialWithdrawal).to.be.equal(mockResult.isPartialWithdrawal);
      expectEqualWithError(withdrawResult.amountsOut[mockResult.order.buyTokenIndex], fp(mockResult.proceeds));
      expect(withdrawResult.amountsOut[mockResult.order.sellTokenIndex]).to.be.equal(BN_ZERO);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = () => `withdrawLto(${this.orderId})`;
}

export class CancelLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly orderId: number) {}
  check = (m: Readonly<TwammModel>) => {
    if (this.orderId >= m.lastOrderId) return false; // TODO: allow invalid Ids as well?
    if (m.orderMap[this.orderId].withdrawn) return false;

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
      expectEqualWithError(cancelResult.amountsOut[mockResult.order.sellTokenIndex], fp(mockResult.unsoldAmout));
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = () => `cancelLto(${this.orderId})`;
}

export class MoveFwdNBlocksCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly value: number) {}
  check = (m: Readonly<TwammModel>) => true;
  async run(m: TwammModel, r: Contracts): Promise<void> {
    try {
      await block.advance(this.value);
    } catch (error) {
      console.log(error);
      throw error;
    }
  }
  toString = () => `moveNBlocks(${this.value})`;
}

export class WithdrawLtoManagementFeeCommand implements fc.AsyncCommand<TwammModel, Contracts> {
  constructor(readonly value: number) {}
  check = (m: Readonly<TwammModel>) => true;
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
  toString = () => `WithdrawLtoManagementFeeCommand()`;
}

export function allTwammCommands(numberOfWallets: number) {
  return [
    fc
      .tuple(
        fc.float({ min: 1, max: 1000 }), // amountIn
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new JoinGivenInCommand(v[0], v[1])),
    fc
      .tuple(
        fc.float({ min: 1, max: 100 }), // bptIn
        fc.nat({ max: numberOfWallets - 1 }) // walletNo
      )
      .map((v) => new MultiExitGivenInCommand(v[0], v[1])),
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
  ];
}
