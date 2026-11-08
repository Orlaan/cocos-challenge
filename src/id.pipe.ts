import { Injectable, PipeTransform } from '@nestjs/common';
import { INT_MAX } from './limits';
import { Problem } from './problem';

/** Path ids must be positive integers that fit a Postgres INT; anything else is a 400, not a 500. */
@Injectable()
export class IdPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const id = /^[1-9]\d{0,9}$/.test(value) ? Number.parseInt(value, 10) : NaN;
    if (!(id <= INT_MAX)) throw new Problem(400, 'VALIDATION_ERROR', `Invalid id: ${value}`);
    return id;
  }
}
