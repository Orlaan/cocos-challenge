import Decimal from './money';

describe('money precision', () => {
  it('keeps every cent past 20 significant digits (decimal.js would round there by default)', () => {
    expect(new Decimal('123456789012345678901.23').minus('0.01').toFixed(2)).toBe('123456789012345678901.22');
  });
});
