import { Logger } from '@nestjs/common';
import { toProblem } from './problem';

describe('toProblem', () => {
  // The filter logs every 500 and 503; here those logs are expected noise.
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  // Postgres ended the statement or the transaction, so nothing was saved.
  it.each(['55P03', '57014', '25P03'])('SQLSTATE %s → 503: a retry is safe', (code) => {
    expect(toProblem(Object.assign(new Error('canceled'), { code }))).toMatchObject({ status: 503, code: 'BUSY' });
  });

  // What pg-pool throws when Postgres is down at connect time (seen through a closed proxy): nothing was sent.
  it('a database that refuses the connection → 503: a retry is safe', () => {
    expect(toProblem(Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' }))).toMatchObject({ status: 503, code: 'BUSY' });
  });

  it.each([
    ['is starting or stopping', Object.assign(new Error('the database system is shutting down'), { code: '57P03' })],
    ['does not answer the connect in 3 s', new Error('Connection terminated due to connection timeout')],
  ])('a database that %s → 503: no query was sent', (_, error) => {
    expect(toProblem(error)).toMatchObject({ status: 503, code: 'BUSY' });
  });

  it('an unknown database host → 500: a configuration error, retrying does not help', () => {
    expect(toProblem(Object.assign(new AggregateError([]), { code: 'ENOTFOUND' }))).toMatchObject({ status: 500 });
  });

  it("a body-parser client error keeps its status: the client's mistake, not a 500", () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true });
    expect(toProblem(tooLarge)).toMatchObject({ status: 413, code: 'HTTP_413' });
  });

  it('a 4xx-looking error that is not marked safe to show → 500', () => {
    expect(toProblem(Object.assign(new Error('internal'), { status: 404 }))).toMatchObject({ status: 500 });
  });

  it('a connection lost for any other reason → 500: the outcome is unknown', () => {
    expect(toProblem(Object.assign(new Error('Connection terminated unexpectedly'), { code: undefined }))).toMatchObject({ status: 500 });
  });
});
