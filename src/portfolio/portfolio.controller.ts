import { Controller, Get, Param } from '@nestjs/common';
import { IdPipe } from '../common/id.pipe';
import { PortfolioService } from './portfolio.service';

@Controller('users/:userId/portfolio')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  get(@Param('userId', IdPipe) userId: number) {
    return this.portfolio.get(userId);
  }
}
