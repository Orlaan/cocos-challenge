import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { STATUS_CODES } from 'node:http';

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

// Overload, not a bug: the client should retry. 55P03 = lock_timeout, 57014 = statement_timeout.
const BUSY_SQLSTATES = ['55P03', '57014'];
const POOL_TIMEOUT = /timeout exceeded when trying to connect/;

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
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (BUSY_SQLSTATES.includes(code ?? '') || POOL_TIMEOUT.test(message ?? '')) {
    log.warn(JSON.stringify({ event: 'busy', cause: code ?? 'pool' }));
    return new Problem(503, 'BUSY', 'The service is busy. Retry.');
  }
  // Anything else, a dropped connection included, is a 500: the outcome may be unknown
  // (a connection lost at COMMIT), so only a retry with the same Idempotency-Key is safe.
  log.error(error);
  return new Problem(500, 'INTERNAL_ERROR');
}
