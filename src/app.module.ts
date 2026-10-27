import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { LogisticsController } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import { PrismaService } from './prisma.service';
import { OrdersConsumer } from './events/orders.consumer';
import { OutboxWorker } from './events/outbox.worker';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true }), EventsModule],
  controllers: [LogisticsController, HealthController],
  providers: [PrismaService, LogisticsService, OrdersConsumer, OutboxWorker, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
