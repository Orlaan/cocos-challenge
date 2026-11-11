import { IsIn, IsInt, IsPositive, Matches, Max, ValidateIf } from 'class-validator';
import { INT_MAX } from '../limits';
import Decimal from '../money';

// Money travels as decimal strings (like the responses), so no amount is ever a binary float.
const PRICE = /^\d{1,8}(\.\d{1,2})?$/; // orders.price is NUMERIC(10, 2)
const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/; // bounds the input; a size above INT is AMOUNT_TOO_LARGE anyway

// Like @IsOptional, but only a missing field is optional: `null` is validated, so it is a 400, not a 500.
const Optional = () => ValidateIf((_, value) => value !== undefined);

export class PlaceOrder {
  @IsInt()
  @IsPositive()
  @Max(INT_MAX)
  instrumentId!: number;

  // CASH_IN / CASH_OUT exist in the table but are not exposed: this endpoint only trades.
  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type!: 'MARKET' | 'LIMIT';

  /** Whole shares. Send this or `amount`. */
  @Optional()
  @IsInt()
  @IsPositive()
  @Max(INT_MAX)
  size?: number;

  /** ARS to invest, as a decimal string ("10000.50"); the API buys the most whole shares it covers. */
  @Optional()
  @Matches(AMOUNT, { message: 'amount must be a decimal string with up to 2 decimals' })
  amount?: string;

  /** Limit price in ARS, as a decimal string ("900.00"). LIMIT only. */
  @Optional()
  @Matches(PRICE, { message: 'price must be a decimal string with up to 2 decimals, below 100000000' })
  price?: string;
}

/** Rules across fields, checked after the decorators above: together, every 400 that needs no data. */
export function shapeError(o: PlaceOrder): string | null {
  if ((o.size === undefined) === (o.amount === undefined)) return 'Send exactly one of size or amount';
  if (o.type === 'LIMIT' && o.price === undefined) return 'LIMIT orders need a price';
  if (o.type === 'MARKET' && o.price !== undefined) return 'MARKET orders take the market price; do not send price';
  if (o.price !== undefined && new Decimal(o.price).isZero()) return 'price must be greater than 0';
  if (o.amount !== undefined && new Decimal(o.amount).isZero()) return 'amount must be greater than 0';
  return null;
}

/** The Idempotency-Key header, when sent, fits the `key` column. */
export function keyError(key?: string): string | null {
  return key !== undefined && (key.length < 1 || key.length > 255) ? 'Idempotency-Key must have 1 to 255 characters' : null;
}
