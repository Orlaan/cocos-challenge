import Decimal from 'decimal.js';
import type { Quote, Trade } from '../ledger';

export interface Position {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  reservedQuantity: number; // held by NEW SELL orders
  availableQuantity: number; // what the user can still sell
  marketValue: string | null;
  totalReturnPct: string | null;
  dailyReturnPct: string | null;
}

interface Holding {
  trade: Trade;
  quantity: number;
  cost: Decimal; // cost basis of the shares still held (weighted average cost)
}

/**
 * Folds FILLED trades into positions with weighted average cost.
 * A BUY adds its cost; a SELL keeps the average and removes shares at that average.
 * When a position is flat or negative (seed BMA is −10), the next BUY restarts the cost basis.
 * Pure: no I/O, so the money math is unit-tested on its own.
 */
export function foldPositions(trades: Trade[], quotes: Map<number, Quote>, held = new Map<number, number>()): Position[] {
  const holdings = new Map<number, Holding>();
  for (const t of trades) {
    const h = holdings.get(t.instrumentId) ?? { trade: t, quantity: 0, cost: new Decimal(0) };
    if (t.side === 'BUY') {
      const quantity = h.quantity + t.size;
      h.cost = h.quantity > 0 ? h.cost.plus(new Decimal(t.price).times(t.size)) : new Decimal(t.price).times(Math.max(quantity, 0));
      h.quantity = quantity;
    } else {
      const quantity = h.quantity - t.size;
      h.cost = quantity > 0 ? h.cost.div(h.quantity).times(quantity) : new Decimal(0);
      h.quantity = quantity;
    }
    holdings.set(t.instrumentId, h);
  }
  return [...holdings.values()]
    .filter((h) => h.quantity !== 0)
    .map((h) => value(h, quotes.get(h.trade.instrumentId), held.get(h.trade.instrumentId) ?? 0));
}

function value({ trade, quantity, cost }: Holding, quote: Quote | undefined, reserved: number): Position {
  const close = quote && new Decimal(quote.close);
  const marketValue = close?.times(quantity);
  const totalReturn = marketValue && quantity > 0 && cost.gt(0) ? marketValue.div(cost).minus(1) : undefined;
  const dailyReturn = close && quote.previousClose && !new Decimal(quote.previousClose).isZero()
    ? close.div(quote.previousClose).minus(1)
    : undefined;
  return {
    instrumentId: trade.instrumentId,
    ticker: trade.ticker,
    name: trade.name,
    quantity,
    reservedQuantity: reserved,
    availableQuantity: quantity - reserved,
    marketValue: marketValue?.toFixed(2) ?? null,
    totalReturnPct: pct(totalReturn),
    dailyReturnPct: pct(dailyReturn),
  };
}

const pct = (ratio?: Decimal) => ratio?.times(100).toFixed(2) ?? null;
