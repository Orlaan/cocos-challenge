import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { transaction } from '../db';
import { Problem } from '../problem';

@Injectable()
export class InstrumentsService {
  constructor(private readonly ds: DataSource) {}

  /** Partial, case-insensitive match on ticker or name. ARS (MONEDA) is cash, not a tradable asset. */
  search(q: string) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // A transaction only to get the same timeouts as everything else (SET LOCAL is pooler-safe).
    return transaction(this.ds, (sql) => sql(
      `SELECT id, ticker, name, type
       FROM instruments
       WHERE type <> 'MONEDA' AND (ticker ILIKE $1 OR name ILIKE $1)
       ORDER BY upper(ticker) = upper($2) DESC, ticker
       LIMIT 20`,
      [pattern, q],
    ));
  }
}

@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get()
  search(@Query('q') q?: string) {
    const term = typeof q === 'string' ? q.trim() : '';
    if (term.length < 1 || term.length > 50) {
      throw new Problem(400, 'VALIDATION_ERROR', 'q must have 1 to 50 characters');
    }
    return this.instruments.search(term);
  }
}
