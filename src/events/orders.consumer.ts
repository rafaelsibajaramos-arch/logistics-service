import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEnvelope } from './event-envelope';
import { RabbitService } from './rabbit.service';
import { LogisticsService } from '../logistics.service';

const QUEUE = 'logistics-service.orders';

@Injectable()
export class OrdersConsumer implements OnModuleInit {
  private readonly logger = new Logger(OrdersConsumer.name);

  constructor(private readonly rabbit: RabbitService, private readonly logistics: LogisticsService) {}

  onModuleInit() {
    this.rabbit.register(QUEUE, ['order.confirmed', 'order.cancelled'], (event) => this.handle(event));
  }

  async handle(event: EventEnvelope) {
    if (event.source_service !== 'order-service') {
      this.logger.warn(`Evento ${event.event_type} ignorado desde source_service=${event.source_service}`);
      return;
    }
    if (event.event_type === 'order.confirmed') {
      const plan = await this.logistics.consumeOrderConfirmed(event);
      this.logger.log({ msg: 'order_confirmed_planned', order_id: plan.orderId, plan_id: plan.id, correlation_id: event.correlation_id });
      return;
    }
    if (event.event_type === 'order.cancelled') {
      await this.logistics.consumeOrderCancelled(event);
      this.logger.log({ msg: 'order_cancelled_processed', order_id: event.entity_id, correlation_id: event.correlation_id });
    }
  }
}
