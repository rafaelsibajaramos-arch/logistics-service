import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { LogisticsService } from './logistics.service';
import { CreateDriverDto, CreateVehicleDto, DeliveryLocationDto, PlanRoadRouteDto, RouteIncidentDto, RoutePositionDto } from './logistics.dto';
import { OsrmClient, planningFingerprint, ProposalPayload, RoadStop, scheduleStops, sequenceStops } from './road-planner';

const activeStatuses = ['planned', 'in_transit'] as const;
const admin = (roles: string[]) => roles.some(r => ['admin', 'logistics_admin'].includes(r));
@Injectable()
export class OperationsService {
  constructor(private readonly db: PrismaService, private readonly logistics: LogisticsService) {}

  async updateVehicle(id: string, dto: CreateVehicleDto) {
    try {
      return await this.db.$transaction(async tx => {
        if (!await tx.vehicle.findUnique({ where: { id } })) throw new NotFoundException('Vehículo no encontrado');
        if (await tx.route.count({ where: { vehicleId: id, status: { in: [...activeStatuses] } } })) throw new ConflictException('Finaliza o cancela las rutas activas antes de editar este vehículo');
        return tx.vehicle.update({ where: { id }, data: { ...dto, plate: dto.plate.trim().toUpperCase(), capacityKg: dto.capacityKg, costPerKm: dto.costPerKm ?? null, brand: dto.brand?.trim(), model: dto.model?.trim(), insuranceUntil: dto.insuranceUntil ? new Date(dto.insuranceUntil) : null, inspectionUntil: dto.inspectionUntil ? new Date(dto.inspectionUntil) : null } });
      }, { isolationLevel: 'Serializable' });
    } catch (e) { if ((e as { code?: string }).code === 'P2002') throw new ConflictException('La placa ya está registrada'); throw e; }
  }
  async updateDriver(id: string, dto: CreateDriverDto) {
    try {
      return await this.db.$transaction(async tx => {
        if (!await tx.driver.findUnique({ where: { id } })) throw new NotFoundException('Conductor no encontrado');
        if (await tx.route.count({ where: { driverId: id, status: { in: [...activeStatuses] } } })) throw new ConflictException('No se puede editar un conductor con rutas activas');
        return tx.driver.update({ where: { id }, data: { ...dto, fullName: dto.fullName.trim(), licenseNumber: dto.licenseNumber.trim().toUpperCase(), phone: dto.phone.trim() } });
      }, { isolationLevel: 'Serializable' });
    } catch (e) { if ((e as { code?: string }).code === 'P2002') throw new ConflictException('La cuenta o licencia ya está registrada'); throw e; }
  }

  async locateDelivery(id: string, dto: DeliveryLocationDto, actorId: string, roles: string[]) {
    return this.db.$transaction(async tx => {
      const delivery = await tx.delivery.findUnique({ where: { id }, include: { plan: true } });
      if (!delivery) throw new NotFoundException('Entrega no encontrada');
      if (!admin(roles) && delivery.plan.buyerId !== actorId) throw new ForbiddenException('No puedes cambiar este destino');
      if (dto.requiresColdChain != null && !admin(roles)) throw new ForbiddenException('Solo logística establece el requisito de refrigeración');
      if (delivery.routeId || delivery.status !== 'scheduled') throw new ConflictException('El destino ya está asignado a una ruta y no puede cambiarse');
      const zone = await tx.zone.findUnique({ where: { code: dto.zoneCode.trim().toUpperCase() } });
      if (!zone?.active) throw new BadRequestException('Selecciona una zona activa');
      return tx.delivery.update({ where: { id }, data: { latitude: dto.latitude, longitude: dto.longitude, zoneCode: zone.code, requiresColdChain: dto.requiresColdChain ?? delivery.requiresColdChain, locationConfirmedAt: new Date() } });
    }, { isolationLevel: 'Serializable' });
  }

