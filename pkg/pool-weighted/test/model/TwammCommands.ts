import fc from "fast-check";
import { Contracts, TwammModel } from "./TwammModel";
import { decimal, fp } from '@balancer-labs/v2-helpers/src/numbers';
import { expectEqualWithError } from '@balancer-labs/v2-helpers/src/test/relativeError';
import { expect } from 'chai';
import { testUtils } from 'hardhat';
import { convertAmountsArrayToBn } from "./ModelUtils";
const { block } = testUtils;

const EXPECTED_RELATIVE_ERROR = 0.00001;
const BN_ZERO = fp(0);

export class JoinGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
    constructor(readonly value: number) { }
    check = (m: Readonly<TwammModel>) => true;
    async run(m: TwammModel, r: Contracts): Promise<void> {
        try {
            let amountsIn = [this.value, this.value * 4];
            let mockBptOut = await m.joinGivenIn(r.pool, r.wallet, amountsIn);

            // console.log("before join", await r.pool.instance.getInvariant());
            // console.log("balances before join", (await r.pool.getTokens()).balances);
            // console.log("block before join", await block.latestBlockNumber());

            const initialBptBalance = await r.pool.balanceOf(r.wallet);
            await r.pool.joinGivenIn({ from: r.wallet, amountsIn: convertAmountsArrayToBn(amountsIn) });
            const realBptOut = (await r.pool.balanceOf(r.wallet)).sub(initialBptBalance);
            // console.log("bpt out", realBptOut);
            // console.log("after join", await r.pool.instance.getInvariant());

            expectEqualWithError(realBptOut, mockBptOut, EXPECTED_RELATIVE_ERROR);
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
    toString = () => `joinGivenIn(${this.value}, ${this.value * 4})`;
}

export class MultiExitGivenInCommand implements fc.AsyncCommand<TwammModel, Contracts> {
    constructor(readonly value: number) { }
    check = (m: Readonly<TwammModel>) => {
        return m.lps[m.wallet.address].gte(decimal(this.value));
    };
    async run(m: TwammModel, r: Contracts): Promise<void> {
        try {
            let mockTokensOut = await m.multiExitGivenIn(r.pool, r.wallet, decimal(this.value));

            // console.log("balances before exit", (await r.pool.getTokens()).balances.map((v) => v.toString()));
            let realTokensOut = (await r.pool.multiExitGivenIn({ from: r.wallet, bptIn: fp(this.value) })).amountsOut;

            expectEqualWithError(realTokensOut[0], mockTokensOut[0], EXPECTED_RELATIVE_ERROR);
            expectEqualWithError(realTokensOut[1], mockTokensOut[1], EXPECTED_RELATIVE_ERROR);
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
    toString = () => `multiExitGivenIn(${this.value})`;
}

export class PlaceLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
    constructor(readonly amountIn: number, readonly tokenIndexIn: number, readonly numberOfBlockIntervals: number) { }
    check = (m: Readonly<TwammModel>) => {
        let saleRate = this.amountIn / (this.numberOfBlockIntervals * 100);
        let maxAllowedSaleRate = m.tokenBalances[this.tokenIndexIn].div(100);
        let minSaleAmount = m.tokenBalances[this.tokenIndexIn].div(1e4);

        let currentSalesRate = m.orderPoolMap[this.tokenIndexIn].currentSalesRate;
        if (currentSalesRate.add(saleRate).gte(maxAllowedSaleRate)) return false;
        if (this.amountIn < minSaleAmount.toNumber()) return false;

        return true;

    };

    async run(m: TwammModel, r: Contracts): Promise<void> {
        try {
            await m.placeLto(decimal(this.amountIn), this.tokenIndexIn, this.numberOfBlockIntervals);

            const placeResult = await r.pool.placeLongTermOrder({
                from: r.wallet,
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
    toString = () => `placeLto(${this.amountIn}, ${this.tokenIndexIn}, ${1 - this.tokenIndexIn}, ${this.numberOfBlockIntervals})`;
}

export class WithdrawLtoCommand implements fc.AsyncCommand<TwammModel, Contracts> {
    constructor(readonly orderId: number) { }
    check = (m: Readonly<TwammModel>) => {
        if (this.orderId >= m.lastOrderId) return false; // TODO: allow invalid Ids as well?
        if (m.orderMap[this.orderId].withdrawn) return false;

        return true;
    };

    async run(m: TwammModel, r: Contracts): Promise<void> {
        try {
            const mockResult = await m.withdrawLto(this.orderId);

            const withdrawResult = await r.pool.withdrawLongTermOrder({
                from: r.wallet,
                orderId: this.orderId
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
    constructor(readonly orderId: number) { }
    check = (m: Readonly<TwammModel>) => {
        if (this.orderId >= m.lastOrderId) return false; // TODO: allow invalid Ids as well?
        if (m.orderMap[this.orderId].withdrawn) return false;

        return true;
    };

    async run(m: TwammModel, r: Contracts): Promise<void> {
        try {
            const mockResult = await m.cancelLto(this.orderId);

            const cancelResult = await r.pool.cancelLongTermOrder({
                from: r.wallet,
                orderId: this.orderId
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
    constructor(readonly value: number) { }
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

// TODO: implement LTO management fee withdrawal.
// TODO: implement multiple wallets.

export const allTwammCommands = [
    fc.float({ min: 1, max: 1000 }).map((v) => new JoinGivenInCommand(v)),
    fc.float({ min: 1, max: 100 }).map((v) => new MultiExitGivenInCommand(v)),
    fc.tuple(
        fc.float({ min: 1, max: 10000 }), // amountIn
        fc.nat({ max: 1 }), // tokenIndexIn
        fc.integer({ min: 1, max: 10 },) // numberOfBlockIntervals
    ).map((v) => new PlaceLtoCommand(v[0], v[1], v[2])),
    fc.nat({ max: 5 }).map((v) => new WithdrawLtoCommand(v)),
    fc.nat({ max: 5 }).map((v) => new CancelLtoCommand(v)),
    fc.integer({ min: 1, max: 200 }).map((v) => new MoveFwdNBlocksCommand(v))
];