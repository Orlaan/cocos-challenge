import type { Quote, Trade } from '../ledger';
import { foldPositions } from './positions';

const trade = (side: 'BUY' | 'SELL', size: number, price: string, instrumentId = 1): Trade => ({
  instrumentId,
  ticker: `T${instrumentId}`,
  name: `Instrument ${instrumentId}`,
  side,
  size,
  price,
});
const quotes = (close: string, previousClose: string | null = close) => new Map<number, Quote>([[1, { close, previousClose }]]);

describe('foldPositions (weighted average cost)', () => {
  it('seed PAMP: buy 50 @ 930, sell 10 @ 940, close 925.85 → 40 shares, −0.45 % total, +0.44 % daily', () => {
    const [p] = foldPositions([trade('BUY', 50, '930'), trade('SELL', 10, '940')], quotes('925.85', '921.80'));
    expect(p).toMatchObject({ quantity: 40, marketValue: '37034.00', totalReturnPct: '-0.45', dailyReturnPct: '0.44' });
  });

  it('buys re-average the cost: 10 @ 100 + 10 @ 200 = avg 150; close 165 → +10 %', () => {
    const [p] = foldPositions([trade('BUY', 10, '100'), trade('BUY', 10, '200')], quotes('165'));
    expect(p).toMatchObject({ quantity: 20, marketValue: '3300.00', totalReturnPct: '10.00' });
  });

  it('sells keep the average: avg 150 after selling 15 of 20 is still 150', () => {
    const [p] = foldPositions([trade('BUY', 10, '100'), trade('BUY', 10, '200'), trade('SELL', 15, '500')], quotes('150'));
    expect(p).toMatchObject({ quantity: 5, totalReturnPct: '0.00' });
  });

  it('selling everything removes the position; buying again starts a new cost basis', () => {
    expect(foldPositions([trade('BUY', 10, '100'), trade('SELL', 10, '120')], quotes('130'))).toEqual([]);
    const [p] = foldPositions([trade('BUY', 10, '100'), trade('SELL', 10, '120'), trade('BUY', 4, '200')], quotes('220'));
    expect(p).toMatchObject({ quantity: 4, totalReturnPct: '10.00' });
  });

  it('seed BMA: buy 20, sell 30 → −10 shares, valued at the close, no total return', () => {
    const [p] = foldPositions([trade('BUY', 20, '1540'), trade('SELL', 30, '1530')], quotes('1502.80', '1520.25'));
    expect(p).toMatchObject({ quantity: -10, marketValue: '-15028.00', totalReturnPct: null, dailyReturnPct: '-1.15' });
  });

  it('a BUY that takes a negative position above zero restarts the cost at that price', () => {
    const [p] = foldPositions([trade('BUY', 20, '1540'), trade('SELL', 30, '1530'), trade('BUY', 15, '1000')], quotes('1100'));
    expect(p).toMatchObject({ quantity: 5, totalReturnPct: '10.00' }); // cost 5 × 1000, not mixed with the oversold history
  });

  it('no market data → quantity shown, no value, no returns', () => {
    const [p] = foldPositions([trade('BUY', 3, '10')], new Map());
    expect(p).toMatchObject({ quantity: 3, marketValue: null, totalReturnPct: null, dailyReturnPct: null });
  });

  it('keeps instruments apart', () => {
    const ps = foldPositions([trade('BUY', 1, '10', 1), trade('BUY', 2, '20', 2)], new Map());
    expect(ps.map((p) => [p.instrumentId, p.quantity])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});
