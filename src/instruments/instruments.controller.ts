import { Controller, Get, Query } from '@nestjs/common';
import { InstrumentsService } from './instruments.service';
import { SearchQuery } from './search.dto';

@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get()
  search(@Query() query: SearchQuery) {
    return this.instruments.search(query.q.trim());
  }
}
