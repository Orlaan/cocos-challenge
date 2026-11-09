import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { QueryRunnerAlreadyReleasedError } from 'typeorm';

/** An error the API returns on purpose, with a stable `code` the client can switch on. */
export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

// Overload, not a bug: the client should retry. 55P03 = lock_timeout, 57014 = statement_timeout,
// 25P03 = idle_in_transaction_session_timeout (Postgres rolled the transaction back).
const BUSY_SQLSTATES = ['55P03', '57014', '25P03'];
const POOL_TIMEOUT = /timeout exceeded when trying to connect/;
// The database refused the connection when the pool opened it: no query was sent. (An unknown host is
// a configuration error, not overload: a 500.)
const CONNECT_REFUSED = 'ECONNREFUSED';

/** Why a request failed without saving anything, so a retry is safe; undefined for any other error. */
function busyCause(error: unknown): string | undefined {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (BUSY_SQLSTATES.includes(code ?? '')) return code;
  if (POOL_TIMEOUT.test(message ?? '')) return 'pool';
  if (code === CONNECT_REFUSED) return code;
  // Postgres ended a transaction left idle over 2 s (src/db.ts); its next query finds the connection gone.
  // Our queries run only inside the transaction, before COMMIT, so nothing was saved.
  if (error instanceof QueryRunnerAlreadyReleasedError) return 'idle';
}

const log = new Logger('ProblemFilter');

/** Renders every error as RFC 9457 problem details. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const p = toProblem(error);
    if (p.status === 503) res.setHeader('Retry-After', '1');
    res
      .status(p.status)
      .type('application/problem+json')
      .json({ type: 'about:blank', title: STATUS_CODES[p.status], status: p.status, code: p.code, detail: p.detail });
  }
}

/** Maps any error to the Problem the client sees. Internal details never leave the server. */
export function toProblem(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
    return new Problem(status, code, error.message);
  }
  const cause = busyCause(error);
  if (cause) {
    log.warn(JSON.stringify({ event: 'busy', cause }));
    return new Problem(503, 'BUSY', 'The service is busy. Retry.');
  }
  // Anything else, a connection dropped mid-transaction included, is a 500: the outcome may be unknown
  // (a connection lost at COMMIT), so only a retry with the same Idempotency-Key is safe.
  log.error(error);
  return new Problem(500, 'INTERNAL_ERROR');
}
