import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { transaction } from '../database/db';
import * as instruments from './instruments.repository';

@Injectable()
export class InstrumentsService {
  constructor(private readonly ds: DataSource) {}

  search(q: string) {
    // A transaction only to get the same timeouts as everything else (SET LOCAL is pooler-safe).
    return transaction(this.ds, (sql) => instruments.search(sql, q));
  }
}