  async preview(dto: PlanRoadRouteDto, actorId: string) {
    const starts = new Date(dto.scheduledDate), ends = new Date(dto.scheduledEnd);
    if (starts <= new Date() || ends <= starts || ends.getTime() - starts.getTime() > 48 * 3600000) throw new BadRequestException('Planifica un horario futuro de hasta 48 horas');
    if (new Set(dto.deliveryIds).size !== dto.deliveryIds.length) throw new BadRequestException('No repitas entregas');
    const [vehicle, driver, zone, deliveries, conflicts] = await Promise.all([
      this.db.vehicle.findUnique({ where: { id: dto.vehicleId } }), this.db.driver.findUnique({ where: { id: dto.driverId } }),
      this.db.zone.findUnique({ where: { code: dto.zoneCode.trim().toUpperCase() } }),
      this.db.delivery.findMany({ where: { id: { in: dto.deliveryIds } }, include: { lots: true, plan: true } }),
      this.db.route.findMany({ where: { status: { in: [...activeStatuses] }, scheduledDate: { lt: ends }, scheduledEnd: { gt: starts }, OR: [{ driverId: dto.driverId }, { vehicleId: dto.vehicleId }] }, select: { id: true } }),
    ]);
    if (!vehicle?.active || vehicle.operationalStatus !== 'available') throw new ConflictException('El vehículo está inactivo, en mantenimiento o fuera de servicio');
    if (!driver?.active || !zone?.active) throw new ConflictException('Selecciona un conductor y una zona activos');
    if (conflicts.length) throw new ConflictException('El vehículo o conductor tiene otra ruta en ese horario');
    if (deliveries.length !== dto.deliveryIds.length || deliveries.some(d => d.status !== 'scheduled' || d.routeId || d.plan.status !== 'draft')) throw new ConflictException('Una entrega ya no está disponible para planificar');
    if (deliveries.some(d => d.latitude == null || d.longitude == null || !d.locationConfirmedAt || d.zoneCode !== zone.code)) throw new ConflictException('Confirma la ubicación y zona de todos los destinos antes de calcular');
    if (deliveries.some(d => d.requiresColdChain) && !vehicle.refrigerated) throw new ConflictException('La carga requiere un vehículo refrigerado');
    const stops: RoadStop[] = [];
    for (const d of deliveries) {
      const farms = [...new Set(d.lots.map(l => l.farmId))];
      for (const farmId of farms) {
        const lots = d.lots.filter(l => l.farmId === farmId), lot = lots[0];
        stops.push({ deliveryId: d.id, farmId, type: 'pickup', address: lot.pickupAddress, latitude: Number(lot.pickupLatitude), longitude: Number(lot.pickupLongitude), kg: lots.reduce((n, l) => n + Number(l.quantityKg), 0), earliest: starts.getTime(), latest: d.windowEnd.getTime() });
      }
      stops.push({ deliveryId: d.id, type: 'dropoff', address: d.deliveryAddress, latitude: d.latitude!, longitude: d.longitude!, kg: d.lots.reduce((n, l) => n + Number(l.quantityKg), 0), earliest: d.windowStart.getTime(), latest: d.windowEnd.getTime() });
    }
    if (stops.length > 25) throw new BadRequestException('Divide el trabajo en rutas de hasta 25 paradas');
    const origin = { latitude: dto.originLatitude, longitude: dto.originLongitude };
    const engine = new OsrmClient();
    const matrix = await engine.matrix([origin, ...stops]);
    const serviceMinutes = dto.serviceMinutes ?? 10;
    const sequence = sequenceStops(stops, matrix, starts.getTime(), ends.getTime(), Number(vehicle.capacityKg), serviceMinutes * 60);
    const road = await engine.route([origin, ...sequence.order.map(i => stops[i])]);
    const schedule = scheduleStops(stops, sequence.order, road.legs, starts.getTime(), ends.getTime(), Number(vehicle.capacityKg), serviceMinutes * 60);
    const payload: ProposalPayload = { dto: { ...dto, zoneCode: zone.code, stops: schedule.stops }, origin, fingerprint: planningFingerprint(driver, vehicle, deliveries), geometry: road.geometry, distance: road.distance, duration: road.duration, peakLoadKg: schedule.peakLoadKg, provider: 'OSRM', calculatedAt: new Date().toISOString(), estimatedEnd: schedule.estimatedEnd, serviceMinutes };
    if (vehicle.costPerKm != null) payload.estimatedCost = Math.round(road.distance / 1000 * Number(vehicle.costPerKm) * 100) / 100;
    // Short-lived durable proposal survives restarts. Purge only expired, unused proposals.
    await this.db.routeProposal.deleteMany({ where: { expiresAt: { lt: new Date() }, routeId: null } });
    const record = await this.db.routeProposal.create({ data: { actorId, expiresAt: new Date(Date.now() + 15 * 60000), payload: JSON.parse(JSON.stringify(payload)) } });
    return { proposalId: record.id, expiresAt: record.expiresAt, ...payload, warnings: ['Estimación sin tráfico en vivo. Revisa restricciones de acceso del vehículo.', ...(vehicle.insuranceUntil && vehicle.insuranceUntil < ends ? ['Revisar vencimiento de SOAT antes del despacho.'] : []), ...(vehicle.inspectionUntil && vehicle.inspectionUntil < ends ? ['Revisar vencimiento de revisión técnica.'] : [])] };
  }
  async confirmProposal(id: string, actorId: string, correlation: string) {
    const proposal = await this.db.routeProposal.findUnique({ where: { id } });
    if (!proposal || proposal.actorId !== actorId) throw new NotFoundException('Propuesta no encontrada');
    if (proposal.routeId) return this.db.route.findUniqueOrThrow({ where: { id: proposal.routeId } });
    if (proposal.expiresAt < new Date()) throw new ConflictException('La propuesta venció; vuelve a calcular');
    const data = proposal.payload as unknown as ProposalPayload;
    return this.logistics.createRoute(data.dto, correlation, { id, actorId, data });
  }

