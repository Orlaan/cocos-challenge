import { Body, Controller, Headers, HttpCode, Injectable, Logger, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { Sql, transaction, withUserLock } from '../db';
import { IdPipe } from '../id.pipe';
import { availableShares, cash, latestQuotes } from '../ledger';
import { Problem } from '../problem';
import { decide, shapeError } from './decide';
import { Idempotency } from './idempotency';
import { PlaceOrder } from './order.dto';

// `datetime` is TIMESTAMP without zone; the API writes and reads it as UTC.
const ORDER = `id, instrumentid AS "instrumentId", userid AS "userId", side, type, size, price, status,
  to_char(datetime, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS datetime`;

@Injectable()
export class OrdersService {
  private readonly log = new Logger('Orders');

  constructor(
    private readonly ds: DataSource,
    private readonly idempotency: Idempotency,
  ) {}

  /** Read what the user has, decide, record. All under the user's lock, in one transaction. */
  async place(userId: number, order: PlaceOrder, key?: string) {
    const problem = shapeError(order);
    if (problem) throw new Problem(400, 'VALIDATION_ERROR', problem);
    const idemKey = this.idempotency.enabled ? key : undefined;
    const started = Date.now();

    const result = await withUserLock(this.ds, userId, async (sql) => {
      const replayed = idemKey && (await this.idempotency.replay(sql, userId, idemKey, order));
      if (replayed) return { body: replayed, replayed: true };

      const [instrument] = await sql<{ type: string }>('SELECT type FROM instruments WHERE id = $1', [order.instrumentId]);
      if (!instrument) throw new Problem(404, 'INSTRUMENT_NOT_FOUND');
      if (instrument.type === 'MONEDA') throw new Problem(400, 'INSTRUMENT_NOT_TRADABLE', 'ARS is cash, not a tradable asset');

      const decision = decide(order, await this.book(sql, userId, order));
      if ('invalid' in decision) throw new Problem(400, decision.invalid);

      const [saved] = await sql(
        `INSERT INTO orders (instrumentid, userid, side, type, size, price, status, datetime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE 'UTC')
         RETURNING ${ORDER}`,
        [order.instrumentId, userId, order.side, order.type, decision.size, decision.price?.toFixed(2), decision.status],
      );
      const body = decision.reason ? { ...saved, reason: decision.reason } : saved;
      if (idemKey) await this.idempotency.save(sql, userId, idemKey, order, body);
      return { body, replayed: false };
    });

    const { id, status, reason } = result.body as { id: number; status: string; reason?: string };
    this.log.log(JSON.stringify({ event: 'order', userId, orderId: id, status, reason, replayed: result.replayed, ms: Date.now() - started }));
    return result;
  }

  private async book(sql: Sql, userId: number, order: PlaceOrder) {
    const [money, quotes, shares] = await Promise.all([
      cash(sql, userId),
      latestQuotes(sql, [order.instrumentId]),
      order.side === 'SELL' ? availableShares(sql, userId, order.instrumentId) : 0,
    ]);
    const quote = quotes.get(order.instrumentId);
    return { close: quote ? new Decimal(quote.close) : null, availableCash: money.available, availableShares: shares };
  }

  /** Only a NEW order can be cancelled; the conditional UPDATE makes that check and the change one atomic step. */
  cancel(userId: number, orderId: number) {
    return transaction(this.ds, async (sql) => {
      const [cancelled] = await sql(
        `UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW' RETURNING ${ORDER}`,
        [orderId, userId],
      );
      if (cancelled) return cancelled;
      const [found] = await sql<{ status: string | null }>(
        'SELECT o.status FROM users u LEFT JOIN orders o ON o.id = $2 AND o.userid = u.id WHERE u.id = $1',
        [userId, orderId],
      );
      if (!found) throw new Problem(404, 'USER_NOT_FOUND');
      if (!found.status) throw new Problem(404, 'ORDER_NOT_FOUND');
      throw new Problem(409, 'ORDER_NOT_CANCELLABLE', `Order is ${found.status}; only NEW orders can be cancelled`);
    });
  }
}

@Controller('users/:userId/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** 201 for every recorded order, REJECTED included: the rejection is a saved fact, not a failed request. */
  @Post()
  async place(
    @Param('userId', IdPipe) userId: number,
    @Body() order: PlaceOrder,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (key !== undefined && (key.length < 1 || key.length > 255)) {
      throw new Problem(400, 'VALIDATION_ERROR', 'Idempotency-Key must have 1 to 255 characters');
    }
    const { body, replayed } = await this.orders.place(userId, order, key);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return body;
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  cancel(@Param('userId', IdPipe) userId: number, @Param('orderId', IdPipe) orderId: number) {
    return this.orders.cancel(userId, orderId);
  }
}
