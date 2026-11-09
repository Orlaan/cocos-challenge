import { toProblem } from './problem';

describe('toProblem', () => {
  // Postgres ended the statement or the transaction, so nothing was saved.
  it.each(['55P03', '57014', '25P03'])('SQLSTATE %s → 503: a retry is safe', (code) => {
    expect(toProblem(Object.assign(new Error('canceled'), { code }))).toMatchObject({ status: 503, code: 'BUSY' });
  });

  // What pg-pool throws when Postgres is down at connect time (seen through a closed proxy): nothing was sent.
  it('a database that refuses the connection → 503: a retry is safe', () => {
    expect(toProblem(Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }))).toMatchObject({ status: 503, code: 'BUSY' });
  });

  it('an unknown database host → 500: a configuration error, retrying does not help', () => {
    expect(toProblem(Object.assign(new AggregateError([]), { code: 'ENOTFOUND' }))).toMatchObject({ status: 500 });
  });

  it('a connection lost for any other reason → 500: the outcome is unknown', () => {
    expect(toProblem(Object.assign(new Error('Connection terminated unexpectedly'), { code: undefined }))).toMatchObject({ status: 500 });
  });
});
