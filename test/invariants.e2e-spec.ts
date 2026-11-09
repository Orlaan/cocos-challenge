import { assertInvariants, startApi, TestApi } from './harness';

// assertInvariants guards every e2e test, so it must catch a violation that later rows hide.
const insert = (row: string) => `INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime) VALUES ${row}`;
const cancel = (id: number) => `UPDATE orders SET status = 'CANCELLED' WHERE id = ${id}`;
const PAMP = 47; // user 1 has 627,500 available in the seed
const BMA = 31;

describe('assertInvariants', () => {
  let api: TestApi;
  beforeEach(async () => (api = await startApi()));
  afterEach(() => api.close(false)); // these databases hold violations on purpose
  const run = async (steps: string[]) => {
    for (const step of steps) await api.db.query(step);
    return assertInvariants(api.db);
  };

  it.each([
    ['an overspend, then a deposit that covers it', [insert(`(${PAMP},1,1000,1000,'BUY','FILLED','MARKET',now())`), insert(`(66,1,10000000,1,'CASH_IN','FILLED','MARKET',now())`)]],
    ['an overspend while a hold was open, then the hold cancelled', [insert(`(${PAMP},1,600,1000,'BUY','NEW','LIMIT',now())`), insert(`(${PAMP},1,100,1000,'BUY','FILLED','MARKET',now())`), cancel(12)]],
    ['BMA bought back to the seed level, then oversold again', [insert(`(${BMA},1,10,1000,'BUY','FILLED','MARKET',now())`), insert(`(${BMA},1,10,1000,'SELL','FILLED','MARKET',now())`)]],
  ])('catches %s', async (_, steps) => {
    await expect(run(steps)).rejects.toThrow();
  });

  it('passes a hold, its cancel, then a fill of the freed cash', async () => {
    await expect(run([insert(`(${PAMP},1,600,1000,'BUY','NEW','LIMIT',now())`), cancel(12), insert(`(${PAMP},1,600,1000,'BUY','FILLED','MARKET',now())`)])).resolves.toBeUndefined();
  });
});
