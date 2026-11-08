import Decimal from '../money';
import { decide, shapeError } from './decide';
import type { PlaceOrder } from './order.dto';

const book = { close: new Decimal('100.00'), availableCash: new Decimal('1000.00'), availableShares: 5 };
const order = (o: Partial<PlaceOrder>) => ({ instrumentId: 1, side: 'BUY', type: 'MARKET', ...o }) as PlaceOrder;

describe('decide', () => {
  it('MARKET fills at the latest close', () => {
    expect(decide(order({ size: 3 }), book)).toEqual({ status: 'FILLED', size: 3, price: new Decimal(100) });
  });

  it('LIMIT stays NEW at the limit price', () => {
    expect(decide(order({ type: 'LIMIT', size: 3, price: '90' }), book)).toEqual({ status: 'NEW', size: 3, price: new Decimal(90) });
  });

  it('amount buys the most whole shares: floor(999.99 / 100) = 9', () => {
    expect(decide(order({ amount: '999.99' }), book)).toMatchObject({ status: 'FILLED', size: 9 });
  });

  it('LIMIT amount uses the limit price: floor(1000 / 90) = 11', () => {
    expect(decide(order({ type: 'LIMIT', amount: '1000', price: '90' }), { ...book, availableCash: new Decimal(2000) })).toMatchObject({ size: 11, status: 'NEW' });
  });

  it('spending exactly all available cash is allowed', () => {
    expect(decide(order({ size: 10 }), book)).toMatchObject({ status: 'FILLED' });
  });

  it('one cent more than available cash → REJECTED INSUFFICIENT_FUNDS', () => {
    expect(decide(order({ size: 10 }), { ...book, availableCash: new Decimal('999.99') })).toMatchObject({
      status: 'REJECTED',
      reason: 'INSUFFICIENT_FUNDS',
    });
  });

  it('SELL above available shares → REJECTED INSUFFICIENT_SHARES; SELL all → FILLED', () => {
    expect(decide(order({ side: 'SELL', size: 6 }), book)).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_SHARES' });
    expect(decide(order({ side: 'SELL', size: 5 }), book)).toMatchObject({ status: 'FILLED' });
  });

  it('SELL never checks cash, BUY never checks shares', () => {
    const broke = { ...book, availableCash: new Decimal(0), availableShares: 0 };
    expect(decide(order({ side: 'SELL', size: 1 }), { ...broke, availableShares: 1 })).toMatchObject({ status: 'FILLED' });
    expect(decide(order({ size: 1 }), { ...broke, availableCash: new Decimal(100) })).toMatchObject({ status: 'FILLED' });
  });

  it('MARKET without market data → REJECTED NO_MARKET_PRICE; LIMIT does not need it', () => {
    const noData = { ...book, close: null };
    expect(decide(order({ size: 1 }), noData)).toEqual({ status: 'REJECTED', size: 1, price: null, reason: 'NO_MARKET_PRICE' });
    expect(decide(order({ type: 'LIMIT', size: 1, price: '10' }), noData)).toMatchObject({ status: 'NEW' });
  });

  it('amount below one share is invalid, not a REJECTED order', () => {
    expect(decide(order({ amount: '99.99' }), book)).toEqual({ invalid: 'AMOUNT_BELOW_ONE_SHARE' });
  });

  it('a computed size above the INT column is invalid', () => {
    expect(decide(order({ amount: '1000000000000' }), { ...book, close: new Decimal('0.01') })).toEqual({ invalid: 'VALIDATION_ERROR' });
  });

  it('uses exact decimals: 0.1 + 0.2 style errors cannot reject a payable order', () => {
    const tight = { close: new Decimal('0.10'), availableCash: new Decimal('0.30'), availableShares: 0 };
    expect(decide(order({ size: 3 }), tight)).toMatchObject({ status: 'FILLED' });
  });
});

describe('shapeError', () => {
  it.each([
    [{ size: 1 }, null],
    [{ amount: '100' }, null],
    [{}, 'Send exactly one of size or amount'],
    [{ size: 1, amount: '100' }, 'Send exactly one of size or amount'],
    [{ size: 1, type: 'LIMIT' }, 'LIMIT orders need a price'],
    [{ size: 1, price: '10' }, 'MARKET orders take the market price; do not send price'],
    [{ size: 1, type: 'LIMIT', price: '0.00' }, 'price must be greater than 0'],
    [{ amount: '0' }, 'amount must be greater than 0'],
  ] as const)('%o → %s', (o, expected) => {
    expect(shapeError(order(o as Partial<PlaceOrder>))).toBe(expected);
  });
});
