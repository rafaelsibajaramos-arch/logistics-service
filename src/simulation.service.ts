import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { LogisticsService } from './logistics.service';
import { LogisticsAccessService } from './logistics-access.service';
import { SimulationControlDto } from './logistics.dto';
import { simulationElapsed, simulationOperation, simulationProgress, simulationTimeline, SimulationTimeline } from './simulation-engine';

@Injectable()
export class SimulationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(SimulationService.name);
  constructor(private readonly db: PrismaService, private readonly logistics: LogisticsService, private readonly access: LogisticsAccessService) {}
  onModuleInit() { this.timer = setInterval(() => void this.tick(), 2000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async control(routeId: string, dto: SimulationControlDto, actorId: string, roles: string[]) {
    await this.access.manageRoute(routeId, actorId, roles);
    const route = await this.db.route.findUniqueOrThrow({ where: { id: routeId }, include: { driver: true, stops: { orderBy: { sequence: 'asc' } }, simulation: true } });
    if (!route.driver.simulated) throw new ConflictException('Asigna un repartidor marcado como simulado para iniciar este recorrido');
    if (!['planned', 'in_transit'].includes(route.status)) throw new ConflictException('La ruta ya está cerrada');
    if (route.simulation?.status === 'completed') throw new ConflictException('El recorrido simulado ya terminó');
    if (!route.simulation) {
      if (dto.action !== 'start' || route.status !== 'planned' || route.stops.some(s => s.actualAt)) throw new ConflictException('Inicia una ruta nueva para simular');
      const road = route.roadPlan as unknown as { geometry: { type: string; coordinates: number[][] }; duration: number; serviceMinutes?: number };
      const timeline = simulationTimeline(road?.geometry, road?.duration, route.stops, route.driver.preparationMinutes * 60, (road.serviceMinutes ?? 2) * 60, route.scheduledDate);
      await this.db.routeSimulation.create({ data: { routeId, actorId, status: 'paused', timeline: timeline as unknown as Prisma.InputJsonValue, speed: dto.speed ?? 30, confirmationDelaySeconds: dto.confirmationDelaySeconds ?? 45 } }).catch(async e => { if ((e as { code?: string }).code !== 'P2002') throw e; });
    }
    // The existing dispatch gate verifies Wompi, locks the payment and emits
    // the same domain events as a real route. Simulation never invents payment.
    if (route.status === 'planned' && dto.action === 'start') await this.logistics.dispatchRoute(routeId, actorId, true, simulationOperation('dispatch:' + routeId), randomUUID());
    return this.db.$transaction(async tx => {
      const sim = await tx.routeSimulation.findUniqueOrThrow({ where: { routeId } });
      if (sim.leaseUntil && sim.leaseUntil > new Date()) throw new ConflictException('El recorrido está actualizando una parada. Reintenta en unos segundos');
      const elapsedSeconds = simulationElapsed(sim);
      if (dto.action === 'start' && sim.status === 'running') return sim;
      const status = dto.action === 'pause' ? 'paused' : dto.action === 'speed' ? sim.status : 'running';
      const updated = await tx.routeSimulation.update({ where: { routeId }, data: { status, elapsedSeconds, anchorAt: new Date(), speed: dto.speed ?? sim.speed, error: null } });
      await tx.routeActivity.create({ data: { routeId, actorId, operationId: randomUUID(), kind: 'simulation_' + dto.action, message: `Recorrido SIMULADO: ${dto.action}; velocidad ${updated.speed}x. No corresponde a GPS real.` } });
      return updated;
    }, { isolationLevel: 'Serializable' });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.db.routeSimulation.findMany({ where: { status: 'running', OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, select: { id: true, routeId: true, status: true, speed: true, elapsedSeconds: true, anchorAt: true }, take: 20, orderBy: { updatedAt: 'asc' } });
      for (const row of rows) {
        const leaseToken = randomUUID();
        const claimed = await this.db.routeSimulation.updateMany({ where: { id: row.id, status: 'running', OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseToken, leaseUntil: new Date(Date.now() + 30000) } });
        if (!claimed.count) continue;
        try { await this.advance(row.routeId, leaseToken); }
        catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== 'P2034') {
            this.logger.warn(`Recorrido ${row.routeId} pausado: ${(error as Error).message}`);
            await this.db.routeSimulation.updateMany({ where: { id: row.id, leaseToken }, data: { status: 'paused', elapsedSeconds: simulationElapsed(row), anchorAt: new Date(), error: 'No se pudo avanzar de forma segura. Revisa la ruta y reanuda.' } });
          }
        } finally { await this.db.routeSimulation.updateMany({ where: { id: row.id, leaseToken }, data: { leaseUntil: null, leaseToken: null } }); }
      }
    } catch (e) { this.logger.warn(`Motor de recorridos: ${(e as Error).message}`); }
    finally { this.running = false; }
  }
  async advance(routeId: string, leaseToken: string) {
    const sim = await this.db.routeSimulation.findUniqueOrThrow({ where: { routeId }, include: { route: { include: { deliveries: { include: { lots: true } } } } } });
    if (sim.leaseToken !== leaseToken || sim.status !== 'running') return;
    if (sim.route.status !== 'in_transit') {
      await this.db.routeSimulation.updateMany({ where: { routeId, leaseToken }, data: { status: 'completed' } }); return;
    }
    const timeline = sim.timeline as unknown as SimulationTimeline;
    const elapsed = simulationElapsed(sim), position = simulationProgress(timeline, elapsed);
    await this.db.route.updateMany({ where: { id: routeId, status: 'in_transit' }, data: { lastLatitude: position.latitude, lastLongitude: position.longitude, lastPositionAt: new Date(), lastAccuracy: 0 } });
    for (let i = sim.cursor; i < timeline.stops.length; i++) {
      const stop = timeline.stops[i]; if (stop.arrivalSeconds > elapsed) break;
      const lease = await this.db.routeSimulation.updateMany({ where: { routeId, leaseToken, status: 'running' }, data: { leaseUntil: new Date(Date.now() + 30000) } });
      if (!lease.count) return;
      await this.logistics.arriveAtStop(routeId, stop.id, sim.actorId, true, simulationOperation('arrive:' + routeId + ':' + stop.id));
      if (stop.type === 'dropoff') await this.db.delivery.updateMany({ where: { id: stop.deliveryId, status: 'in_transit', transportCompletedAt: null }, data: { transportCompletedAt: new Date() } });
      await this.db.routeSimulation.updateMany({ where: { routeId, leaseToken }, data: { cursor: i + 1 } });
    }
    // Real wall-clock grace gives the buyer time to report partial receipt,
    // even at accelerated speed. It survives process/browser restarts.
    const due = await this.db.delivery.findMany({ where: { routeId, status: 'in_transit', transportCompletedAt: { lte: new Date(Date.now() - sim.confirmationDelaySeconds * 1000) } }, include: { lots: true } });
    for (const delivery of due) {
      if (!(await this.db.routeSimulation.updateMany({ where: { routeId, leaseToken, status: 'running' }, data: { leaseUntil: new Date(Date.now() + 30000) } })).count) return;
      await this.logistics.closeDelivery(delivery.id, { status: 'completed', acceptedLots: delivery.lots.map(l => ({ reservationId: l.reservationId, acceptedQuantityKg: Number(l.quantityKg) })) }, sim.actorId, true, simulationOperation('auto-receipt:' + delivery.id), randomUUID(), false, true).catch(async e => {
        const latest = await this.db.delivery.findUnique({ where: { id: delivery.id } });
        if (!latest?.closedAt) throw e;
      });
    }
    if (!await this.db.delivery.count({ where: { routeId, status: { in: ['scheduled', 'in_transit'] } } })) await this.db.routeSimulation.updateMany({ where: { routeId, leaseToken }, data: { status: 'completed', elapsedSeconds: Math.min(elapsed, timeline.duration), anchorAt: new Date() } });
  }
}
