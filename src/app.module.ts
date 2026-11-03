import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { LogisticsController } from './logistics.controller';
import { LogisticsService } from './logistics.service';
import { PrismaService } from './prisma.service';
import { OrdersConsumer } from './events/orders.consumer';
import { OutboxWorker } from './events/outbox.worker';
import { OperationsService } from './operations.service';
import { DatabaseConflictFilter } from './database-conflict.filter';
import { LogisticsAccessService } from './logistics-access.service';
import { SimulationService } from './simulation.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true }), EventsModule],
  controllers: [LogisticsController, HealthController],
  providers: [PrismaService, LogisticsAccessService, SimulationService, LogisticsService, OperationsService, OrdersConsumer, OutboxWorker, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: DatabaseConflictFilter }],
})
export class AppModule {}
