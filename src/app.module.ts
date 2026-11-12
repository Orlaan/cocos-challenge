import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JsonBodyGuard } from './common/json-body.guard';
import { Problem } from './common/problem';
import { ProblemFilter } from './common/problem.filter';
import { DatabaseModule } from './database/database.module';
import { InstrumentsModule } from './instruments/instruments.module';
import { OrdersModule } from './orders/orders.module';
import { PortfolioModule } from './portfolio/portfolio.module';

const validation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: (errors) =>
    new Problem(400, 'VALIDATION_ERROR', [...new Set(errors.flatMap((e) => Object.values(e.constraints ?? {})))].join('; ')),
});

// APP_GUARD, APP_PIPE and APP_FILTER as providers, not useGlobalPipes in main.ts, so the e2e tests run the same pipeline.
@Module({
  imports: [DatabaseModule, PortfolioModule, InstrumentsModule, OrdersModule],
  providers: [
    { provide: APP_GUARD, useClass: JsonBodyGuard },
    { provide: APP_PIPE, useValue: validation },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}
