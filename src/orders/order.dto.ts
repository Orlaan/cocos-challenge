import { IsIn, IsInt, IsNumber, IsOptional, IsPositive, Max } from 'class-validator';
import { INT_MAX } from '../id.pipe';

const MAX_PRICE = 99_999_999.99; // orders.price is NUMERIC(10, 2)

export class PlaceOrder {
  @IsInt() @IsPositive() @Max(INT_MAX)
  instrumentId!: number;

  // CASH_IN / CASH_OUT exist in the table but are not exposed: this endpoint only trades.
  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type!: 'MARKET' | 'LIMIT';

  /** Whole shares. Send this or `amount`. */
  @IsOptional() @IsInt() @IsPositive() @Max(INT_MAX)
  size?: number;

  /** ARS to invest; the API buys the most whole shares it covers. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive()
  amount?: number;

  /** Limit price in ARS. LIMIT only. */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(MAX_PRICE)
  price?: number;
}
