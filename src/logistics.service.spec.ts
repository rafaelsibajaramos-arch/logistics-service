import { CreateDeliveryPlanDto } from './logistics.dto';
import { EventEnvelope } from './events/event-envelope';
import { LogisticsService } from './logistics.service';

const orderId = 'da3b2a36-6633-4a18-9b6a-9ebad49c7158';
const event: EventEnvelope = {
  event_id: '6b4c2429-0c8d-485d-85a2-a2a5cc1d4111', event_type: 'order.confirmed', source_service: 'order-service',
  entity_id: orderId, entity_version: 2, schema_version: 1, occurred_at: '2026-10-17T09:00:00.000Z', correlation_id: orderId,
  payload: {},
};
const dto: CreateDeliveryPlanDto = {
  orderId,
  deliveries: [{
    deliveryAddress: 'Calle 10 # 20-30', windowStart: '2026-10-18T09:00:00.000Z', windowEnd: '2026-10-24T09:00:00.000Z',
    lots: [{ reservationId: 'd71300bb-d331-40cf-9b93-a04020effb08', orderItemId: 'd9545aee-7c4f-46cc-afeb-f6dc2111ed21', producerId: '8e8202e5-8df9-40a9-a117-cad5e31a6d4d', harvestBatchId: '39a9f739-8e32-485b-b3e6-c5357258f136', farmId: '0cbf8626-9618-4324-9f1f-13f08196cd6e', quantityKg: 5, unitPrice: 1200, pickupAddress: 'Finca La Esperanza', pickupLatitude: 8.7, pickupLongitude: -75.8 }],
  }],
};

describe('LogisticsService event processing', () => {
  it('creates the plan and records the inbox event in the same transaction', async () => {
    const plan = { id: 'e843ec3e-2e65-4cb0-8143-35e7d58297d0', orderId, deliveries: [{ id: '21526691-620d-4ca9-830f-e35d064b5508', lots: [] }] };
    const tx: any = {
      processedEvent: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
      deliveryPlan: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(plan) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const db: any = { $transaction: jest.fn((callback) => callback(tx)) };

    await new LogisticsService(db).createPlan(dto, event.correlation_id, event);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.deliveryPlan.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deliveries: { create: expect.arrayContaining([expect.objectContaining({ lots: { create: expect.arrayContaining([expect.objectContaining({ producerId: '8e8202e5-8df9-40a9-a117-cad5e31a6d4d' })]) } })]) } }) }));
    expect(tx.processedEvent.create).toHaveBeenCalledWith({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'logistics.plan_created' }) }));
  });

  it('acknowledges a duplicated cancellation without repeating its effect', async () => {
    const cancellation: EventEnvelope = { ...event, event_id: '5f44770f-07aa-4b54-9d82-4fe166498723', event_type: 'order.cancelled', payload: { orderId } };
    const tx: any = { processedEvent: { findUnique: jest.fn().mockResolvedValue({ eventId: cancellation.event_id }) } };
    const db: any = { $transaction: jest.fn((callback) => callback(tx)) };

    await expect(new LogisticsService(db).consumeOrderCancelled(cancellation)).resolves.toEqual({ duplicate: true });
    expect(tx.processedEvent.findUnique).toHaveBeenCalledWith({ where: { eventId: cancellation.event_id } });
  });

  it('reserva el pago autorizado antes de cambiar una ruta a tránsito', async () => {
    const routeId = '11111111-1111-4111-8111-111111111111';
    const paymentId = '22222222-2222-4222-8222-222222222222';
    const delivery = { id: '33333333-3333-4333-8333-333333333333', planId: '44444444-4444-4444-8444-444444444444', orderId, status: 'scheduled', plan: { id: '44444444-4444-4444-8444-444444444444', status: 'confirmed', paymentId, buyerId: '55555555-5555-4555-8555-555555555555' }, lots: [] };
    const route = { id: routeId, status: 'planned', driver: { userId: '66666666-6666-4666-8666-666666666666' }, deliveries: [delivery] };
    const tx: any = {
      route: { findUnique: jest.fn().mockResolvedValue(route), update: jest.fn().mockResolvedValue({ ...route, status: 'in_transit' }) },
      delivery: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      processedOperation: { create: jest.fn().mockResolvedValue({}) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const db: any = { route: { findUnique: jest.fn().mockResolvedValue(route) }, processedOperation: { findUnique: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn((callback) => callback(tx)) };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const previousKey = process.env.INTERNAL_API_KEY;
    const previousPaymentUrl = process.env.PAYMENT_SERVICE_URL;
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    process.env.PAYMENT_SERVICE_URL = 'http://payment-service:3006';

    try {
      await new LogisticsService(db).dispatchRoute(routeId, route.driver.userId, false, '77777777-7777-4777-8777-777777777777', orderId);
      expect(fetchSpy).toHaveBeenCalledWith(`http://payment-service:3006/api/v1/payments/${paymentId}/fulfillment-lock`, expect.objectContaining({ method: 'POST' }));
      expect(tx.route.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'in_transit' } }));
    } finally {
      fetchSpy.mockRestore();
      if (previousKey === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = previousKey;
      if (previousPaymentUrl === undefined) delete process.env.PAYMENT_SERVICE_URL; else process.env.PAYMENT_SERVICE_URL = previousPaymentUrl;
    }
  });

  it('no despacha la ruta si Payments rechaza la autorización', async () => {
    const routeId = '11111111-1111-4111-8111-111111111111';
    const paymentId = '22222222-2222-4222-8222-222222222222';
    const delivery = { id: '33333333-3333-4333-8333-333333333333', planId: '44444444-4444-4444-8444-444444444444', orderId, status: 'scheduled', plan: { id: '44444444-4444-4444-8444-444444444444', status: 'confirmed', paymentId }, lots: [] };
    const route = { id: routeId, status: 'planned', driver: { userId: '66666666-6666-4666-8666-666666666666' }, deliveries: [delivery] };
    const db: any = { route: { findUnique: jest.fn().mockResolvedValue(route) }, processedOperation: { findUnique: jest.fn().mockResolvedValue(null) }, $transaction: jest.fn() };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"message":"Pago anulado"}', { status: 409 }));
    const previousKey = process.env.INTERNAL_API_KEY;
    const previousPaymentUrl = process.env.PAYMENT_SERVICE_URL;
    process.env.INTERNAL_API_KEY = 'test-internal-key';

    try {
      await expect(new LogisticsService(db).dispatchRoute(routeId, route.driver.userId, false, '77777777-7777-4777-8777-777777777777', orderId)).rejects.toThrow('Pago anulado');
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previousKey === undefined) delete process.env.INTERNAL_API_KEY; else process.env.INTERNAL_API_KEY = previousKey;
      if (previousPaymentUrl === undefined) delete process.env.PAYMENT_SERVICE_URL; else process.env.PAYMENT_SERVICE_URL = previousPaymentUrl;
    }
  });
});
