import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RabbitService } from './events/rabbit.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly rabbit: RabbitService) {}
  @Get() live() { return { status: 'ok', service: 'logistics-service', uptime_s: Math.round(process.uptime()) }; }
  @Get('ready')
  async ready() {
    try { await this.prisma.$queryRaw`SELECT 1`; }
    catch { throw new ServiceUnavailableException({ status: 'not_ready', checks: { postgres: 'down', rabbitmq: this.rabbit.isConnected() ? 'up' : 'down' } }); }
    if (!this.rabbit.isConnected()) throw new ServiceUnavailableException({ status: 'not_ready', checks: { postgres: 'up', rabbitmq: 'down' } });
    return { status: 'ready', service: 'logistics-service', checks: { postgres: 'up', rabbitmq: 'up' } };
  }
}
