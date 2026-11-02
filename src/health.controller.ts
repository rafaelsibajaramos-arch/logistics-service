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
    let osrm = 'not_configured';
    if (process.env.OSRM_URL) {
      try {
        const response = await fetch(process.env.OSRM_URL.replace(/\/$/, '') + '/nearest/v1/driving/-75.88,8.75', { signal: AbortSignal.timeout(1800) });
        const result = await response.json(); osrm = response.ok && result.code === 'Ok' ? 'up' : 'down';
      } catch { osrm = 'down'; }
    }
    return { status: 'ready', service: 'logistics-service', routingReady: osrm === 'up', checks: { postgres: 'up', rabbitmq: 'up', osrm } };
  }
}
