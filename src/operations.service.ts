import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { LogisticsService } from './logistics.service';
import { CreateDriverDto, CreateVehicleDto, DeliveryDispatchDto, DeliveryLocationDto, PlanRoadRouteDto, RouteIncidentDto, RoutePositionDto } from './logistics.dto';
import { OsrmClient, planningFingerprint, ProposalPayload, RoadStop, scheduleStops, sequenceStops } from './road-planner';
import { LogisticsAccessService } from './logistics-access.service';
import { simulationElapsed, simulationProgress, SimulationTimeline } from './simulation-engine';
import { meters } from './simulation-engine';
import { bicycleNeedsProfile, cityKey, roadLimitKm, tripWithinVehicleRange } from './fleet-location';

const activeStatuses = ['planned', 'in_transit'] as const;
const admin = (roles: string[]) => roles.some(r => ['admin', 'logistics_admin'].includes(r));
@Injectable()
export class OperationsService {
  constructor(private readonly db: PrismaService, private readonly logistics: LogisticsService, private readonly access: LogisticsAccessService = new LogisticsAccessService(db)) {}

  async updateVehicle(id: string, dto: CreateVehicleDto) {
    if ((dto.minimumLoadKg ?? 0) > dto.capacityKg) throw new BadRequestException('La carga mínima supera la capacidad del vehículo');
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
        const existing = await tx.driver.findUnique({ where: { id } });
        if (!existing) throw new NotFoundException('Conductor no encontrado');
        if (dto.simulated != null && dto.simulated !== existing.simulated) throw new ConflictException('Registra un perfil nuevo para cambiar entre transporte real y simulado');
        if (await tx.route.count({ where: { driverId: id, status: { in: [...activeStatuses] } } })) throw new ConflictException('No se puede editar un conductor con rutas activas');
        return tx.driver.update({ where: { id }, data: { ...dto, fullName: dto.fullName.trim(), licenseNumber: dto.licenseNumber.trim().toUpperCase(), phone: dto.phone.trim() } });
      }, { isolationLevel: 'Serializable' });
    } catch (e) { if ((e as { code?: string }).code === 'P2002') throw new ConflictException('La cuenta o licencia ya está registrada'); throw e; }
  }

  async locateDelivery(id: string, dto: DeliveryLocationDto, actorId: string, roles: string[]) {
    return this.db.$transaction(async tx => {
      const delivery = await tx.delivery.findUnique({ where: { id }, include: { plan: true } });
      if (!delivery) throw new NotFoundException('Entrega no encontrada');
      if (!admin(roles) && delivery.plan.buyerId !== actorId) await this.access.manageDeliveries([id], actorId, roles);
      if ((dto.pickupReadyAt || dto.pickupDeadlineAt) && !admin(roles)) await this.access.manageDeliveries([id], actorId, roles);
      const ready = dto.pickupReadyAt ? new Date(dto.pickupReadyAt) : delivery.pickupReadyAt;
      const deadline = dto.pickupDeadlineAt ? new Date(dto.pickupDeadlineAt) : delivery.pickupDeadlineAt;
      if (ready && deadline && deadline <= ready) throw new BadRequestException('El límite de recogida debe ser posterior a la disponibilidad');
      if (ready && ready >= delivery.windowEnd || deadline && deadline > delivery.windowEnd) throw new BadRequestException('La recogida debe caber en la ventana de entrega');
      if (dto.requiresColdChain != null && !admin(roles)) throw new ForbiddenException('Solo logística establece el requisito de refrigeración');
      if (delivery.routeId || delivery.status !== 'scheduled') throw new ConflictException('El destino ya está asignado a una ruta y no puede cambiarse');
      const code = dto.zoneCode.trim().toUpperCase();
      const zone = code === 'AUTO' ? await tx.zone.upsert({ where: { code: 'AUTO' }, create: { code: 'AUTO', name: 'Distribución automática' }, update: {} }) : await tx.zone.findUnique({ where: { code } });
      if (!zone?.active) throw new BadRequestException('Selecciona una zona activa');
      return tx.delivery.update({ where: { id }, data: { latitude: dto.latitude, longitude: dto.longitude, zoneCode: zone.code, requiresColdChain: dto.requiresColdChain ?? delivery.requiresColdChain, locationConfirmedAt: new Date(), ...(dto.pickupReadyAt ? { pickupReadyAt: new Date(dto.pickupReadyAt) } : {}), ...(dto.pickupDeadlineAt ? { pickupDeadlineAt: new Date(dto.pickupDeadlineAt) } : {}) } });
    }, { isolationLevel: 'Serializable' });
  }

  async setDispatchPoint(id: string, dto: DeliveryDispatchDto, actorId: string, roles: string[]) {
    await this.access.manageDeliveries([id], actorId, roles);
    const delivery = await this.db.delivery.findUnique({ where: { id }, include: { lots: true } });
    if (!delivery) throw new NotFoundException('Entrega no encontrada');
    if (delivery.routeId || delivery.status !== 'scheduled') throw new ConflictException('El punto de recogida ya no se puede cambiar');
    if (new Set(delivery.lots.map(l => l.farmId)).size !== 1) throw new ConflictException('Esta entrega reúne varias fincas. Administración debe coordinar sus recogidas por separado');
    await new OsrmClient().verifyRoadPoint({ latitude: dto.latitude, longitude: dto.longitude });
    const updated = await this.db.delivery.updateMany({ where: { id, routeId: null, status: 'scheduled' }, data: { dispatchAddress: dto.address.trim(), dispatchLatitude: dto.latitude, dispatchLongitude: dto.longitude } });
    if (!updated.count) throw new ConflictException('La entrega cambió mientras confirmabas la recogida');
    return this.db.delivery.findUniqueOrThrow({ where: { id } });
  }

  async autoPlan(ids: string[], actorId: string, roles: string[]) {
    if (!ids.length || ids.length > 12 || new Set(ids).size !== ids.length) throw new BadRequestException('Selecciona entre 1 y 12 entregas distintas');
    await this.access.manageDeliveries(ids, actorId, roles);
    const deliveries = await this.db.delivery.findMany({ where: { id: { in: ids } }, include: { lots: true } });
    if (deliveries.length !== ids.length || deliveries.some(d => d.status !== 'scheduled' || d.routeId)) throw new ConflictException('Una entrega ya está asignada o cerrada. Actualiza la lista');
    if (deliveries.some(d => d.latitude == null || d.longitude == null || d.lots.some(l => l.pickupLatitude == null || l.pickupLongitude == null))) throw new ConflictException('Confirma la dirección del comprador y el punto de recogida antes de asignar');
    const total = deliveries.reduce((n,d) => n + d.lots.reduce((sum,l) => sum + Number(l.quantityKg), 0), 0);
    const largest = Math.max(...deliveries.map(d => d.lots.reduce((n,l) => n + Number(l.quantityKg), 0)));
    const cold = deliveries.some(d => d.requiresColdChain);
    const [drivers, fleet] = await Promise.all([
      this.db.driver.findMany({ where: { active: true, simulated: true, baseCity: { not: null }, baseDepartment: { not: null } }, orderBy: [{ preparationMinutes: 'asc' }, { fullName: 'asc' }] }),
      this.db.vehicle.findMany({ where: { active: true, operationalStatus: 'available', capacityKg: { gte: largest }, minimumLoadKg: { lte: total }, ...(cold ? { refrigerated: true } : {}) }, orderBy: { capacityKg: 'asc' } }),
    ]);
    if (!drivers.length || !fleet.length) throw new ConflictException('No hay repartidores simulados o vehículos compatibles. Revisa la flota o divide la carga');
    const pickup = { pickupLatitude: deliveries[0].dispatchLatitude ?? deliveries[0].lots[0].pickupLatitude, pickupLongitude: deliveries[0].dispatchLongitude ?? deliveries[0].lots[0].pickupLongitude };
    const candidates = fleet.filter(v => {
      if (!v.baseAddress?.trim() || v.baseLatitude == null || v.baseLongitude == null || !cityKey(v.baseCity, v.baseDepartment)) return false;
      if (!drivers.some(d => cityKey(d.baseCity, d.baseDepartment) === cityKey(v.baseCity, v.baseDepartment))) return false;
      if (bicycleNeedsProfile(v.kind) && !process.env.OSRM_BICYCLE_URL) return false;
      return deliveries.every(d => d.lots.every(l => {
        const from = [Number(d.dispatchLongitude ?? l.pickupLongitude), Number(d.dispatchLatitude ?? l.pickupLatitude)] as [number, number];
        return tripWithinVehicleRange(v.kind, [Number(v.baseLongitude), Number(v.baseLatitude)], from, [Number(d.longitude), Number(d.latitude)]);
      }));
    }).sort((a,b) => {
      const distance = (v: typeof a) => meters([Number(v.baseLongitude), Number(v.baseLatitude)], [Number(pickup.pickupLongitude), Number(pickup.pickupLatitude)]);
      return Math.floor(distance(a) / 1000) - Math.floor(distance(b) / 1000) || Number(Number(a.capacityKg) < total) - Number(Number(b.capacityKg) < total) || Number(a.capacityKg) - Number(b.capacityKg);
    });
    if (!candidates.length) throw new ConflictException('No hay un vehículo adecuado para la distancia y el lugar de recogida. Una bicicleta solo puede cubrir recorridos locales. Revisa la flota o divide las entregas.');
    const commonZone = deliveries.every(d => d.zoneCode && d.zoneCode === deliveries[0].zoneCode) ? deliveries[0].zoneCode : null;
    const existingZone = commonZone ? await this.db.zone.findUnique({ where: { code: commonZone } }) : null;
    const zone = existingZone?.active ? existingZone : await this.db.zone.upsert({ where: { code: 'AUTO' }, create: { code: 'AUTO', name: 'Distribución automática' }, update: {} });
    if (!zone.active) throw new ConflictException('Administración deshabilitó la distribución automática');
    await this.db.$transaction(async tx => {
      const updated = await tx.delivery.updateMany({ where: { id: { in: ids }, routeId: null, status: 'scheduled' }, data: { zoneCode: zone.code, locationConfirmedAt: new Date() } });
      if (updated.count !== ids.length) throw new ConflictException('Las entregas cambiaron. Vuelve a calcular');
    }, { isolationLevel: 'Serializable' });
    const bookings = await this.db.route.findMany({ where: { status: { in: ['planned', 'in_transit'] } }, select: { driverId: true, vehicleId: true, scheduledDate: true, scheduledEnd: true, status: true } });
    let attempts = 0, reason = 'No hay un horario compatible para agrupar estas entregas';
    for (const vehicle of candidates) for (const driver of drivers) {
      if (cityKey(driver.baseCity, driver.baseDepartment) !== cityKey(vehicle.baseCity, vehicle.baseDepartment)) continue;
      const starts = new Date(Math.max(Date.now() + (driver.preparationMinutes + 2) * 60000, Math.min(...deliveries.map(d => d.windowStart.getTime())), ...deliveries.map(d => d.pickupReadyAt?.getTime() ?? 0)));
      const ends = new Date(Math.min(starts.getTime() + 12 * 3600000, ...deliveries.map(d => d.windowEnd.getTime())));
      if (ends <= starts) { reason = 'La ventana de entrega venció o no permite tiempo para recoger'; continue; }
      if (bookings.some(b => (b.vehicleId === vehicle.id || b.driverId === driver.id) && (b.scheduledDate < ends && b.scheduledEnd > starts || b.status === 'in_transit' && b.scheduledEnd <= new Date()))) continue;
      if (++attempts > 18) throw new ConflictException(reason + '. Divide las entregas o usa la planificación avanzada');
      try {
        const proposal = await this.preview({ driverId: driver.id, vehicleId: vehicle.id, zoneCode: zone.code, scheduledDate: starts.toISOString(), scheduledEnd: ends.toISOString(), deliveryIds: ids, originLatitude: Number(vehicle.baseLatitude), originLongitude: Number(vehicle.baseLongitude), serviceMinutes: 2 }, actorId, roles);
        return { ...proposal, automatic: true, selection: { driver: driver.fullName, vehicle: vehicle.plate, kind: vehicle.kind, capacityKg: vehicle.capacityKg, totalKg: total, zone: zone.name, baseCity: vehicle.baseCity, baseDepartment: vehicle.baseDepartment, originAddress: vehicle.baseAddress, approachKm: Math.round(meters([Number(vehicle.baseLongitude), Number(vehicle.baseLatitude)], [Number(pickup.pickupLongitude), Number(pickup.pickupLatitude)]) / 100) / 10 } };
      } catch (e) { if (!(e instanceof ConflictException || e instanceof BadRequestException)) throw e; reason = e.message; }
    }
    throw new ConflictException(reason + '. No se asignó ninguna ruta; divide las entregas o usa la planificación avanzada');
  }

  async preview(dto: PlanRoadRouteDto, actorId: string, roles: string[] = ['admin']) {
    await this.access.manageDeliveries(dto.deliveryIds, actorId, roles);
    if (dto.zoneCode.trim().toUpperCase() === 'AUTO') {
      const automatic = await this.db.zone.upsert({ where: { code: 'AUTO' }, create: { code: 'AUTO', name: 'Distribución automática' }, update: {} });
      if (!automatic.active) throw new ConflictException('Administración deshabilitó la distribución automática');
      await this.db.delivery.updateMany({ where: { id: { in: dto.deliveryIds }, status: 'scheduled', routeId: null, latitude: { not: null }, longitude: { not: null } }, data: { zoneCode: 'AUTO', locationConfirmedAt: new Date() } });
    }
    const starts = new Date(dto.scheduledDate), ends = new Date(dto.scheduledEnd);
    if (starts <= new Date() || ends <= starts || ends.getTime() - starts.getTime() > 48 * 3600000) throw new BadRequestException('Planifica un horario futuro de hasta 48 horas');
    if (new Set(dto.deliveryIds).size !== dto.deliveryIds.length) throw new BadRequestException('No repitas entregas');
    const [vehicle, driver, zone, deliveries, conflicts] = await Promise.all([
      this.db.vehicle.findUnique({ where: { id: dto.vehicleId } }), this.db.driver.findUnique({ where: { id: dto.driverId } }),
      this.db.zone.findUnique({ where: { code: dto.zoneCode.trim().toUpperCase() } }),
      this.db.delivery.findMany({ where: { id: { in: dto.deliveryIds } }, include: { lots: true, plan: true } }),
      this.db.route.findMany({ where: { AND: [
        { OR: [{ driverId: dto.driverId }, { vehicleId: dto.vehicleId }] },
        { OR: [{ status: { in: [...activeStatuses] }, scheduledDate: { lt: ends }, scheduledEnd: { gt: starts } }, { status: 'in_transit', scheduledEnd: { lte: new Date() } }] },
      ] }, select: { id: true } }),
    ]);
    if (!vehicle?.active || vehicle.operationalStatus !== 'available') throw new ConflictException('El vehículo está inactivo, en mantenimiento o fuera de servicio');
    if (!driver?.active || !zone?.active) throw new ConflictException('Selecciona un conductor y una zona activos');
    if (!cityKey(driver.baseCity, driver.baseDepartment) || cityKey(driver.baseCity, driver.baseDepartment) !== cityKey(vehicle.baseCity, vehicle.baseDepartment)) throw new ConflictException('El conductor y el vehículo deben estar asignados a la misma ciudad base');
    if (vehicle.baseLatitude == null || vehicle.baseLongitude == null || meters([Number(vehicle.baseLongitude), Number(vehicle.baseLatitude)], [dto.originLongitude, dto.originLatitude]) > 250) throw new ConflictException('La ruta debe salir de la base registrada del vehículo');
    if (bicycleNeedsProfile(vehicle.kind) && !process.env.OSRM_BICYCLE_URL) throw new ConflictException('Las bicicletas requieren un motor de rutas aptas para bicicleta antes de asignarlas');
    if (starts.getTime() < Date.now() + (driver.preparationMinutes ?? 15) * 60000) throw new ConflictException(`El conductor necesita al menos ${driver.preparationMinutes ?? 15} minutos para preparar la recogida`);
    if (conflicts.length) throw new ConflictException('El vehículo o conductor tiene otra ruta en ese horario');
    if (deliveries.length !== dto.deliveryIds.length || deliveries.some(d => d.status !== 'scheduled' || d.routeId || d.plan.status !== 'draft')) throw new ConflictException('Una entrega ya no está disponible para planificar');
    if (deliveries.some(d => d.latitude == null || d.longitude == null || !d.locationConfirmedAt || d.zoneCode !== zone.code)) throw new ConflictException('Confirma la ubicación y zona de todos los destinos antes de calcular');
    if (deliveries.some(d => d.requiresColdChain) && !vehicle.refrigerated) throw new ConflictException('La carga requiere un vehículo refrigerado');
    const stops: RoadStop[] = [];
    for (const d of deliveries) {
      const farms = [...new Set(d.lots.map(l => l.farmId))];
      for (const farmId of farms) {
        const lots = d.lots.filter(l => l.farmId === farmId), lot = lots[0];
        stops.push({ deliveryId: d.id, farmId, type: 'pickup', address: d.dispatchAddress ?? lot.pickupAddress, latitude: d.dispatchLatitude ?? Number(lot.pickupLatitude), longitude: d.dispatchLongitude ?? Number(lot.pickupLongitude), kg: lots.reduce((n, l) => n + Number(l.quantityKg), 0), earliest: Math.max(starts.getTime(), d.pickupReadyAt?.getTime() ?? 0), latest: Math.min(d.windowEnd.getTime(), d.pickupDeadlineAt?.getTime() ?? Infinity) });
      }
      stops.push({ deliveryId: d.id, type: 'dropoff', address: d.deliveryAddress, latitude: d.latitude!, longitude: d.longitude!, kg: d.lots.reduce((n, l) => n + Number(l.quantityKg), 0), earliest: d.windowStart.getTime(), latest: d.windowEnd.getTime() });
    }
    if (stops.length > 25) throw new BadRequestException('Divide el trabajo en rutas de hasta 25 paradas');
    const origin = { latitude: dto.originLatitude, longitude: dto.originLongitude };
    if (deliveries.some(d => stops.filter(s => s.deliveryId === d.id && s.type === 'pickup').some(p => !tripWithinVehicleRange(vehicle.kind, [origin.longitude, origin.latitude], [p.longitude, p.latitude], [Number(d.longitude), Number(d.latitude)])))) throw new ConflictException('El trayecto es demasiado largo para este tipo de vehículo. Selecciona uno adecuado para la distancia.');
    const engine = new OsrmClient(bicycleNeedsProfile(vehicle.kind) ? 'bicycle' : 'driving');
    const matrix = await engine.matrix([origin, ...stops]);
    const serviceMinutes = dto.serviceMinutes ?? 10;
    const sequence = sequenceStops(stops, matrix, starts.getTime(), ends.getTime(), Number(vehicle.capacityKg), serviceMinutes * 60);
    const road = await engine.route([origin, ...sequence.order.map(i => stops[i])]);
    if (road.distance > roadLimitKm(vehicle.kind) * 1000) throw new ConflictException('El recorrido supera la distancia permitida para este tipo de vehículo. Elige otro transporte o divide las entregas.');
    const schedule = scheduleStops(stops, sequence.order, road.legs, starts.getTime(), ends.getTime(), Number(vehicle.capacityKg), serviceMinutes * 60);
    if (schedule.peakLoadKg < Number(vehicle.minimumLoadKg ?? 0)) throw new ConflictException('La carga de esta ruta es inferior al mínimo admitido por el vehículo');
    // Avoid formally feasible but unreasonable pooling detours. Compare each
    // pickup-to-dropoff journey with its direct road travel plus service time.
    for (const d of deliveries) {
      const drop = schedule.stops.find(s => s.deliveryId === d.id && s.type === 'dropoff')!;
      const picks = schedule.stops.filter(s => s.deliveryId === d.id && s.type === 'pickup');
      for (const pickup of picks) {
        const a = stops.findIndex(s => s.deliveryId === d.id && s.type === 'pickup' && s.farmId === pickup.farmId), b = stops.findIndex(s => s.deliveryId === d.id && s.type === 'dropoff');
        const direct = matrix[a + 1][b + 1];
        if (direct != null && new Date(drop.plannedAt).getTime() - new Date(pickup.plannedAt).getTime() > (direct * 1.8 + 20 * 60 + serviceMinutes * 60) * 1000) throw new ConflictException('La agrupación provoca un desvío excesivo para una entrega. Divide la carga en rutas más próximas');
      }
    }
    const payload: ProposalPayload = { dto: { ...dto, zoneCode: zone.code, stops: schedule.stops }, origin, fingerprint: planningFingerprint(driver, vehicle, deliveries), geometry: road.geometry, distance: road.distance, duration: road.duration, peakLoadKg: schedule.peakLoadKg, provider: 'OSRM', calculatedAt: new Date().toISOString(), estimatedEnd: schedule.estimatedEnd, serviceMinutes };
    if (vehicle.costPerKm != null) payload.estimatedCost = Math.round(road.distance / 1000 * Number(vehicle.costPerKm) * 100) / 100;
    // Short-lived durable proposal survives restarts. Purge only expired, unused proposals.
    await this.db.routeProposal.deleteMany({ where: { expiresAt: { lt: new Date() }, routeId: null } });
    const record = await this.db.routeProposal.create({ data: { actorId, expiresAt: new Date(Date.now() + 15 * 60000), payload: JSON.parse(JSON.stringify(payload)) } });
    return { proposalId: record.id, expiresAt: record.expiresAt, ...payload, warnings: ['Estimación sin tráfico en vivo. Revisa restricciones de acceso del vehículo.', ...(vehicle.insuranceUntil && vehicle.insuranceUntil < ends ? ['Revisar vencimiento de SOAT antes del despacho.'] : []), ...(vehicle.inspectionUntil && vehicle.inspectionUntil < ends ? ['Revisar vencimiento de revisión técnica.'] : [])] };
  }
  async confirmProposal(id: string, actorId: string, correlation: string, roles: string[] = ['admin']) {
    const proposal = await this.db.routeProposal.findUnique({ where: { id } });
    if (!proposal || proposal.actorId !== actorId) throw new NotFoundException('Propuesta no encontrada');
    if (proposal.routeId) return this.db.route.findUniqueOrThrow({ where: { id: proposal.routeId } });
    if (proposal.expiresAt < new Date()) throw new ConflictException('La propuesta venció; vuelve a calcular');
    const data = proposal.payload as unknown as ProposalPayload;
    await this.access.manageDeliveries(data.dto.deliveryIds, actorId, roles);
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
    if (await this.db.routeSimulation.findUnique({ where: { routeId: id } })) throw new ConflictException('La ruta usa posiciones simuladas; no se mezclan con GPS real');
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
    const d = await this.db.delivery.findUnique({ where: { id }, include: { lots: true, plan: true, stops: { orderBy: { sequence: 'asc' } }, route: { include: { simulation: true, driver: true, vehicle: true, activities: { where: { deliveryId: id }, orderBy: { createdAt: 'desc' }, take: 30 } } } } });
    if (!d) throw new NotFoundException('Entrega no encontrada');
    const producerId = admin(roles) ? null : await this.access.producerId(userId, roles);
    if (!admin(roles) && d.plan.buyerId !== userId && !(roles.includes('driver') && d.route?.driver.userId === userId) && !(producerId && d.lots?.some(l => l.producerId === producerId))) throw new ForbiddenException('No puedes consultar esta entrega');
    const sim = d.route?.simulation;
    const plan = sim?.timeline as unknown as SimulationTimeline | undefined;
    const elapsed = sim ? simulationElapsed(sim) : 0;
    const progress = plan ? simulationProgress(plan, elapsed) : null;
    const ownStop = plan?.stops.find(s => s.type === 'dropoff' && s.deliveryId === id);
    const active = d.status === 'in_transit';
    const position = active && d.route?.lastPositionAt ? { latitude: d.route.lastLatitude, longitude: d.route.lastLongitude, accuracy: d.route.lastAccuracy, recordedAt: d.route.lastPositionAt, stale: Date.now() - d.route.lastPositionAt.getTime() > (sim ? 15000 : 120000), simulated: !!sim } : null;
    const stops = d.stops.filter(s => s.routeId === d.routeId);
    const arrived = stops.some(s => s.type === 'dropoff' && s.actualAt);
    const picked = stops.filter(s => s.type === 'pickup').every(s => !!s.actualAt);
    const remainingMeters = ownStop && progress ? Math.max(0, ownStop.distance - progress.distance) : null;
    const etaSeconds = ownStop && sim?.status === 'running' && active ? Math.max(0, ownStop.arrivalSeconds - elapsed) / sim.speed : null;
    let geometry = null;
    if (plan && ownStop) { let index = plan.cumulative.findIndex(x => x >= ownStop.distance); if (index < 0) index = plan.coordinates.length - 1; geometry = { type: 'LineString', coordinates: plan.coordinates.slice(0, Math.max(2, index + 1)) }; }
    const stage = d.closedAt ? 'completed' : arrived ? 'arrived' : active ? plan && elapsed < plan.preparationSeconds ? 'preparing' : !picked ? 'picking_up' : remainingMeters != null && remainingMeters < 700 ? 'approaching' : 'in_transit' : d.routeId ? 'assigned' : 'pending';
    return { deliveryId: id, status: d.status, stage, simulated: !!sim, geometry, origin: plan ? { longitude: plan.coordinates[0][0], latitude: plan.coordinates[0][1] } : null,
      destination: { address: d.deliveryAddress, latitude: d.latitude, longitude: d.longitude },
      vehicle: d.route ? { plate: d.route.vehicle.plate, kind: d.route.vehicle.kind, brand: d.route.vehicle.brand, model: d.route.vehicle.model } : null,
      driver: d.route ? { fullName: d.route.driver.fullName, phone: d.route.driver.phone, simulated: d.route.driver.simulated } : null,
      simulation: sim ? { status: sim.status, speed: sim.speed, progressPercent: ownStop?.distance ? Math.min(100, (progress?.distance ?? 0) / ownStop.distance * 100) : arrived ? 100 : 0, remainingMeters, etaSeconds, etaAt: etaSeconds == null ? null : new Date(Date.now() + etaSeconds * 1000), confirmationDueAt: d.transportCompletedAt ? new Date(d.transportCompletedAt.getTime() + sim.confirmationDelaySeconds * 1000) : null, error: sim.error } : null,
      receipt: { source: d.completionSource, buyerConfirmedAt: d.buyerConfirmedAt, receivedByName: d.receivedByName },
      position, stops: stops.map(s => ({ id: s.id, type: s.type, plannedAt: s.plannedAt, actualAt: s.actualAt, address: s.address, latitude: s.latitude, longitude: s.longitude })),
      incidents: d.route?.activities.map(a => ({ id: a.id, kind: a.kind, message: a.message, createdAt: a.createdAt, resolvedAt: a.resolvedAt })) ?? [], dispatchedAt: d.dispatchedAt, deliveredAt: d.deliveredAt, closedAt: d.closedAt };
  }
  async acknowledge(id: string, userId: string, receivedByName: string, receiptNotes?: string) {
    return this.db.$transaction(async tx => {
      const d = await tx.delivery.findUnique({ where: { id }, include: { plan: true } });
      if (!d || d.plan.buyerId !== userId) throw new ForbiddenException('Esta entrega no pertenece a tu cuenta');
      if (!d.closedAt || d.status !== 'completed') throw new ConflictException('La entrega todavía necesita registrar las cantidades recibidas');
      if (d.buyerConfirmedAt) return d;
      const updated = await tx.delivery.update({ where: { id }, data: { buyerConfirmedAt: new Date(), receivedByName: receivedByName.trim(), receiptNotes: receiptNotes?.trim() } });
      if (d.routeId) await tx.routeActivity.create({ data: { routeId: d.routeId, deliveryId: id, actorId: userId, operationId: randomUUID(), kind: 'buyer_receipt', message: 'El comprador confirmó personalmente la recepción. Sin repetir cobros ni liquidaciones.' } });
      return updated;
    }, { isolationLevel: 'Serializable' });
  }
  async producerRoutes(userId: string, roles: string[]) {
    const producerId = await this.access.producerId(userId, roles);
    if (!producerId) throw new ForbiddenException('No hay un perfil productor habilitado');
    return this.db.route.findMany({ where: { deliveries: { some: { lots: { some: { producerId } } }, every: { lots: { every: { producerId } } } } }, include: { driver: true, vehicle: true, simulation: true, zone: true, activities: { orderBy: { createdAt: 'desc' }, take: 30 }, stops: { orderBy: { sequence: 'asc' } }, deliveries: { include: { plan: true, lots: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  async resources(userId: string, roles: string[]) {
    if (!admin(roles) && !await this.access.producerId(userId, roles)) throw new ForbiddenException('Solo administración o productores habilitados');
    const [vehicles, drivers, reservations] = await Promise.all([
      this.db.vehicle.findMany({ where: { active: true, operationalStatus: 'available' }, orderBy: { capacityKg: 'asc' } }),
      this.db.driver.findMany({ where: { active: true }, select: { id: true, fullName: true, phone: true, active: true, simulated: true, preparationMinutes: true, baseCity: true, baseDepartment: true } }),
      this.db.route.findMany({ where: { status: { in: ['planned', 'in_transit'] } }, select: { driverId: true, vehicleId: true, scheduledDate: true, scheduledEnd: true, status: true } }),
    ]);
    return { vehicles, drivers, reservations, bicycleRoutingAvailable: Boolean(process.env.OSRM_BICYCLE_URL) };
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
