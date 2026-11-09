import { startApi, TestApi } from './harness';

describe('GET /instruments?q=', () => {
  let api: TestApi;
  beforeAll(async () => (api = await startApi()));
  afterAll(() => api.close());

  const search = (q?: string) => api.http().get('/instruments').query(q === undefined ? {} : { q });
  const tickers = async (q: string) => (await search(q).expect(200)).body.map((i: any) => i.ticker);

  it('matches part of a ticker, any case', async () => {
    expect(await tickers('gga')).toContain('GGAL');
  });

  it('an exact ticker comes first', async () => {
    expect((await tickers('BMA'))[0]).toBe('BMA');
  });

  it('matches part of a name', async () => {
    expect(await tickers('macro')).toEqual(['BMA']); // Banco Macro S.A.
    expect(await tickers('compañía')).toContain('INTR');
  });

  it('returns id, ticker, name and type', async () => {
    const [ggal] = (await search('GGAL').expect(200)).body;
    expect(ggal).toEqual({ id: 34, ticker: 'GGAL', name: 'Grupo Financiero Galicia', type: 'ACCIONES' });
  });

  it('never lists ARS: it is cash (MONEDA), not a tradable asset', async () => {
    expect(await tickers('ARS')).not.toContain('ARS');
    expect(await tickers('pesos')).toEqual([]);
  });

  it('treats % and _ as plain characters, not wildcards', async () => {
    expect(await tickers('%')).toEqual([]);
    expect(await tickers('_')).toEqual([]);
  });

  it('returns at most 20 instruments', async () => {
    expect((await search('a').expect(200)).body).toHaveLength(20);
  });

  it('no match → 200 with an empty list', async () => {
    expect(await tickers('zzzz')).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['longer than 50 characters', 'x'.repeat(51)],
  ])('q %s → 400', async (_, q) => {
    const res = await search(q).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
