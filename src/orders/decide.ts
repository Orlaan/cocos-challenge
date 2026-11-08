import Decimal from '../money';
import { INT_MAX } from '../limits';
import type { PlaceOrder } from './order.dto';

export type Status = 'FILLED' | 'NEW' | 'REJECTED';
export type Reason = 'INSUFFICIENT_FUNDS' | 'INSUFFICIENT_SHARES' | 'NO_MARKET_PRICE';
export type Invalid = 'AMOUNT_BELOW_ONE_SHARE' | 'VALIDATION_ERROR';

export interface Decision {
  status: Status;
  size: number | null;
  price: Decimal | null;
  reason?: Reason;
}

/** Request rules that need no data. Returns the error message, or null when the shape is valid. */
export function shapeError(o: PlaceOrder): string | null {
  if ((o.size === undefined) === (o.amount === undefined)) return 'Send exactly one of size or amount';
  if (o.type === 'LIMIT' && o.price === undefined) return 'LIMIT orders need a price';
  if (o.type === 'MARKET' && o.price !== undefined) return 'MARKET orders take the market price; do not send price';
  if (o.price !== undefined && new Decimal(o.price).isZero()) return 'price must be greater than 0';
  if (o.amount !== undefined && new Decimal(o.amount).isZero()) return 'amount must be greater than 0';
  return null;
}

export interface Book {
  close: Decimal | null; // latest market price, null when the instrument has no market data
  availableCash: Decimal; // cash minus NEW BUY holds
  availableShares: number; // shares minus NEW SELL holds
}

/**
 * The whole business decision for one order, with no I/O.
 * MARKET fills now at the latest close; LIMIT waits as NEW and holds its cash or shares.
 * An order the user cannot afford is still a valid order: it is saved as REJECTED.
 */
export function decide(o: PlaceOrder, book: Book): Decision | { invalid: Invalid } {
  const price = o.type === 'MARKET' ? book.close : new Decimal(o.price!);
  if (!price) return { status: 'REJECTED', size: o.size ?? null, price: null, reason: 'NO_MARKET_PRICE' };

  const size = o.size ?? new Decimal(o.amount!).div(price).floor().toNumber();
  if (size < 1) return { invalid: 'AMOUNT_BELOW_ONE_SHARE' };
  if (size > INT_MAX) return { invalid: 'VALIDATION_ERROR' };

  const affordable = o.side === 'BUY' ? price.times(size).lte(book.availableCash) : size <= book.availableShares;
  if (!affordable) {
    const reason = o.side === 'BUY' ? 'INSUFFICIENT_FUNDS' : 'INSUFFICIENT_SHARES';
    return { status: 'REJECTED', size, price, reason };
  }
  return { status: o.type === 'MARKET' ? 'FILLED' : 'NEW', size, price };
}