  private async routeAccess(id: string, userId: string, roles: string[]) {
    const route = await this.db.route.findUnique({ where: { id }, include: { driver: true, stops: { orderBy: { sequence: 'asc' } } } });
    if (!route) throw new NotFoundException('Ruta no encontrada');
    if (!admin(roles) && (!roles.includes('driver') || route.driver.userId !== userId)) throw new ForbiddenException('Esta ruta no está asignada a tu cuenta');
    return route;
  }
  async position(id: string, dto: RoutePositionDto, userId: string, roles: string[]) {
    const route = await this.routeAccess(id, userId, roles);
    if (!roles.includes('driver') || route.driver.userId !== userId) throw new ForbiddenException('Solo el conductor asignado comparte su ubicación');
    if (route.status !== 'in_transit') throw new ConflictException('La ubicación se comparte solo durante la ruta');
    const recorded = new Date(dto.recordedAt), now = Date.now();
    if (recorded.getTime() < now - 120000 || recorded.getTime() > now + 30000) throw new BadRequestException('La posición es antigua o su reloj no es válido');
    const updated = await this.db.route.updateMany({ where: { id, status: 'in_transit', OR: [{ lastPositionAt: null }, { lastPositionAt: { lt: recorded } }] }, data: { lastLatitude: dto.latitude, lastLongitude: dto.longitude, lastAccuracy: dto.accuracy, lastPositionAt: recorded } });
    return { accepted: updated.count === 1, recordedAt: recorded };
  }
  async incident(id: string, dto: RouteIncidentDto, userId: string, roles: string[], operationId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new BadRequestException('La incidencia requiere operation_id');
    return this.db.$transaction(async tx => {
      const route = await tx.route.findUnique({ where: { id }, include: { driver: true, deliveries: { include: { plan: { select: { buyerId: true } } } } } });
      if (!route) throw new NotFoundException('Ruta no encontrada');
      if (!admin(roles) && route.driver.userId !== userId) throw new ForbiddenException('Esta ruta no está asignada a tu cuenta');
      if (dto.deliveryId && !route.deliveries.some(d => d.id === dto.deliveryId)) throw new BadRequestException('La entrega no pertenece a esta ruta');
      const previous = await tx.routeActivity.findUnique({ where: { operationId } });
      if (previous) {
        if (previous.routeId !== id || previous.actorId !== userId || previous.message !== dto.message.trim() || previous.kind !== dto.kind || previous.deliveryId !== (dto.deliveryId ?? null)) throw new ConflictException('operation_id ya utilizado con otros datos');
        return previous;
      }
      if (route.status !== 'in_transit' && route.status !== 'planned') throw new ConflictException('La ruta ya está cerrada');
      const activity = await tx.routeActivity.create({ data: { routeId: id, actorId: userId, operationId, message: dto.message.trim(), kind: dto.kind, deliveryId: dto.deliveryId } });
      await tx.outboxEvent.create({ data: { eventType: 'logistics.incident_reported', aggregateId: id, correlationId: randomUUID(), payload: { route_id: id, incident_id: activity.id, kind: dto.kind } } });
      for (const delivery of route.deliveries.filter(d => !dto.deliveryId || d.id === dto.deliveryId)) {
        await tx.outboxEvent.create({ data: { eventType: 'delivery.incident_reported', aggregateId: delivery.id, correlationId: operationId, payload: { delivery_id: delivery.id, order_id: delivery.orderId, buyer_id: delivery.plan.buyerId, driver_user_id: route.driver.userId, incident_id: activity.id, kind: dto.kind } } });
      }
      return activity;
    }, { isolationLevel: 'Serializable' });
  }
  async resolveIncident(routeId: string, id: string, actorId: string) {
    const row = await this.db.routeActivity.findUnique({ where: { id } });
    if (!row || row.routeId !== routeId) throw new NotFoundException('Incidencia no encontrada');
    if (row.resolvedAt) return row;
    return this.db.routeActivity.update({ where: { id }, data: { resolvedAt: new Date(), resolvedBy: actorId } });
  }
  async cancelRoute(id: string, actorId: string) {
    return this.db.$transaction(async tx => {
      const route = await tx.route.findUnique({ where: { id }, include: { deliveries: true } });
      if (!route) throw new NotFoundException('Ruta no encontrada');
      if (route.status === 'cancelled') return route;
      if (route.status !== 'planned') throw new ConflictException('Solo se puede cancelar una ruta antes de despachar');
      if (await tx.delivery.count({ where: { planId: { in: route.deliveries.map(d => d.planId) }, routeId: { not: id }, status: { in: ['in_transit', 'completed', 'partial'] } } })) throw new ConflictException('Otra parte del pedido ya fue despachada; requiere resolución de logística');
      await tx.delivery.updateMany({ where: { routeId: id }, data: { routeId: null } });
      for (const planId of [...new Set(route.deliveries.map(d => d.planId))]) await tx.deliveryPlan.update({ where: { id: planId }, data: { status: 'draft', confirmedAt: null } });
      await tx.routeActivity.create({ data: { routeId: id, actorId, operationId: randomUUID(), kind: 'cancelled', message: 'Ruta cancelada antes del despacho. Entregas disponibles para replanificación.' } });
      return tx.route.update({ where: { id }, data: { status: 'cancelled' } });
    }, { isolationLevel: 'Serializable' });
  }
  async tracking(id: string, userId: string, roles: string[]) {
    const d = await this.db.delivery.findUnique({ where: { id }, include: { plan: true, stops: { orderBy: { sequence: 'asc' } }, route: { include: { driver: true, vehicle: true, activities: { where: { deliveryId: id }, orderBy: { createdAt: 'desc' }, take: 30 } } } } });
    if (!d) throw new NotFoundException('Entrega no encontrada');
    if (!admin(roles) && d.plan.buyerId !== userId && !(roles.includes('driver') && d.route?.driver.userId === userId)) throw new ForbiddenException('No puedes consultar esta entrega');
    const position = d.status === 'in_transit' && d.route?.lastPositionAt ? { latitude: d.route.lastLatitude, longitude: d.route.lastLongitude, accuracy: d.route.lastAccuracy, recordedAt: d.route.lastPositionAt, stale: Date.now() - d.route.lastPositionAt.getTime() > 120000 } : null;
    return { deliveryId: id, status: d.status, destination: { address: d.deliveryAddress, latitude: d.latitude, longitude: d.longitude }, vehicle: d.route ? { plate: d.route.vehicle.plate, kind: d.route.vehicle.kind } : null, position, stops: d.stops.filter(s => s.routeId === d.routeId).map(s => ({ id: s.id, type: s.type, plannedAt: s.plannedAt, actualAt: s.actualAt, address: s.address, latitude: s.latitude, longitude: s.longitude })), incidents: d.route?.activities.map(a => ({ id: a.id, kind: a.kind, message: a.message, createdAt: a.createdAt, resolvedAt: a.resolvedAt })) ?? [], dispatchedAt: d.dispatchedAt, deliveredAt: d.deliveredAt, closedAt: d.closedAt };
  }

