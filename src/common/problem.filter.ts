import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { toProblem } from './problem';

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
