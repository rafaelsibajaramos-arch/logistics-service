import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, RouteStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { CloseDeliveryDto, CreateDeliveryPlanDto, CreateDriverDto, CreateRouteDto, CreateVehicleDto, CreateZoneDto, RecordTemperatureDto } from './logistics.dto';
import { EventEnvelope } from './events/event-envelope';

const terminalDeliveryStatuses = ['completed', 'partial', 'failed', 'cancelled'] as const;
type DeliveryWithLots = Prisma.DeliveryGetPayload<{ include: { lots: true } }>;
type DeliveryPlanWithLots = Prisma.DeliveryPlanGetPayload<{ include: { deliveries: { include: { lots: true } } } }>;
type RouteValidationDelivery = Pick<DeliveryWithLots, 'id' | 'windowStart' | 'windowEnd'> & {
  lots: Array<Pick<DeliveryWithLots['lots'][number], 'farmId' | 'quantityKg'>>;
};
const routeInclude = { driver: true, vehicle: true, zone: true, stops: { orderBy: { sequence: 'asc' as const } }, deliveries: { include: { plan: true, lots: true } } };

@Injectable()
export class LogisticsService {
  constructor(private readonly db: PrismaService) {}

  async listDeliveries(userId: string, roles: string[]) {
    const admin = roles.some(role => ['admin', 'logistics_admin'].includes(role));
    const rows = await this.db.delivery.findMany({
      where: admin ? {} : { OR: [{ plan: { buyerId: userId } }, ...(roles.includes('driver') ? [{ route: { driver: { userId } } }] : [])] },
      include: { plan: { select: { buyerId: true } }, lots: true, stops: { orderBy: { sequence: 'asc' } }, route: { select: { status: true, vehicle: { select: { plate: true } } } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });
    return rows.map(({ plan, ...delivery }) => ({ ...delivery, canConfirm: plan.buyerId === userId }));
  }

  listZones() { return this.db.zone.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }); }
  async createZone(dto: CreateZoneDto) {
    const code = dto.code.trim().toUpperCase();
    if (!code || !dto.name.trim()) throw new BadRequestException('Código y nombre son obligatorios');
    try { return await this.db.zone.create({ data: { code, name: dto.name.trim() } }); }
    catch (error) { if (isUniqueViolation(error)) throw new ConflictException('Ya existe una zona con ese código'); throw error; }
  }
  async setZoneActive(code: string, active: boolean) {
    return this.db.$transaction(async (tx) => {
      const zone = await tx.zone.findUnique({ where: { code: code.trim().toUpperCase() } });
      if (!zone) throw new NotFoundException('Zona no encontrada');
      if (!active && await tx.route.count({ where: { zoneCode: zone.code, status: { in: ['planned', 'in_transit'] } } })) throw new ConflictException('No se puede desactivar una zona con rutas activas');
      return tx.zone.update({ where: { code: zone.code }, data: { active } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  listDrivers() { return this.db.driver.findMany({ orderBy: [{ active: 'desc' }, { fullName: 'asc' }] }); }
  async createDriver(dto: CreateDriverDto) {
    try { return await this.db.driver.create({ data: { ...dto, userId: dto.userId, fullName: dto.fullName.trim(), phone: dto.phone.trim(), licenseNumber: dto.licenseNumber.trim().toUpperCase() } }); }
    catch (error) { if (isUniqueViolation(error)) throw new ConflictException('La cuenta o licencia ya está registrada como transportista'); throw error; }
  }
  async setDriverActive(id: string, active: boolean) {
    return this.db.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id } });
      if (!driver) throw new NotFoundException('Transportista no encontrado');
      if (!active && await tx.route.count({ where: { driverId: id, status: { in: ['planned', 'in_transit'] } } })) throw new ConflictException('No se puede desactivar un transportista con rutas activas');
      return tx.driver.update({ where: { id }, data: { active } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  listVehicles() { return this.db.vehicle.findMany({ orderBy: [{ active: 'desc' }, { plate: 'asc' }] }); }
  async createVehicle(dto: CreateVehicleDto) {
    try { return await this.db.vehicle.create({ data: { plate: dto.plate.trim().toUpperCase(), capacityKg: new Prisma.Decimal(dto.capacityKg), refrigerated: dto.refrigerated ?? false } }); }
    catch (error) { if (isUniqueViolation(error)) throw new ConflictException('La placa ya está registrada'); throw error; }
  }
  async setVehicleActive(id: string, active: boolean) {
    return this.db.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.findUnique({ where: { id } });
      if (!vehicle) throw new NotFoundException('Vehículo no encontrado');
      if (!active && await tx.route.count({ where: { vehicleId: id, status: { in: ['planned', 'in_transit'] } } })) throw new ConflictException('No se puede desactivar un vehículo con rutas activas');
      return tx.vehicle.update({ where: { id }, data: { active } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async createPlan(dto: CreateDeliveryPlanDto, correlationId: string, sourceEvent?: EventEnvelope) {
    if (!isUuid(correlationId)) correlationId = randomUUID();
    const clean = dto.deliveries.map((delivery) => ({ ...delivery, start: new Date(delivery.windowStart), end: new Date(delivery.windowEnd) }));
    for (const delivery of clean) {
      if (!Number.isFinite(delivery.start.getTime()) || !Number.isFinite(delivery.end.getTime()) || delivery.end <= delivery.start) throw new BadRequestException('La ventana de entrega debe tener fin posterior al inicio');
      const reservations = delivery.lots.map((lot) => lot.reservationId);
      if (new Set(reservations).size !== reservations.length) throw new BadRequestException('Una reserva no puede repetirse en la misma entrega');
    }
    const allReservations = clean.flatMap((delivery) => delivery.lots.map((lot) => lot.reservationId));
    if (new Set(allReservations).size !== allReservations.length) throw new BadRequestException('Una reserva no puede asignarse a más de una entrega del plan');
    try {
      return await this.db.$transaction(async (tx) => {
        if (sourceEvent) {
          const cancelled = await tx.processedEvent.findFirst({ where: { entityId: dto.orderId, eventType: 'order.cancelled' } });
          if (cancelled) throw new ConflictException('No se crea despacho para un pedido cancelado');
          const duplicate = await tx.processedEvent.findUnique({ where: { eventId: sourceEvent.event_id } });
          if (duplicate) return tx.deliveryPlan.findUniqueOrThrow({ where: { orderId: dto.orderId }, include: { deliveries: { include: { lots: true } } } });
        }
        const existing = await tx.deliveryPlan.findUnique({ where: { orderId: dto.orderId }, include: { deliveries: { include: { lots: true } } } });
        if (existing) {
          if (!samePlan(existing, clean)) throw new ConflictException('El pedido ya tiene un plan de entrega distinto; no se sobrescribe');
          if (sourceEvent) {
            const paymentId = optionalUuid(sourceEvent.payload?.paymentId);
            if (existing.paymentId && paymentId && existing.paymentId !== paymentId) throw new ConflictException('El plan ya está vinculado a otro pago');
            const lotByReservation = new Map(clean.flatMap((delivery) => delivery.lots.map((lot) => [lot.reservationId, lot] as const)));
            for (const delivery of existing.deliveries) for (const lot of delivery.lots) {
              const source = lotByReservation.get(lot.reservationId);
              if (!source) continue;
              if (lot.producerId && source.producerId && lot.producerId !== source.producerId) throw new ConflictException('El productor de un lote del plan no coincide con el pedido');
              if (!lot.producerId && source.producerId) await tx.deliveryLot.update({ where: { id: lot.id }, data: { producerId: source.producerId } });
              if (lot.unitPrice && source.unitPrice != null && !lot.unitPrice.equals(source.unitPrice)) throw new ConflictException('El precio de una línea del plan no coincide con el pedido');
              if (!lot.unitPrice && source.unitPrice != null) await tx.deliveryLot.update({ where: { id: lot.id }, data: { unitPrice: new Prisma.Decimal(source.unitPrice) } });
            }
            if (!existing.paymentId && paymentId) await tx.deliveryPlan.update({ where: { id: existing.id }, data: { paymentId } });
            if (!existing.buyerId && dto.buyerId) await tx.deliveryPlan.update({ where: { id: existing.id }, data: { buyerId: dto.buyerId } });
          }
          if (sourceEvent) await tx.processedEvent.create({ data: { eventId: sourceEvent.event_id, eventType: sourceEvent.event_type, sourceService: sourceEvent.source_service, entityId: dto.orderId } });
          return sourceEvent ? tx.deliveryPlan.findUniqueOrThrow({ where: { id: existing.id }, include: { deliveries: { include: { lots: true } } } }) : existing;
        }
        const plan = await tx.deliveryPlan.create({ data: { orderId: dto.orderId, buyerId: dto.buyerId, paymentId: sourceEvent ? optionalUuid(sourceEvent.payload?.paymentId) : null, deliveries: { create: clean.map((delivery) => ({
          orderId: dto.orderId, deliveryAddress: delivery.deliveryAddress.trim(), windowStart: delivery.start, windowEnd: delivery.end,
          requiresColdChain: delivery.requiresColdChain ?? false,
          lots: { create: delivery.lots.map((lot) => ({ reservationId: lot.reservationId, orderItemId: lot.orderItemId, producerId: lot.producerId ?? null, harvestBatchId: lot.harvestBatchId, farmId: lot.farmId, quantityKg: new Prisma.Decimal(lot.quantityKg), unitPrice: lot.unitPrice == null ? null : new Prisma.Decimal(lot.unitPrice), pickupAddress: lot.pickupAddress.trim(), pickupLatitude: new Prisma.Decimal(lot.pickupLatitude), pickupLongitude: new Prisma.Decimal(lot.pickupLongitude) })) },
        })) } }, include: { deliveries: { include: { lots: true } } } });
        await this.enqueue(tx, { type: 'logistics.plan_created', aggregateId: plan.id, correlationId, payload: { plan_id: plan.id, order_id: plan.orderId, delivery_ids: plan.deliveries.map((delivery) => delivery.id) } });
        if (sourceEvent) await tx.processedEvent.create({ data: { eventId: sourceEvent.event_id, eventType: sourceEvent.event_type, sourceService: sourceEvent.source_service, entityId: dto.orderId } });
        return plan;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (sourceEvent && await this.db.processedEvent.findUnique({ where: { eventId: sourceEvent.event_id } })) return this.db.deliveryPlan.findUniqueOrThrow({ where: { orderId: dto.orderId }, include: { deliveries: { include: { lots: true } } } });
        const existing = await this.db.deliveryPlan.findUnique({ where: { orderId: dto.orderId }, include: { deliveries: { include: { lots: true } } } });
        if (existing && samePlan(existing, clean)) return existing;
        throw new ConflictException('Ya existe un plan de entrega para este pedido');
      }
      throw error;
    }
  }

  async consumeOrderConfirmed(event: EventEnvelope) {
    return this.createPlan(buildOrderDeliveryPlan(event), event.correlation_id, event);
  }

  async consumeOrderCancelled(event: EventEnvelope) {
    const orderId = asUuid(event.payload?.orderId ?? event.entity_id, 'orderId');
    return this.db.$transaction(async (tx) => {
      const duplicate = await tx.processedEvent.findUnique({ where: { eventId: event.event_id } });
      if (duplicate) return { duplicate: true };
      const plan = await tx.deliveryPlan.findUnique({ where: { orderId }, include: { deliveries: true } });
      if (plan?.deliveries.some((delivery) => delivery.routeId || delivery.status === 'in_transit' || delivery.status === 'completed' || delivery.status === 'partial')) throw new ConflictException('No se puede cancelar el pedido después de asignarlo a una ruta o iniciar su entrega');
      if (plan) {
        await tx.delivery.updateMany({ where: { planId: plan.id, status: { in: ['scheduled', 'failed'] } }, data: { status: 'cancelled', cancelledAt: new Date() } });
        await tx.deliveryPlan.update({ where: { id: plan.id }, data: { status: 'closed', closedAt: new Date() } });
      }
      await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
      return { cancelled: true, planId: plan?.id ?? null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  listRoutes(driverUserId?: string) {
    return this.db.route.findMany({ where: driverUserId ? { driver: { userId: driverUserId } } : undefined, include: routeInclude, orderBy: [{ scheduledDate: 'desc' }] });
  }

  async createRoute(dto: CreateRouteDto, correlationId: string) {
    const startsAt = new Date(dto.scheduledDate); const endsAt = new Date(dto.scheduledEnd);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new BadRequestException('El fin de ruta debe ser posterior al inicio');
    if (new Set(dto.deliveryIds).size !== dto.deliveryIds.length) throw new BadRequestException('No repitas entregas en una ruta');
    const stops = [...dto.stops].sort((a, b) => a.sequence - b.sequence);
    if (new Set(stops.map((stop) => stop.sequence)).size !== stops.length) throw new BadRequestException('Cada parada necesita una secuencia única');
    const transaction = async (tx: Prisma.TransactionClient) => {
      const [driver, vehicle, zone, deliveries] = await Promise.all([
        tx.driver.findUnique({ where: { id: dto.driverId } }),
        tx.vehicle.findUnique({ where: { id: dto.vehicleId } }),
        tx.zone.findUnique({ where: { code: dto.zoneCode.trim().toUpperCase() } }),
        tx.delivery.findMany({ where: { id: { in: dto.deliveryIds } }, include: { lots: true, plan: true } }),
      ]);
      if (!driver?.active) throw new ConflictException('El transportista no existe o está inactivo');
      if (!vehicle?.active) throw new ConflictException('El vehículo no existe o está inactivo');
      if (!zone?.active) throw new ConflictException('La zona no existe o está inactiva');
      if (deliveries.length !== dto.deliveryIds.length) throw new NotFoundException('Una o más entregas no existen');
      if (deliveries.some((delivery) => delivery.routeId || delivery.status !== 'scheduled')) throw new ConflictException('Todas las entregas deben estar programadas y aún no asignadas');
      if (deliveries.some((delivery) => delivery.plan.status !== 'draft')) throw new ConflictException('No se pueden replanificar entregas de un plan confirmado');
      if (deliveries.some((delivery) => delivery.requiresColdChain) && !vehicle.refrigerated) throw new ConflictException('La ruta contiene perecederos y requiere un vehículo refrigerado');
      const totalKg = deliveries.reduce((sum, delivery) => sum.plus(delivery.lots.reduce((subtotal, lot) => subtotal.plus(lot.quantityKg), new Prisma.Decimal(0))), new Prisma.Decimal(0));
      if (totalKg.gt(vehicle.capacityKg)) throw new ConflictException('La carga total excede la capacidad del vehículo');
      const overlap = { scheduledDate: { lt: endsAt }, scheduledEnd: { gt: startsAt }, status: { in: ['planned', 'in_transit'] as RouteStatus[] } };
      const [driverConflict, vehicleConflict] = await Promise.all([
        tx.route.findFirst({ where: { driverId: driver.id, ...overlap } }),
        tx.route.findFirst({ where: { vehicleId: vehicle.id, ...overlap } }),
      ]);
      if (driverConflict) throw new ConflictException('El transportista ya tiene una ruta en ese horario');
      if (vehicleConflict) throw new ConflictException('El vehículo ya tiene una ruta en ese horario');
      validateStops(deliveries, stops, startsAt, endsAt);

      const route = await tx.route.create({ data: {
        driverId: driver.id, vehicleId: vehicle.id, zoneCode: zone.code, scheduledDate: startsAt, scheduledEnd: endsAt,
        deliveries: { connect: deliveries.map(({ id }) => ({ id })) },
        stops: { create: stops.map((stop) => ({ deliveryId: stop.deliveryId, sequence: stop.sequence, type: stop.type, farmId: stop.farmId ?? null, address: stop.address.trim(), plannedAt: new Date(stop.plannedAt) })) },
      }, include: routeInclude });

      const touchedPlans = [...new Set(deliveries.map((delivery) => delivery.planId))];
      for (const planId of touchedPlans) {
        const plan = await tx.deliveryPlan.findUniqueOrThrow({ where: { id: planId }, include: { deliveries: { include: { route: true, lots: true } } } });
        if (plan.deliveries.every((delivery) => delivery.routeId && (delivery.route?.status === 'planned' || delivery.route?.status === 'in_transit'))) {
          const confirmed = await tx.deliveryPlan.update({ where: { id: plan.id }, data: { status: 'confirmed', confirmedAt: new Date() }, include: { deliveries: true } });
          await this.enqueue(tx, { type: 'fulfillment.plan_ready', aggregateId: plan.id, correlationId, payload: { plan_id: plan.id, order_id: plan.orderId, delivery_ids: confirmed.deliveries.map((delivery) => delivery.id) } });
          for (const delivery of plan.deliveries) {
          await this.enqueue(tx, { type: 'delivery.scheduled', aggregateId: delivery.id, correlationId, payload: { plan_id: plan.id, delivery_id: delivery.id, order_id: delivery.orderId, buyer_id: plan.buyerId, driver_user_id: route.driver.userId, window_start: delivery.windowStart.toISOString(), window_end: delivery.windowEnd.toISOString(), route_id: delivery.routeId, quantity_kg: sumKg(delivery.lots).toString() } });
          }
        }
      }
      await this.enqueue(tx, { type: 'logistics.route_planned', aggregateId: route.id, correlationId, payload: { route_id: route.id, driver_id: route.driverId, driver_user_id: route.driver.userId, vehicle_id: route.vehicleId, zone_code: route.zoneCode, scheduled_date: route.scheduledDate.toISOString(), scheduled_end: route.scheduledEnd.toISOString(), delivery_ids: route.deliveries.map((delivery) => delivery.id) } });
      return route;
    };
    try { return await this.db.$transaction(transaction, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) { if (isUniqueViolation(error)) throw new ConflictException('La secuencia de paradas o una asignación ya existe'); throw error; }
  }

  async dispatchRoute(routeId: string, userId: string, isAdmin: boolean, operationId: string, correlationId: string) {
    const operation = parseOperation(operationId);
    const prior = await this.db.processedOperation.findUnique({ where: { operationId: operation } });
    if (prior) {
      if (prior.operation !== 'route.dispatch' || prior.resourceId !== routeId) throw new ConflictException('operation_id ya fue usado para otra operación');
      const replay = await this.db.route.findUniqueOrThrow({ where: { id: routeId }, include: routeInclude });
      if (!isAdmin && replay.driver.userId !== userId) throw new ForbiddenException('Esta ruta no pertenece a tu cuenta');
      return replay;
    }
    const current = await this.db.route.findUnique({ where: { id: routeId }, include: routeInclude });
    if (!current) throw new NotFoundException('Ruta no encontrada');
    if (!isAdmin && current.driver.userId !== userId) throw new ConflictException('El conductor no tiene asignada esta ruta');
    if (current.status === 'in_transit') return current;
    if (current.status !== 'planned') throw new ConflictException('Solo se puede despachar una ruta planificada');
    if (current.deliveries.some((delivery) => delivery.plan.status !== 'confirmed')) throw new ConflictException('El plan debe estar confirmado antes del despacho');
    const paymentIds = [...new Set(current.deliveries.map((delivery) => delivery.plan.paymentId).filter((id): id is string => Boolean(id)))];
    if (paymentIds.length !== new Set(current.deliveries.map((delivery) => delivery.planId)).size) throw new ConflictException('Cada pedido de la ruta debe tener un pago autorizado asociado');
    const locked: string[] = [];
    try {
      for (const paymentId of paymentIds) {
        await this.setPaymentRouteLock(paymentId, routeId, correlationId, false);
        locked.push(paymentId);
      }
    } catch (error) {
      await Promise.all(locked.map((paymentId) => this.setPaymentRouteLock(paymentId, routeId, correlationId, true).catch(() => undefined)));
      throw error;
    }
    try {
      return await this.db.$transaction(async (tx) => {
      const route = await tx.route.findUnique({ where: { id: routeId }, include: routeInclude });
      if (!route) throw new NotFoundException('Ruta no encontrada');
      if (!isAdmin && route.driver.userId !== userId) throw new ConflictException('El conductor no tiene asignada esta ruta');
      if (route.status === 'in_transit') return route;
      if (route.status !== 'planned') throw new ConflictException('Solo se puede despachar una ruta planificada');
      if (route.deliveries.some((delivery) => delivery.plan.status !== 'confirmed')) throw new ConflictException('El plan debe estar confirmado antes del despacho');
      const now = new Date();
      const dispatched = await tx.route.update({ where: { id: routeId }, data: { status: 'in_transit' }, include: routeInclude });
      await tx.delivery.updateMany({ where: { routeId, status: 'scheduled' }, data: { status: 'in_transit', dispatchedAt: now } });
      await tx.processedOperation.create({ data: { operationId: operation, operation: 'route.dispatch', resourceId: routeId } });
      for (const delivery of route.deliveries) {
        await this.enqueue(tx, { type: 'delivery.in_transit', aggregateId: delivery.id, correlationId, payload: { delivery_id: delivery.id, plan_id: delivery.planId, order_id: delivery.orderId, buyer_id: delivery.plan.buyerId, dispatched_at: now.toISOString(), reservations: delivery.lots.map((lot) => ({ reservation_id: lot.reservationId, order_item_id: lot.orderItemId, quantity_kg: lot.quantityKg.toString() })) } });
      }
      return dispatched;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      // If the DB committed but the client lost the response, keep the payment lock.
      // Unlock only after confirming the route is still not in transit.
      try {
        const latest = await this.db.route.findUnique({ where: { id: routeId }, select: { status: true } });
        if (latest && latest.status !== 'in_transit') await Promise.all(locked.map((paymentId) => this.setPaymentRouteLock(paymentId, routeId, correlationId, true).catch(() => undefined)));
      } catch { /* Fail closed: a lock without dispatch is safer than dispatch without authorization. */ }
      throw error;
    }
  }

  private async setPaymentRouteLock(paymentId: string, routeId: string, correlationId: string, unlock: boolean) {
    const base = String(process.env.PAYMENT_SERVICE_URL ?? 'http://payment-service:3006').replace(/\/+$/, '');
    const key = process.env.INTERNAL_API_KEY ?? '';
    if (!key) throw new ServiceUnavailableException('No está configurada la autenticación interna de pagos');
    let response: Response;
    try {
      response = await fetch(`${base}/api/v1/payments/${paymentId}/fulfillment-${unlock ? 'unlock' : 'lock'}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-api-key': key, 'x-correlation-id': correlationId },
        body: JSON.stringify({ routeId }), signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ServiceUnavailableException('No se pudo validar y reservar la autorización de pago para despacho');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 409) throw new ConflictException(detail || 'El pago no está autorizado para despacho');
      throw new ServiceUnavailableException(`Payments no pudo ${unlock ? 'liberar' : 'reservar'} la autorización (${response.status})`);
    }
  }

  async arriveAtStop(routeId: string, stopId: string, userId: string, isAdmin: boolean, operationId: string) {
    const operation = parseOperation(operationId);
    const prior = await this.db.processedOperation.findUnique({ where: { operationId: operation } });
    if (prior) {
      if (prior.operation !== 'route.stop_arrive' || prior.resourceId !== stopId) throw new ConflictException('operation_id ya fue usado para otra operación');
      const replay = await this.db.routeStop.findUniqueOrThrow({ where: { id: stopId }, include: { route: { include: { driver: true } } } });
      if (replay.routeId !== routeId || (!isAdmin && replay.route.driver.userId !== userId)) throw new ForbiddenException('Esta parada no pertenece a tu cuenta');
      return replay;
    }
    return this.db.$transaction(async (tx) => {
      const stop = await tx.routeStop.findUnique({
        where: { id: stopId },
        include: { route: { include: { driver: true, stops: { orderBy: { sequence: 'asc' } } } } },
      });
      if (!stop || stop.routeId !== routeId) throw new NotFoundException('Parada no encontrada en esta ruta');
      if (!isAdmin && stop.route.driver.userId !== userId) throw new ConflictException('El transportista no tiene asignada esta ruta');
      if (stop.route.status !== 'in_transit') throw new ConflictException('Solo se registran paradas de una ruta en tránsito');
      if (stop.actualAt) return stop;
      if (stop.route.stops.some((previous) => previous.sequence < stop.sequence && !previous.actualAt)) throw new ConflictException('Registra las paradas en el orden planificado');
      const updated = await tx.routeStop.update({ where: { id: stop.id }, data: { actualAt: new Date() } });
      await tx.processedOperation.create({ data: { operationId: operation, operation: 'route.stop_arrive', resourceId: stop.id } });
      if (stop.type === 'dropoff') {
        const delivery = await tx.delivery.findUniqueOrThrow({ where: { id: stop.deliveryId }, include: { plan: true } });
        await this.enqueue(tx, { type: 'delivery.arrived', aggregateId: delivery.id, correlationId: operation, payload: { delivery_id: delivery.id, order_id: delivery.orderId, buyer_id: delivery.plan.buyerId, arrived_at: updated.actualAt?.toISOString() } });
      }
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async closeDelivery(deliveryId: string, dto: CloseDeliveryDto, userId: string, isAdmin: boolean, operationId: string, correlationId: string, buyerConfirmation = false) {
    // Check ownership before replay: knowing an operation UUID grants no access.
    const access = await this.db.delivery.findUnique({ where: { id: deliveryId }, include: { plan: true, route: { include: { driver: true } } } });
    if (!access) throw new NotFoundException('Entrega no encontrada');
    if (buyerConfirmation ? access.plan.buyerId !== userId : !isAdmin && access.route?.driver.userId !== userId) throw new ForbiddenException('Esta entrega no pertenece a tu cuenta');
    if (!buyerConfirmation && dto.status !== 'failed') throw new ForbiddenException('El comprador debe confirmar los kilos recibidos desde Entregas');
    if (dto.status !== 'completed' && (dto.reason?.trim().length ?? 0) < 5) throw new BadRequestException('Indica el motivo de la entrega parcial o fallida (mínimo 5 caracteres)');
    const operation = parseOperation(operationId);
    const prior = await this.db.processedOperation.findUnique({ where: { operationId: operation } });
    if (prior) {
      if (prior.operation !== 'delivery.close' || prior.resourceId !== deliveryId) throw new ConflictException('operation_id ya fue usado para otra operación');
      const replay = await this.db.delivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { lots: true, plan: true } });
      const requested = validateAcceptedLots(replay.lots, dto).acceptedByReservation;
      if (replay.status !== dto.status || replay.lots.some(lot => !new Prisma.Decimal(lot.acceptedQuantityKg ?? -1).equals(requested.get(lot.reservationId)!))) throw new ConflictException('La operación ya fue registrada con otras cantidades');
      return replay;
    }
    return this.db.$transaction(async (tx) => {
      const delivery = await tx.delivery.findUnique({ where: { id: deliveryId }, include: { lots: true, plan: true, route: { include: { driver: true } } } });
      if (!delivery) throw new NotFoundException('Entrega no encontrada');
      if (buyerConfirmation ? delivery.plan.buyerId !== userId : !isAdmin && delivery.route?.driver.userId !== userId) throw new ForbiddenException('Esta entrega no pertenece a tu cuenta');
      if (delivery.status !== 'in_transit') throw new ConflictException('Solo se puede cerrar una entrega en tránsito');
      if (buyerConfirmation && !await tx.routeStop.findFirst({ where: { deliveryId, type: 'dropoff', actualAt: { not: null } } })) throw new ConflictException('El transportista debe registrar primero la llegada al destino');
      const { acceptedByReservation } = validateAcceptedLots(delivery.lots, dto);
      const now = new Date();
      for (const lot of delivery.lots) await tx.deliveryLot.update({ where: { id: lot.id }, data: { acceptedQuantityKg: acceptedByReservation.get(lot.reservationId)! } });
      const closed = await tx.delivery.update({ where: { id: delivery.id }, data: { status: dto.status, deliveredAt: dto.status === 'failed' ? null : now, closedAt: now }, include: { lots: true, plan: true } });
      await tx.processedOperation.create({ data: { operationId: operation, operation: 'delivery.close', resourceId: deliveryId } });
      const eventItems = closed.lots.map((lot) => ({ order_item_id: lot.orderItemId, producer_id: lot.producerId, reservation_id: lot.reservationId, harvest_batch_id: lot.harvestBatchId, farm_id: lot.farmId, quantity_kg: lot.quantityKg.toString(), accepted_quantity_kg: (lot.acceptedQuantityKg ?? new Prisma.Decimal(0)).toString() }));
      await this.enqueue(tx, { type: `delivery.${dto.status}`, aggregateId: delivery.id, correlationId, payload: { delivery_id: delivery.id, plan_id: delivery.planId, order_id: delivery.orderId, buyer_id: delivery.plan.buyerId, confirmed_by: userId, buyer_confirmation: buyerConfirmation, reason: dto.reason ?? null, driver_user_id: delivery.route?.driver.userId ?? null, status: dto.status, window_start: delivery.windowStart.toISOString(), window_end: delivery.windowEnd.toISOString(), dispatched_at: delivery.dispatchedAt?.toISOString() ?? null, delivered_at: closed.deliveredAt?.toISOString() ?? null, closed_at: now.toISOString(), items: eventItems } });

      const remaining = await tx.delivery.count({ where: { planId: delivery.planId, status: { notIn: [...terminalDeliveryStatuses] } } });
      if (remaining === 0) {
        const fullPlan = await tx.deliveryPlan.findUniqueOrThrow({ where: { id: delivery.planId }, include: { deliveries: { include: { lots: true } } } });
        const totals = aggregatePlanItems(fullPlan.deliveries);
        await tx.deliveryPlan.update({ where: { id: fullPlan.id }, data: { status: 'closed', closedAt: now } });
        await this.enqueue(tx, { type: 'order.fulfillment_closed', aggregateId: fullPlan.id, correlationId, payload: { plan_id: fullPlan.id, order_id: fullPlan.orderId, buyer_id: fullPlan.buyerId, payment_id: fullPlan.paymentId, accepted_amount: totals.reduce((sum, item) => sum.plus(item.accepted_amount ?? 0), new Prisma.Decimal(0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString(), closed_at: now.toISOString(), items: totals } });
      }
      if (delivery.routeId) {
        const unfinished = await tx.delivery.count({ where: { routeId: delivery.routeId, status: { notIn: [...terminalDeliveryStatuses] } } });
        if (unfinished === 0) await tx.route.update({ where: { id: delivery.routeId }, data: { status: 'completed' } });
      }
      return closed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async recordTemperature(deliveryId: string, dto: RecordTemperatureDto, userId: string, isAdmin: boolean, correlationId: string) {
    const delivery = await this.db.delivery.findUnique({ where: { id: deliveryId }, include: { lots: true, plan: true, route: { include: { driver: true } } } });
    if (!delivery) throw new NotFoundException('Entrega no encontrada');
    if (!isAdmin && delivery.route?.driver.userId !== userId) throw new ConflictException('El transportista no tiene asignada esta entrega');
    const existing = await this.db.temperatureRecord.findUnique({ where: { sensorEventId: dto.sensorEventId } });
    if (existing) {
      if (existing.deliveryId !== deliveryId || !existing.temperature.equals(new Prisma.Decimal(dto.temperature))) throw new ConflictException('sensor_event_id ya fue usado con otros datos');
      return { reading: existing, replayed: true };
    }
    try {
      const reading = await this.db.$transaction(async (tx) => {
        const record = await tx.temperatureRecord.create({ data: { deliveryId, temperature: new Prisma.Decimal(dto.temperature), recordedAt: new Date(dto.recordedAt), sensorEventId: dto.sensorEventId } });
        if (delivery.requiresColdChain) {
          const threshold = new Prisma.Decimal(process.env.COLD_CHAIN_MAX_C ?? '8');
          if (record.temperature.gt(threshold)) await this.enqueue(tx, { type: 'cold_chain.alert', aggregateId: delivery.id, correlationId, payload: { alert_id: randomUUID(), delivery_id: delivery.id, order_id: delivery.orderId, buyer_id: delivery.plan.buyerId, driver_user_id: delivery.route?.driver.userId ?? null, sensor_event_id: record.sensorEventId, temperature_c: record.temperature.toString(), threshold_c: threshold.toString(), recorded_at: record.recordedAt.toISOString(), harvest_batch_ids: delivery.lots.map((lot) => lot.harvestBatchId) } });
        }
        return record;
      });
      return { reading, replayed: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const concurrent = await this.db.temperatureRecord.findUnique({ where: { sensorEventId: dto.sensorEventId } });
      if (concurrent && concurrent.deliveryId === deliveryId && concurrent.temperature.equals(new Prisma.Decimal(dto.temperature))) return { reading: concurrent, replayed: true };
      throw new ConflictException('sensor_event_id ya fue usado con otros datos');
    }
  }

  private enqueue(tx: Prisma.TransactionClient, event: { type: string; aggregateId: string; correlationId: string; payload: Record<string, unknown> }) {
    return tx.outboxEvent.create({ data: { eventType: event.type, aggregateId: event.aggregateId, routingKey: event.type, correlationId: event.correlationId, payload: event.payload as Prisma.InputJsonValue } });
  }
}

export function validateStops(deliveries: RouteValidationDelivery[], stops: CreateRouteDto['stops'], startsAt: Date, endsAt: Date) {
  const orderedStops = [...stops].sort((a, b) => a.sequence - b.sequence);
  if (orderedStops.some((stop, i) => !Number.isInteger(stop.sequence) || (i > 0 && new Date(stop.plannedAt) < new Date(orderedStops[i - 1].plannedAt)))) throw new BadRequestException('La secuencia debe ser entera y sus horarios deben ser cronológicos');
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  if (stops.some((stop) => !byId.has(stop.deliveryId))) throw new BadRequestException('Cada parada debe pertenecer a una entrega asignada a la ruta');
  for (const stop of stops) {
    if (!['pickup', 'dropoff'].includes(stop.type)) throw new BadRequestException('Tipo de parada inválido');
    const planned = new Date(stop.plannedAt);
    if (planned < startsAt || planned > endsAt) throw new BadRequestException('La hora estimada de parada debe estar dentro del horario de la ruta');
    if (stop.type === 'pickup' && !stop.farmId) throw new BadRequestException('Una recogida debe identificar su finca');
    if (stop.type === 'dropoff' && stop.farmId) throw new BadRequestException('Una entrega al comprador no debe incluir farm_id');
  }
  let load = new Prisma.Decimal(0);
  for (const delivery of deliveries) {
    const related = stops.filter((stop) => stop.deliveryId === delivery.id);
    const pickups = related.filter((stop) => stop.type === 'pickup');
    const dropoffs = related.filter((stop) => stop.type === 'dropoff');
    const farms = new Set<string>(delivery.lots.map((lot) => String(lot.farmId)));
    if (dropoffs.length !== 1 || pickups.length !== farms.size) throw new BadRequestException('Cada entrega requiere una parada de destino y una recogida por finca de origen');
    const pickupFarms = new Set(pickups.map((stop) => String(stop.farmId)));
    if (pickupFarms.size !== farms.size || [...farms].some((farmId) => !pickupFarms.has(farmId))) throw new BadRequestException('Debe planificarse una recogida por cada finca asignada');
    const drop = dropoffs[0];
    if (new Date(drop.plannedAt) < delivery.windowStart || new Date(drop.plannedAt) > delivery.windowEnd) throw new BadRequestException('La hora prevista de llegada incumple la ventana acordada');
    if (pickups.some((stop) => !stop.farmId || !farms.has(stop.farmId) || new Date(stop.plannedAt) >= new Date(drop.plannedAt))) throw new BadRequestException('Las recogidas deben corresponder a los lotes y preceder al destino');
  }
  for (const stop of [...stops].sort((a, b) => a.sequence - b.sequence)) {
    const delivery = byId.get(stop.deliveryId)!;
    if (stop.type === 'pickup') {
      const quantity = delivery.lots.filter((lot) => lot.farmId === stop.farmId).reduce((sum, lot) => sum.plus(lot.quantityKg), new Prisma.Decimal(0));
      load = load.plus(quantity);
    } else {
      load = load.minus(delivery.lots.reduce((sum, lot) => sum.plus(lot.quantityKg), new Prisma.Decimal(0)));
      if (load.lt(0)) throw new BadRequestException('La secuencia de ruta entrega producto antes de recogerlo');
    }
  }
}

function aggregatePlanItems(deliveries: DeliveryWithLots[]) {
  const rows = new Map<string, { order_item_id: string; producer_id: string | null; quantity_ordered_kg: Prisma.Decimal; accepted_quantity_kg: Prisma.Decimal; accepted_amount: Prisma.Decimal | null }>();
  for (const delivery of deliveries) for (const lot of delivery.lots) {
    const row = rows.get(lot.orderItemId) ?? { order_item_id: lot.orderItemId, producer_id: lot.producerId ?? null, quantity_ordered_kg: new Prisma.Decimal(0), accepted_quantity_kg: new Prisma.Decimal(0), accepted_amount: lot.unitPrice == null ? null : new Prisma.Decimal(0) };
    if (row.producer_id && lot.producerId && row.producer_id !== lot.producerId) throw new ConflictException('Una línea del pedido contiene lotes de productores distintos');
    row.producer_id ??= lot.producerId ?? null;
    row.quantity_ordered_kg = row.quantity_ordered_kg.plus(lot.quantityKg);
    const accepted = new Prisma.Decimal(lot.acceptedQuantityKg ?? 0);
    row.accepted_quantity_kg = row.accepted_quantity_kg.plus(accepted);
    if (row.accepted_amount != null && lot.unitPrice != null) row.accepted_amount = row.accepted_amount.plus(accepted.times(lot.unitPrice));
    else row.accepted_amount = null;
    rows.set(lot.orderItemId, row);
  }
  return [...rows.values()].map((row) => ({ order_item_id: row.order_item_id, producer_id: row.producer_id, quantity_ordered_kg: row.quantity_ordered_kg.toString(), accepted_quantity_kg: row.accepted_quantity_kg.toString(), accepted_amount: row.accepted_amount?.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toString() ?? null }));
}

function samePlan(existing: DeliveryPlanWithLots, requested: Array<CreateDeliveryPlanDto['deliveries'][number] & { start: Date; end: Date }>) {
  if (existing.deliveries.length !== requested.length) return false;
  const current = existing.deliveries.map((delivery) => ({
    address: delivery.deliveryAddress, start: delivery.windowStart.getTime(), end: delivery.windowEnd.getTime(), cold: delivery.requiresColdChain,
    lots: delivery.lots.map((lot) => [lot.reservationId, lot.orderItemId, lot.harvestBatchId, lot.farmId, lot.quantityKg.toString(), lot.pickupAddress, lot.pickupLatitude.toString(), lot.pickupLongitude.toString()].join('|')).sort(),
  })).sort((a, b) => a.address.localeCompare(b.address) || a.start - b.start);
  const next = requested.map((delivery) => ({
    address: delivery.deliveryAddress.trim(), start: delivery.start.getTime(), end: delivery.end.getTime(), cold: delivery.requiresColdChain ?? false,
    lots: delivery.lots.map((lot) => [lot.reservationId, lot.orderItemId, lot.harvestBatchId, lot.farmId, new Prisma.Decimal(lot.quantityKg).toString(), lot.pickupAddress.trim(), new Prisma.Decimal(lot.pickupLatitude).toString(), new Prisma.Decimal(lot.pickupLongitude).toString()].join('|')).sort(),
  })).sort((a, b) => a.address.localeCompare(b.address) || a.start - b.start);
  return JSON.stringify(current) === JSON.stringify(next);
}

export function validateAcceptedLots(lots: Array<{ reservationId: string; quantityKg: Prisma.Decimal }>, dto: CloseDeliveryDto) {
  if (!['completed', 'partial', 'failed'].includes(dto.status)) throw new BadRequestException('Estado final de entrega inválido');
  const acceptedByReservation = new Map(dto.acceptedLots.map((line) => [line.reservationId, new Prisma.Decimal(line.acceptedQuantityKg)]));
  if (acceptedByReservation.size !== dto.acceptedLots.length) throw new BadRequestException('No repitas reservas al registrar aceptación');
  if (acceptedByReservation.size !== lots.length || lots.some((lot) => !acceptedByReservation.has(lot.reservationId))) throw new BadRequestException('Registra la cantidad aceptada de cada lote asignado');
  let acceptedTotal = new Prisma.Decimal(0); let orderedTotal = new Prisma.Decimal(0);
  for (const lot of lots) {
    const accepted = acceptedByReservation.get(lot.reservationId)!;
    if (accepted.lt(0) || accepted.gt(lot.quantityKg)) throw new BadRequestException('La cantidad aceptada debe estar entre cero y lo despachado');
    acceptedTotal = acceptedTotal.plus(accepted); orderedTotal = orderedTotal.plus(lot.quantityKg);
  }
  if (dto.status === 'completed' && !acceptedTotal.equals(orderedTotal)) throw new BadRequestException('Una entrega completa debe aceptar toda la cantidad despachada');
  if (dto.status === 'partial' && (acceptedTotal.lte(0) || acceptedTotal.gte(orderedTotal))) throw new BadRequestException('Una entrega parcial debe aceptar una cantidad mayor que cero y menor que la despachada');
  if (dto.status === 'failed' && !acceptedTotal.isZero()) throw new BadRequestException('Una entrega fallida no puede registrar cantidades aceptadas');
  return { acceptedByReservation, acceptedTotal, orderedTotal };
}

function sumKg(lots: Array<{ quantityKg: Prisma.Decimal }>) { return lots.reduce((total, lot) => total.plus(lot.quantityKg), new Prisma.Decimal(0)); }
function isUniqueViolation(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'; }
function isUuid(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function asUuid(value: unknown, field: string): string { const text = String(value ?? ''); if (!isUuid(text)) throw new BadRequestException(`order.confirmed contiene ${field} inválido`); return text; }
function requiredText(value: unknown, field: string): string { const text = String(value ?? '').trim(); if (text.length < 3 || text.length > 500) throw new BadRequestException(`order.confirmed contiene ${field} inválido`); return text; }
function positiveNumber(value: unknown, field: string): number { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw new BadRequestException(`order.confirmed contiene ${field} inválido`); return n; }
function nonNegativeNumber(value: unknown, field: string): number { const n = Number(value); if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`order.confirmed contiene ${field} inválido`); return n; }
function optionalUuid(value: unknown): string | null { if (value == null || value === '') return null; return asUuid(value, 'paymentId'); }
function coordinate(value: unknown, min: number, max: number, field: string): number { const n = Number(value); if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`order.confirmed contiene ${field} inválido`); return n; }
function boundedDays(value: string | undefined, fallback: number): number { const n = Number(value ?? fallback); return Number.isInteger(n) && n >= 1 && n <= 60 ? n : fallback; }
export function buildOrderDeliveryPlan(event: EventEnvelope, now = new Date()): CreateDeliveryPlanDto {
  const payload = event.payload ?? {};
  const orderId = asUuid(payload.orderId ?? event.entity_id, 'orderId');
  if (String(payload.status ?? 'confirmed') !== 'confirmed') throw new BadRequestException('order.confirmed debe tener estado confirmed');
  const deliveryAddress = String(payload.deliveryAddress ?? '').trim();
  const items = Array.isArray(payload.items) ? payload.items as Record<string, unknown>[] : [];
  if (deliveryAddress.length < 3 || deliveryAddress.length > 500 || items.length === 0) throw new BadRequestException('order.confirmed requiere dirección válida y líneas de pedido');
  const lots = items.map((item) => ({
    reservationId: asUuid(item.reservationId, 'reservationId'), orderItemId: asUuid(item.id, 'orderItemId'), producerId: item.producerId == null ? undefined : asUuid(item.producerId, 'producerId'),
    harvestBatchId: asUuid(item.harvestBatchId, 'harvestBatchId'), farmId: asUuid(item.farmId, 'farmId'), unitPrice: nonNegativeNumber(item.unitPrice, 'unitPrice'),
    quantityKg: positiveNumber(item.quantity, 'quantity'), pickupAddress: requiredText(item.pickupAddress, 'pickupAddress'),
    pickupLatitude: coordinate(item.pickupLatitude, -90, 90, 'pickupLatitude'), pickupLongitude: coordinate(item.pickupLongitude, -180, 180, 'pickupLongitude'),
  }));
  const occurredAt = new Date(event.occurred_at);
  const anchor = Number.isFinite(occurredAt.getTime()) ? occurredAt : now;
  const startDays = boundedDays(process.env.DELIVERY_WINDOW_START_DAYS, 1);
  const endDays = Math.max(startDays + 1, boundedDays(process.env.DELIVERY_WINDOW_END_DAYS, 7));
  const buyerId = asUuid(payload.buyerId ?? payload.buyer_id, 'buyerId');
  return { orderId, buyerId, deliveries: [{ deliveryAddress, windowStart: new Date(anchor.getTime() + startDays * 86_400_000).toISOString(), windowEnd: new Date(anchor.getTime() + endDays * 86_400_000).toISOString(), lots }] };
}
function parseOperation(value: string) { if (!isUuid(value)) throw new BadRequestException('operation_id debe ser un UUID'); return value; }
