import { IsIn, IsInt, IsPositive, Matches, Max, ValidateIf } from 'class-validator';
import { AMOUNT, INT_MAX, PRICE } from '../limits';

// Like @IsOptional, but only a missing field is optional: `null` is validated, so it is a 400, not a 500.
const Optional = () => ValidateIf((_, value) => value !== undefined);

export class PlaceOrder {
  @IsInt() @IsPositive() @Max(INT_MAX)
  instrumentId!: number;

  // CASH_IN / CASH_OUT exist in the table but are not exposed: this endpoint only trades.
  @IsIn(['BUY', 'SELL'])
  side!: 'BUY' | 'SELL';

  @IsIn(['MARKET', 'LIMIT'])
  type!: 'MARKET' | 'LIMIT';

  /** Whole shares. Send this or `amount`. */
  @Optional() @IsInt() @IsPositive() @Max(INT_MAX)
  size?: number;

  /** ARS to invest, as a decimal string ("10000.50"); the API buys the most whole shares it covers. */
  @Optional() @Matches(AMOUNT, { message: 'amount must be a decimal string with up to 2 decimals' })
  amount?: string;

  /** Limit price in ARS, as a decimal string ("900.00"). LIMIT only. */
  @Optional() @Matches(PRICE, { message: 'price must be a decimal string with up to 2 decimals, below 100000000' })
  price?: string;
}
