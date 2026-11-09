import { Body, Controller, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IdPipe } from '../common/id.pipe';
import { Problem } from '../common/problem';
import { keyError, PlaceOrder, shapeError } from './order.dto';
import { Order, OrdersService } from './orders.service';

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
    const problem = shapeError(body) ?? keyError(key);
    if (problem) throw new Problem(400, 'VALIDATION_ERROR', problem);
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
