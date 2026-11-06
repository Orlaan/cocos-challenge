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

const LOCK_NOT_AVAILABLE = '55P03'; // Postgres SQLSTATE raised by lock_timeout

/** Renders every error as RFC 9457 problem details. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('ProblemFilter');

  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const p = this.toProblem(error);
    if (p.status === 503) res.setHeader('Retry-After', '1');
    res
      .status(p.status)
      .type('application/problem+json')
      .json({ type: 'about:blank', title: STATUS_CODES[p.status], status: p.status, code: p.code, detail: p.detail });
  }

  private toProblem(error: unknown): Problem {
    if (error instanceof Problem) return error;
    if (error instanceof HttpException) {
      const status = error.getStatus();
      return new Problem(status, status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', error.message);
    }
    if ((error as { code?: string })?.code === LOCK_NOT_AVAILABLE) {
      return new Problem(503, 'BUSY', 'Another order for this user is in progress. Retry.');
    }
    this.log.error(error);
    return new Problem(500, 'INTERNAL_ERROR');
  }
}
