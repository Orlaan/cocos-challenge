import { Body, Controller, Headers, HttpCode, Injectable, Logger, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import Decimal from '../money';
import { DataSource } from 'typeorm';
import { lockUser, Sql, transaction } from '../db';
import { IdPipe } from '../id.pipe';
import { availableShares, cash, latestQuotes } from '../ledger';
import { Problem } from '../problem';
import { decide, Reason, Status } from './decide';
import * as idempotency from './idempotency';
import { keyError, PlaceOrder, shapeError } from './order.dto';

export interface Order {
  id: number;
  instrumentId: number;
  userId: number;
  side: PlaceOrder['side'];
  type: PlaceOrder['type'];
  size: number | null;
  price: string | null;
  status: Status | 'CANCELLED';
  datetime: string;
  reason?: Reason;
}

// `datetime` is TIMESTAMP without zone; the API writes and reads it as UTC.
const ORDER_COLUMNS = `id, instrumentid AS "instrumentId", userid AS "userId", side, type, size, price, status,
  to_char(datetime, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS datetime`;

@Injectable()
export class OrdersService {
  private readonly log = new Logger('Orders');

  constructor(private readonly ds: DataSource) {}

  /** Lock the user, read the price and what they have, decide, record: one transaction. */
  async place(userId: number, order: PlaceOrder, key?: string): Promise<{ order: Order; replayed: boolean }> {
    const problem = shapeError(order) ?? keyError(key);
    if (problem) throw new Problem(400, 'VALIDATION_ERROR', problem);
    const started = Date.now();

    const result = await transaction(this.ds, async (sql) => {
      await lockUser(sql, userId);
      // A retry gets its first answer, even if the instrument has changed since.
      const replayed = key ? await idempotency.replay<Order>(sql, userId, key, order) : null;
      if (replayed) return { order: replayed, replayed: true };

      const [instrument] = await sql<{ type: string }>('SELECT type FROM instruments WHERE id = $1', [order.instrumentId]);
      if (!instrument) throw new Problem(404, 'INSTRUMENT_NOT_FOUND');
      if (instrument.type === 'MONEDA') throw new Problem(400, 'INSTRUMENT_NOT_TRADABLE', 'ARS is cash, not a tradable asset');
      // The price is read after the lock wait, so a MARKET order fills at the latest close.
      const quote = (await latestQuotes(sql, [order.instrumentId])).get(order.instrumentId);
      const close = quote ? new Decimal(quote.close) : null;
      const decision = decide(order, { close, available: await this.available(sql, userId, order) });
      if ('invalid' in decision) throw new Problem(400, decision.invalid);

      // The audit trigger (db/local-additions.sql) reads the reason from this transaction-local setting.
      if (decision.reason) await sql(`SELECT set_config('app.order_reason', $1, true)`, [decision.reason]);
      // clock_timestamp(), not now(): the time the order executes, after any lock wait, so it matches the price it used.
      const [saved] = await sql<Order>(
        `INSERT INTO orders (instrumentid, userid, side, type, size, price, status, datetime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() AT TIME ZONE 'UTC')
         RETURNING ${ORDER_COLUMNS}`,
        [order.instrumentId, userId, order.side, order.type, decision.size, decision.price?.toFixed(2), decision.status],
      );
      const recorded = decision.reason ? { ...saved, reason: decision.reason } : saved;
      if (key) await idempotency.save(sql, userId, key, order, recorded);
      return { order: recorded, replayed: false };
    });

    const { id, status, reason } = result.order;
    this.log.log(JSON.stringify({ event: 'order', userId, orderId: id, status, reason, replayed: result.replayed, ms: Date.now() - started }));
    return result;
  }

  /** Cash for a BUY, shares for a SELL: one query, because it runs under the lock. */
  private async available(sql: Sql, userId: number, order: PlaceOrder): Promise<Decimal> {
    return order.side === 'BUY'
      ? (await cash(sql, userId)).available
      : new Decimal(await availableShares(sql, userId, order.instrumentId));
  }

  /**
   * Only a NEW order can be cancelled; the conditional UPDATE makes that check and the change one atomic step.
   * It needs no user lock: cancelling only frees cash or shares, so an order deciding at the same moment
   * can at worst see less available than there is (it may reject), never more (it cannot overspend).
   */
  async cancel(userId: number, orderId: number): Promise<Order> {
    const cancelled = await transaction(this.ds, async (sql) => {
      const [cancelled] = await sql<Order>(
        `UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW' RETURNING ${ORDER_COLUMNS}`,
        [orderId, userId],
      );
      if (cancelled) return cancelled;
      // Nothing was cancelled. One query tells why: no user row → unknown user; no order row → not theirs.
      const [found] = await sql<{ status: string | null }>(
        'SELECT o.status FROM users u LEFT JOIN orders o ON o.id = $2 AND o.userid = u.id WHERE u.id = $1',
        [userId, orderId],
      );
      if (!found) throw new Problem(404, 'USER_NOT_FOUND');
      if (!found.status) throw new Problem(404, 'ORDER_NOT_FOUND');
      throw new Problem(409, 'ORDER_NOT_CANCELLABLE', `Order is ${found.status}; only NEW orders can be cancelled`);
    });
    this.log.log(JSON.stringify({ event: 'cancel', userId, orderId })); // after the commit
    return cancelled;
  }
}

@Controller('users/:userId/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 201 for every recorded order, REJECTED included: the rejection is a saved fact, not a failed request. */
  @Post()
  async place(
    @Param('userId', IdPipe) userId: number,
    @Body() body: PlaceOrder,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Order> {
    const { order, replayed } = await this.orders.place(userId, body, key);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return order;
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  cancel(@Param('userId', IdPipe) userId: number, @Param('orderId', IdPipe) orderId: number): Promise<Order> {
    return this.orders.cancel(userId, orderId);
  }
}
