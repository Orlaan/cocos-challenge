import { Sql } from '../database/db';
import type { OrderStatus, Reason } from './decide';
import type { PlaceOrder } from './order.dto';

export interface Order {
  id: number;
  instrumentId: number;
  userId: number;
  side: PlaceOrder['side'];
  type: PlaceOrder['type'];
  size: number;
  price: string | null;
  status: OrderStatus;
  datetime: string;
  reason?: Reason;
}

// `datetime` is TIMESTAMP without zone; the API writes and reads it as UTC.
const ORDER_COLUMNS = `id, instrumentid AS "instrumentId", userid AS "userId", side, type, size, price, status,
  to_char(datetime, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS datetime`;

/** The instrument's type, or null if it does not exist. */
export async function instrumentType(sql: Sql, instrumentId: number): Promise<string | null> {
  const [row] = await sql<{ type: string }>('SELECT type FROM instruments WHERE id = $1', [instrumentId]);
  return row?.type ?? null;
}

export interface NewOrder {
  instrumentId: number;
  side: PlaceOrder['side'];
  type: PlaceOrder['type'];
  size: number;
  price: string | null;
  status: OrderStatus;
}

export async function insert(sql: Sql, userId: number, o: NewOrder): Promise<Order> {
  // clock_timestamp(), not now(): the time the order executes, after any lock wait, so it matches the price it used.
  const [saved] = await sql<Order>(
    `INSERT INTO orders (instrumentid, userid, side, type, size, price, status, datetime)
     VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() AT TIME ZONE 'UTC')
     RETURNING ${ORDER_COLUMNS}`,
    [o.instrumentId, userId, o.side, o.type, o.size, o.price, o.status],
  );
  return saved;
}

/** One conditional UPDATE: only a NEW order of this user is cancelled. Null when nothing matched. */
export async function cancelNew(sql: Sql, userId: number, orderId: number): Promise<Order | null> {
  const [cancelled] = await sql<Order>(
    `UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW' RETURNING ${ORDER_COLUMNS}`,
    [orderId, userId],
  );
  return cancelled ?? null;
}

/**
 * Why a cancel matched nothing, in one query: undefined → no such user;
 * status null → no such order for this user; else the order's current status.
 */
export async function cancelMiss(sql: Sql, userId: number, orderId: number): Promise<{ status: string | null } | undefined> {
  const [found] = await sql<{ status: string | null }>(
    'SELECT o.status FROM users u LEFT JOIN orders o ON o.id = $2 AND o.userid = u.id WHERE u.id = $1',
    [userId, orderId],
  );
  return found;
}
