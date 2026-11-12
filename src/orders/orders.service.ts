import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Problem } from '../common/problem';
import { Sql, transaction } from '../database/db';
import { availableShares, cash, lockUser } from '../ledger.repository';
import { latestQuotes } from '../marketdata.repository';
import Decimal from '../money';
import { decide } from './decide';
import * as idempotency from './idempotency.repository';
import { PlaceOrder } from './order.dto';
import * as orders from './orders.repository';
import type { Order } from './orders.repository';

@Injectable()
export class OrdersService {
  private readonly log = new Logger('Orders');

  constructor(private readonly ds: DataSource) {}

  /** Lock the user, read the price and what they have, decide, record: one transaction. */
  async place(userId: number, order: PlaceOrder, key?: string): Promise<{ order: Order; replayed: boolean }> {
    const result = await transaction(this.ds, async (sql) => {
      await lockUser(sql, userId);
      // A retry gets its first answer, even if the instrument has changed since.
      const stored = key ? await idempotency.replay<Order>(sql, userId, key, order) : null;
      if (stored) return { order: stored, replayed: true };

      const type = await orders.instrumentType(sql, order.instrumentId);
      if (!type) throw new Problem(404, 'INSTRUMENT_NOT_FOUND');
      if (type === 'MONEDA') throw new Problem(400, 'INSTRUMENT_NOT_TRADABLE', 'ARS is cash, not a tradable asset');
      // The price is read after the lock wait, so a MARKET order fills at the latest close.
      const quote = (await latestQuotes(sql, [order.instrumentId])).get(order.instrumentId);
      const close = quote ? new Decimal(quote.close) : null;
      const decision = decide(order, { close, available: await this.available(sql, userId, order) });
      if ('invalid' in decision) throw new Problem(400, decision.invalid);

      const saved = await orders.insert(sql, userId, {
        instrumentId: order.instrumentId,
        side: order.side,
        type: order.type,
        size: decision.size,
        price: decision.price?.toFixed(2) ?? null,
        status: decision.status,
      });
      const recorded = decision.reason ? { ...saved, reason: decision.reason } : saved;
      if (key) await idempotency.save(sql, userId, key, order, recorded);
      return { order: recorded, replayed: false };
    });

    const { id, status, reason } = result.order;
    this.log.log({ event: 'order', userId, orderId: id, status, reason, replayed: result.replayed });
    return result;
  }

  /** Cash for a BUY, shares for a SELL: one query, because it runs under the lock. */
  private async available(sql: Sql, userId: number, order: PlaceOrder): Promise<Decimal> {
    return order.side === 'BUY' ? (await cash(sql, userId)).available : new Decimal(await availableShares(sql, userId, order.instrumentId));
  }

  /** No user lock: cancelling only frees cash or shares (D-09). */
  async cancel(userId: number, orderId: number): Promise<Order> {
    const cancelled = await transaction(this.ds, async (sql) => {
      const cancelled = await orders.cancelNew(sql, userId, orderId);
      if (cancelled) return cancelled;
      const found = await orders.cancelMiss(sql, userId, orderId);
      if (!found) throw new Problem(404, 'USER_NOT_FOUND');
      if (!found.status) throw new Problem(404, 'ORDER_NOT_FOUND');
      throw new Problem(409, 'ORDER_NOT_CANCELLABLE', `Order is ${found.status}; only NEW orders can be cancelled`);
    });
    this.log.log({ event: 'cancel', userId, orderId }); // after the commit
    return cancelled;
  }
}
