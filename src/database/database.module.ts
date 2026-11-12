import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createDataSource } from './db';

/** The one connection pool. Global, like TypeOrmModule.forRoot: every feature injects `DataSource`. */
@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('Set DATABASE_URL (see .env.example)');
        return createDataSource(url);
      },
    },
  ],
  exports: [DataSource],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  onApplicationShutdown() {
    return this.ds.destroy();
  }
}
