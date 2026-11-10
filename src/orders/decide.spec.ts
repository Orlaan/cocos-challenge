import Decimal from '../money';
import { decide } from './decide';
import { shapeError } from './order.dto';
import type { PlaceOrder } from './order.dto';

const ctx = { close: new Decimal('100.00'), available: new Decimal('1000.00') }; // a BUY's cash
const shares = (n: number) => ({ ...ctx, available: new Decimal(n) }); // a SELL's shares
const order = (o: Partial<PlaceOrder>) => ({ instrumentId: 1, side: 'BUY', type: 'MARKET', ...o }) as PlaceOrder;

describe('decide', () => {
  it('MARKET fills at the latest close', () => {
    expect(decide(order({ size: 3 }), ctx)).toEqual({ status: 'FILLED', size: 3, price: new Decimal(100) });
  });

  it('LIMIT stays NEW at the limit price', () => {
    expect(decide(order({ type: 'LIMIT', size: 3, price: '90' }), ctx)).toEqual({ status: 'NEW', size: 3, price: new Decimal(90) });
  });

  it('amount buys the most whole shares: floor(999.99 / 100) = 9', () => {
    expect(decide(order({ amount: '999.99' }), ctx)).toMatchObject({ status: 'FILLED', size: 9 });
  });

  it('LIMIT amount uses the limit price: floor(1000 / 90) = 11', () => {
    expect(decide(order({ type: 'LIMIT', amount: '1000', price: '90' }), { ...ctx, available: new Decimal(2000) })).toMatchObject({ size: 11, status: 'NEW' });
  });

  it('spending exactly all available cash is allowed', () => {
    expect(decide(order({ size: 10 }), ctx)).toMatchObject({ status: 'FILLED' });
  });

  it('one cent more than available cash → REJECTED INSUFFICIENT_FUNDS', () => {
    expect(decide(order({ size: 10 }), { ...ctx, available: new Decimal('999.99') })).toMatchObject({
      status: 'REJECTED',
      reason: 'INSUFFICIENT_FUNDS',
    });
  });

  it('SELL by amount sells floor(amount / close) shares, if the user has them', () => {
    expect(decide(order({ side: 'SELL', amount: '1000' }), shares(5))).toMatchObject({ status: 'REJECTED', size: 10, reason: 'INSUFFICIENT_SHARES' });
    expect(decide(order({ side: 'SELL', amount: '1000' }), shares(10))).toMatchObject({ status: 'FILLED', size: 10 });
  });

  it('SELL above available shares → REJECTED INSUFFICIENT_SHARES; SELL all → FILLED', () => {
    expect(decide(order({ side: 'SELL', size: 6 }), shares(5))).toMatchObject({ status: 'REJECTED', reason: 'INSUFFICIENT_SHARES' });
    expect(decide(order({ side: 'SELL', size: 5 }), shares(5))).toMatchObject({ status: 'FILLED' });
  });

  it('MARKET without market data → REJECTED NO_MARKET_PRICE; LIMIT does not need it', () => {
    const noData = { ...ctx, close: null };
    expect(decide(order({ size: 1 }), noData)).toEqual({ status: 'REJECTED', size: 1, price: null, reason: 'NO_MARKET_PRICE' });
    expect(decide(order({ type: 'LIMIT', size: 1, price: '10' }), noData)).toMatchObject({ status: 'NEW' });
  });

  it('MARKET by amount without market data → REJECTED NO_MARKET_PRICE, size 0: no size can be computed', () => {
    expect(decide(order({ amount: '100' }), { ...ctx, close: null })).toEqual({ status: 'REJECTED', size: 0, price: null, reason: 'NO_MARKET_PRICE' });
  });

  it('amount below one share → REJECTED AMOUNT_BELOW_ONE_SHARE, size 0, at the price used', () => {
    expect(decide(order({ amount: '99.99' }), ctx)).toEqual({ status: 'REJECTED', size: 0, price: new Decimal(100), reason: 'AMOUNT_BELOW_ONE_SHARE' });
    expect(decide(order({ type: 'LIMIT', amount: '89.99', price: '90' }), ctx)).toEqual({ status: 'REJECTED', size: 0, price: new Decimal(90), reason: 'AMOUNT_BELOW_ONE_SHARE' });
  });

  it('a computed size above the INT column is invalid', () => {
    expect(decide(order({ amount: '1000000000000' }), { ...ctx, close: new Decimal('0.01') })).toEqual({ invalid: 'AMOUNT_TOO_LARGE' });
  });

  it('uses exact decimals: 0.1 + 0.2 style errors cannot reject a payable order', () => {
    const tight = { close: new Decimal('0.10'), available: new Decimal('0.30') };
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
