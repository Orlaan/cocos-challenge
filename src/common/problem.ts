import { HttpException, Logger } from '@nestjs/common';
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
// The database refused the connection, is starting or stopping (57P03), or did not answer it in 3 s:
// no query was sent. (An unknown host is a configuration error, not overload: a 500.)
const CONNECT_FAILED = ['ECONNREFUSED', '57P03'];
const CONNECT_TIMEOUT = /Connection terminated due to connection timeout/;

/** Why a request failed without saving anything, so a retry is safe; undefined for any other error. */
function busyCause(error: unknown): string | undefined {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (BUSY_SQLSTATES.includes(code ?? '')) return code;
  if (POOL_TIMEOUT.test(message ?? '')) return 'pool';
  if (CONNECT_FAILED.includes(code ?? '')) return code;
  if (CONNECT_TIMEOUT.test(message ?? '')) return 'connect';
  // Postgres ended a transaction left idle over 2 s (src/database/db.ts); its next query finds the connection gone.
  // Our queries run only inside the transaction, before COMMIT, so nothing was saved.
  if (error instanceof QueryRunnerAlreadyReleasedError) return 'idle';
}

const log = new Logger('ProblemFilter');

/** Maps any error to the Problem the client sees. Internal details never leave the server. */
export function toProblem(error: unknown): Problem {
  if (error instanceof Problem) return error;
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
    return new Problem(status, code, error.message);
  }
  // Express's body parser (body over 100 kB, charset not UTF-8) throws a 4xx `http-errors` error that Nest passes
  // through unwrapped. `expose` means its message is safe to show.
  const { status, expose, message } = (error ?? {}) as { status?: unknown; expose?: unknown; message?: string };
  if (expose === true && typeof status === 'number' && status >= 400 && status < 500) {
    return new Problem(status, `HTTP_${status}`, message);
  }
  const cause = busyCause(error);
  if (cause) {
    log.warn({ event: 'busy', cause });
    return new Problem(503, 'BUSY', 'The service is busy. Retry.');
  }
  // Anything else, a connection dropped mid-transaction included, is a 500: the outcome may be unknown
  // (a connection lost at COMMIT), so only a retry with the same Idempotency-Key is safe.
  log.error(error);
  return new Problem(500, 'INTERNAL_ERROR');
}
