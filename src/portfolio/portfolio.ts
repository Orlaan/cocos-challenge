import { Controller, Get, Injectable, Param } from '@nestjs/common';
import Decimal from '../money';
import { DataSource } from 'typeorm';
import { snapshot } from '../db';
import { cash, filledTrades, heldShares, latestQuotes } from '../ledger';
import { IdPipe } from '../id.pipe';
import { Problem } from '../problem';
import { foldPositions } from './positions';

@Injectable()
export class PortfolioService {
  constructor(private readonly ds: DataSource) {}

  /** Cash and positions come from one snapshot, so an order committing mid-read cannot skew the total. */
  get(userId: number) {
    return snapshot(this.ds, async (sql) => {
      const [user] = await sql('SELECT id FROM users WHERE id = $1', [userId]);
      if (!user) throw new Problem(404, 'USER_NOT_FOUND');
      const money = await cash(sql, userId);
      const trades = await filledTrades(sql, userId);
      const quotes = await latestQuotes(sql, [...new Set(trades.map((t) => t.instrumentId))]);
      const positions = foldPositions(trades, quotes, await heldShares(sql, userId));
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
    });
  }
}

@Controller('users/:userId/portfolio')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  get(@Param('userId', IdPipe) userId: number) {
    return this.portfolio.get(userId);
  }
}
