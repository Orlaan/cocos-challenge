import { Inject, Module, OnApplicationShutdown, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { createDataSource } from './db';
import { InstrumentsController, InstrumentsService } from './instruments/instruments';
import { OrdersController, OrdersService } from './orders/orders';
import { PortfolioController, PortfolioService } from './portfolio/portfolio';
import { Problem, ProblemFilter } from './problem';

export const DATABASE_URL = Symbol('DATABASE_URL');

const validation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors) =>
    new Problem(400, 'VALIDATION_ERROR', errors.flatMap((e) => Object.values(e.constraints ?? {})).join('; ')),
});

@Module({
  controllers: [PortfolioController, InstrumentsController, OrdersController],
  providers: [
    { provide: DATABASE_URL, useFactory: () => process.env.DATABASE_URL },
    { provide: DataSource, inject: [DATABASE_URL], useFactory: (url: string) => createDataSource(url) },
    { provide: APP_PIPE, useValue: validation },
    { provide: APP_FILTER, useClass: ProblemFilter },
    PortfolioService,
    InstrumentsService,
    OrdersService,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  onApplicationShutdown() {
    return this.ds.destroy();
  }
}
