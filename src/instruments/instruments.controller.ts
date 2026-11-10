import { Controller, Get, Query } from '@nestjs/common';
import { Problem } from '../common/problem';
import { InstrumentsService } from './instruments.service';

@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get()
  search(@Query('q') q?: string) {
    const term = typeof q === 'string' ? q.trim() : '';
    if (term.length < 1 || term.length > 50) {
      throw new Problem(400, 'VALIDATION_ERROR', 'q must have 1 to 50 characters');
    }
    if (term.includes('\0')) {
      throw new Problem(400, 'VALIDATION_ERROR', 'q must not contain a NUL byte'); // Postgres text cannot hold it
    }
    return this.instruments.search(term);
  }
}
