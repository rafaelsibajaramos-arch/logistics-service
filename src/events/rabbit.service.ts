import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { AmqpConnectionManager, ChannelWrapper, connect } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { EventEnvelope } from './event-envelope';

@Injectable()
export class RabbitService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitService.name);
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private readonly consumers: ChannelWrapper[] = [];
  private readonly subscriptions: Array<{ queue: string; patterns: string[]; handler: (event: EventEnvelope) => Promise<void> }> = [];
  private connected = false;
  readonly exchange = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';
  isConnected() { return this.connected; }

  onModuleInit() {
    const url = process.env.RABBITMQ_URL;
    if (!url) { this.logger.warn('RABBITMQ_URL no está configurada; los eventos permanecerán en el outbox'); return; }
    this.connection = connect([url], { heartbeatIntervalInSeconds: 15 });
    this.connection.on('connect', () => { this.connected = true; this.logger.log('Conectado a RabbitMQ'); });
    this.connection.on('disconnect', ({ err }) => { this.connected = false; this.logger.warn(`RabbitMQ desconectado: ${err?.message ?? 'sin detalle'}`); });
    this.channel = this.connection.createChannel({ setup: async (channel: ConfirmChannel) => { await channel.assertExchange(this.exchange, 'topic', { durable: true }); } });
    for (const sub of this.subscriptions) this.startConsumer(sub);
  }

  register(queue: string, patterns: string[], handler: (event: EventEnvelope) => Promise<void>) {
    const sub = { queue, patterns, handler };
    this.subscriptions.push(sub);
    if (this.connection) this.startConsumer(sub);
  }

  async publish(routingKey: string, envelope: EventEnvelope) {
    if (!this.channel) throw new Error('Canal de publicación RabbitMQ no inicializado');
    await this.channel.publish(this.exchange, routingKey, Buffer.from(JSON.stringify(envelope)), {
      contentType: 'application/json', persistent: true, messageId: envelope.event_id,
      type: envelope.event_type, correlationId: envelope.correlation_id, timestamp: Date.parse(envelope.occurred_at),
      headers: { 'x-source-service': envelope.source_service, 'x-schema-version': envelope.schema_version },
    });
  }

  private startConsumer(sub: { queue: string; patterns: string[]; handler: (event: EventEnvelope) => Promise<void> }) {
    const channel = this.connection!.createChannel({ setup: async (ch: ConfirmChannel) => {
      const deadExchange = `${this.exchange}.dlx`;
      const deadQueue = `${sub.queue}.dead`;
      await ch.assertExchange(this.exchange, 'topic', { durable: true });
      await ch.assertExchange(deadExchange, 'topic', { durable: true });
      await ch.assertQueue(deadQueue, { durable: true });
      await ch.bindQueue(deadQueue, deadExchange, sub.queue);
      await ch.assertQueue(sub.queue, { durable: true, deadLetterExchange: deadExchange, deadLetterRoutingKey: sub.queue });
      for (const pattern of sub.patterns) await ch.bindQueue(sub.queue, this.exchange, pattern);
      await ch.prefetch(10);
      await ch.consume(sub.queue, (msg) => void this.handleMessage(ch, sub, msg));
    } });
    this.consumers.push(channel);
  }

  private async handleMessage(ch: ConfirmChannel, sub: { queue: string; handler: (event: EventEnvelope) => Promise<void> }, msg: import('amqplib').ConsumeMessage | null) {
    if (!msg) return;
    try {
      const event = JSON.parse(msg.content.toString()) as EventEnvelope;
      await sub.handler(event);
      if (process.env.NODE_ENV === 'test' && process.env.RABBITMQ_TEST_HOLD_BEFORE_ACK_MESSAGE_ID === event.event_id) {
        this.logger.warn(`Test fault injection paused before ACK for ${event.event_id}`);
        await new Promise<void>(() => undefined);
      }
      ch.ack(msg);
    } catch (error) {
      this.logger.error(`Fallo en ${sub.queue}: ${(error as Error).message}`);
      ch.nack(msg, false, !msg.fields.redelivered);
    }
  }

  async onApplicationShutdown() { await Promise.allSettled(this.consumers.map((consumer) => consumer.close())); await this.channel?.close(); await this.connection?.close(); }
}
