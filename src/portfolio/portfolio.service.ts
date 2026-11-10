import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Problem } from '../common/problem';
import { transaction } from '../database/db';
import { cash, filledTrades, userExists } from '../ledger.repository';
import { latestQuotes } from '../marketdata.repository';
import { foldPositions } from './positions';

@Injectable()
export class PortfolioService {
  constructor(private readonly ds: DataSource) {}

  /** Cash and positions come from one snapshot (REPEATABLE READ), so an order committing mid-read cannot skew the total. */
  get(userId: number) {
    return transaction(this.ds, async (sql) => {
      if (!(await userExists(sql, userId))) throw new Problem(404, 'USER_NOT_FOUND');
      const money = await cash(sql, userId);
      const trades = await filledTrades(sql, userId);
      const quotes = await latestQuotes(sql, [...new Set(trades.map((t) => t.instrumentId))]);
      const positions = foldPositions(trades, quotes);
      // The total adds the positions that have a price and lists the ones that do not,
      // so a partial total never looks complete.
      const total = positions.reduce((sum, p) => sum.plus(p.marketValue ?? 0), money.balance);
      return {
        userId,
        totalValue: total.toFixed(2),
        unpricedInstrumentIds: positions.filter((p) => p.marketValue === null).map((p) => p.instrumentId),
        cash: {
          balance: money.balance.toFixed(2),
          reserved: money.reserved.toFixed(2),
          available: money.available.toFixed(2),
        },
        positions,
      };
    }, 'REPEATABLE READ');
  }
}
