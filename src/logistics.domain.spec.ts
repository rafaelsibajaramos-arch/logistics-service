import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CloseDeliveryDto, CreateRouteDto } from './logistics.dto';
import { buildOrderDeliveryPlan, validateAcceptedLots, validateStops } from './logistics.service';
import { EventEnvelope } from './events/event-envelope';

const deliveryId = 'da3b2a36-6633-4a18-9b6a-9ebad49c7158';
const farmId = '0cbf8626-9618-4324-9f1f-13f08196cd6e';
const producerId = '8e8202e5-8df9-40a9-a117-cad5e31a6d4d';
const reservationId = 'd71300bb-d331-40cf-9b93-a04020effb08';
const start = new Date('2026-10-17T09:00:00.000Z');
const end = new Date('2026-10-17T12:00:00.000Z');

describe('Logistics domain invariants', () => {
  const delivery = { id: deliveryId, windowStart: new Date('2026-10-17T10:00:00.000Z'), windowEnd: new Date('2026-10-17T11:00:00.000Z'), lots: [{ farmId, quantityKg: new Prisma.Decimal('5') }] };
  const validStops: CreateRouteDto['stops'] = [
    { sequence: 1, deliveryId, type: 'pickup', farmId, address: 'Finca', plannedAt: '2026-10-17T09:30:00.000Z' },
    { sequence: 2, deliveryId, type: 'dropoff', address: 'Comprador', plannedAt: '2026-10-17T10:30:00.000Z' },
  ];

  it('acepta recogida por finca antes de la entrega dentro de su ventana', () => {
    expect(() => validateStops([delivery], validStops, start, end)).not.toThrow();
  });

  it('rechaza llegada fuera de ventana y recogidas posteriores al destino', () => {
    const late = validStops.map((stop) => stop.type === 'dropoff' ? { ...stop, plannedAt: '2026-10-17T11:30:00.000Z' } : stop);
    expect(() => validateStops([delivery], late, start, end)).toThrow(BadRequestException);
    const outOfOrder = [validStops[1], { ...validStops[0], plannedAt: '2026-10-17T10:45:00.000Z' }];
    expect(() => validateStops([delivery], outOfOrder, start, end)).toThrow(BadRequestException);
  });

  it('cierra completed solo cuando todo lo despachado fue aceptado', () => {
    const result = validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], accepted('completed', 5));
    expect(result.acceptedTotal.toString()).toBe('5');
    expect(() => validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], accepted('completed', 4))).toThrow(BadRequestException);
  });

  it('distingue entrega parcial, fallida y cantidades fuera del lote', () => {
    expect(validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], accepted('partial', 2)).acceptedTotal.toString()).toBe('2');
    expect(validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], accepted('failed', 0)).acceptedTotal.toString()).toBe('0');
    expect(() => validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], accepted('partial', 0))).toThrow(BadRequestException);
    expect(() => validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], accepted('completed', 6))).toThrow(BadRequestException);
  });

  it('requiere reportar todas las reservas y no permite cantidades duplicadas', () => {
    expect(() => validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], { status: 'failed', acceptedLots: [] })).toThrow(BadRequestException);
    expect(() => validateAcceptedLots([{ reservationId, quantityKg: new Prisma.Decimal('5') }], { status: 'failed', acceptedLots: [{ reservationId, acceptedQuantityKg: 0 }, { reservationId, acceptedQuantityKg: 0 }] })).toThrow(BadRequestException);
  });

  it('construye el plan desde una confirmación con reservas y snapshot real de finca', () => {
    const event: EventEnvelope = {
      event_id: '6b4c2429-0c8d-485d-85a2-a2a5cc1d4111', event_type: 'order.confirmed', source_service: 'order-service',
      entity_id: 'da3b2a36-6633-4a18-9b6a-9ebad49c7158', entity_version: 2, schema_version: 1,
      occurred_at: start.toISOString(), correlation_id: 'd9545aee-7c4f-46cc-afeb-f6dc2111ed21',
      payload: { orderId: 'da3b2a36-6633-4a18-9b6a-9ebad49c7158', buyerId: 'de955ed4-037b-492e-8b0c-039eaa7be701', paymentId: '5b3a3f65-27dc-47c4-8ee9-536fcf6e6d2b', status: 'confirmed', deliveryAddress: 'Calle 10 # 20-30', items: [{ id: 'd71300bb-d331-40cf-9b93-a04020effb08', producerId, reservationId, harvestBatchId: '39a9f739-8e32-485b-b3e6-c5357258f136', farmId, pickupAddress: 'Finca La Esperanza', pickupLatitude: 8.7, pickupLongitude: -75.8, quantity: '5.000', unitPrice: '1200.00' }] },
    };
    const plan = buildOrderDeliveryPlan(event, start);
    expect(plan.orderId).toBe(event.entity_id);
    expect(plan.deliveries[0].lots[0]).toMatchObject({ reservationId, producerId, harvestBatchId: '39a9f739-8e32-485b-b3e6-c5357258f136', farmId, pickupLatitude: 8.7, pickupLongitude: -75.8, quantityKg: 5, unitPrice: 1200 });
    expect(plan.deliveries[0].windowStart).toBe(new Date(start.getTime() + 86_400_000).toISOString());
    expect(buildOrderDeliveryPlan(event, new Date(start.getTime() + 60_000)).deliveries[0].windowStart).toBe(plan.deliveries[0].windowStart);
  });

  it('rechaza confirmaciones antiguas sin datos logísticos de la reserva', () => {
    const event = { event_id: '6b4c2429-0c8d-485d-85a2-a2a5cc1d4111', event_type: 'order.confirmed', source_service: 'order-service', entity_id: deliveryId, entity_version: 1, schema_version: 1, occurred_at: start.toISOString(), correlation_id: deliveryId, payload: { orderId: deliveryId, status: 'confirmed', deliveryAddress: 'Calle 10', items: [{ id: reservationId, quantity: 5 }] } } as EventEnvelope;
    expect(() => buildOrderDeliveryPlan(event, start)).toThrow(BadRequestException);
  });
});

function accepted(status: CloseDeliveryDto['status'], quantity: number): CloseDeliveryDto {
  return { status, acceptedLots: [{ reservationId, acceptedQuantityKg: quantity }] };
}
