import { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Problem } from './problem';

/** A body that is not JSON → 415. Without this, a text/plain body arrives empty and reads as "every field missing" (400). */
export class JsonBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // is() is null without a body (a GET, a cancel) and false for a body of another type. A POST with no body
    // and no Content-Type still sends `Content-Length: 0`, so only a declared type is checked.
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers['content-type'] && req.is('application/json') === false) {
      throw new Problem(415, 'HTTP_415', 'Content-Type must be application/json');
    }
    return true;
  }
}