  async overview() {
    const now = new Date(), cutoff = new Date(Date.now() - 30 * 86400000);
    const [routes, deliveries, vehicles, drivers, incidents, activeRoutes, pendingDeliveries, inTransit] = await Promise.all([
      this.db.route.findMany({ where: { scheduledDate: { gte: cutoff, lte: now }, status: { not: 'cancelled' } }, select: { distanceMeters: true, estimatedCost: true } }),
      this.db.delivery.findMany({ where: { windowEnd: { gte: cutoff, lte: now } }, select: { status: true, windowEnd: true, windowStart: true, deliveredAt: true, cancelledAt: true } }),
      this.db.vehicle.count({ where: { active: true, operationalStatus: 'available' } }), this.db.driver.count({ where: { active: true } }),
      this.db.routeActivity.count({ where: { resolvedAt: null, kind: { in: ['delay', 'damage', 'absence', 'breakdown', 'cold_chain', 'other'] } } }),
      this.db.route.count({ where: { status: 'in_transit' } }), this.db.delivery.count({ where: { status: 'scheduled' } }), this.db.delivery.count({ where: { status: 'in_transit' } }),
    ]);
    const due = deliveries.filter(d => !(d.status === 'cancelled' && d.cancelledAt && d.cancelledAt < d.windowStart));
    const onTime = due.filter(d => d.status === 'completed' && d.deliveredAt && d.deliveredAt >= d.windowStart && d.deliveredAt <= d.windowEnd).length;
    const costed = routes.filter(r => r.estimatedCost != null);
    return { activeRoutes, pendingDeliveries, inTransit, availableVehicles: vehicles, activeDrivers: drivers, openIncidents: incidents, distanceKm: routes.reduce((n, r) => n + (r.distanceMeters ?? 0), 0) / 1000, estimatedCost: costed.length ? costed.reduce((n, r) => n + Number(r.estimatedCost), 0) : null, costedRoutes: costed.length, onTimePercent: due.length ? Math.round(onTime / due.length * 100) : null, dueDeliveries: due.length, calculatedAt: now.toISOString(), periodDays: 30 };
  }
}
