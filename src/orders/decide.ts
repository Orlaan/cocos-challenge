import Decimal from '../money';
import { INT_MAX } from '../limits';
import type { PlaceOrder } from './order.dto';

export type OrderStatus = 'NEW' | 'FILLED' | 'REJECTED' | 'CANCELLED';
export type Reason = 'INSUFFICIENT_FUNDS' | 'INSUFFICIENT_SHARES' | 'NO_MARKET_PRICE' | 'AMOUNT_BELOW_ONE_SHARE';
export type Invalid = 'AMOUNT_TOO_LARGE';

export interface Decision {
  status: Exclude<OrderStatus, 'CANCELLED'>; // a new order is never born cancelled
  size: number;
  price: Decimal | null;
  reason?: Reason;
}

/** What decide() reads under the lock. */
export interface Context {
  close: Decimal | null; // latest market price, null when the instrument has no market data
  available: Decimal; // BUY: cash minus NEW BUY holds. SELL: shares minus NEW SELL holds.
}

/**
 * The whole business decision for one order, with no I/O.
 * MARKET fills now at the latest close; LIMIT waits as NEW and holds its cash or shares.
 * An order the market cannot take (no price, under one share, not affordable) is still a valid order: it is saved as REJECTED.
 */
export function decide(o: PlaceOrder, ctx: Context): Decision | { invalid: Invalid } {
  const price = o.type === 'MARKET' ? ctx.close : new Decimal(o.price!);
  if (!price) {
    // By amount, no size can be computed: 0 shares.
    return { status: 'REJECTED', size: o.size ?? 0, price: null, reason: 'NO_MARKET_PRICE' };
  }

  const size = o.size ?? new Decimal(o.amount!).div(price).floor().toNumber();
  if (size < 1) return { status: 'REJECTED', size, price, reason: 'AMOUNT_BELOW_ONE_SHARE' }; // size is 0
  if (size > INT_MAX) return { invalid: 'AMOUNT_TOO_LARGE' }; // orders.size is INT

  const affordable = (o.side === 'BUY' ? price.times(size) : new Decimal(size)).lte(ctx.available);
  if (!affordable) {
    const reason = o.side === 'BUY' ? 'INSUFFICIENT_FUNDS' : 'INSUFFICIENT_SHARES';
    return { status: 'REJECTED', size, price, reason };
  }
  return { status: o.type === 'MARKET' ? 'FILLED' : 'NEW', size, price };
}
