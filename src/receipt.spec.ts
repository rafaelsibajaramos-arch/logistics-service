import { Prisma } from '@prisma/client';
import { LogisticsService } from './logistics.service';

const deliveryId = '11111111-1111-4111-8111-111111111111';
const operation = '22222222-2222-4222-8222-222222222222';
const buyer = '33333333-3333-4333-8333-333333333333';
const driver = '44444444-4444-4444-8444-444444444444';
const reservationId = '55555555-5555-4555-8555-555555555555';

function fixture(arrived = true) {
  const lot = { id: 'lot', reservationId, orderItemId: 'item', producerId: null, farmId: 'farm', harvestBatchId: 'batch', quantityKg: new Prisma.Decimal(5), unitPrice: new Prisma.Decimal(1000), acceptedQuantityKg: null };
  const delivery: any = { id: deliveryId, planId: 'plan', orderId: 'order', routeId: 'route', status: 'in_transit', windowStart: new Date(), windowEnd: new Date(), dispatchedAt: new Date(), plan: { buyerId: buyer }, route: { driver: { userId: driver } }, lots: [lot] };
  const db: any = {
    delivery: { findUnique: jest.fn().mockResolvedValue(delivery), count: jest.fn().mockResolvedValue(0), update: jest.fn(async ({ data }) => ({ ...delivery, ...data })) },
    routeStop: { findFirst: jest.fn().mockResolvedValue(arrived ? { actualAt: new Date() } : null) },
    deliveryLot: { update: jest.fn(async ({ data }) => { Object.assign(lot, data); return lot; }) },
    processedOperation: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    deliveryPlan: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'plan', orderId: 'order', buyerId: buyer, paymentId: 'payment', deliveries: [delivery] }), update: jest.fn().mockResolvedValue({}) },
    route: { update: jest.fn().mockResolvedValue({}) }, outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  db.$transaction = jest.fn(callback => callback(db));
  return { db, service: new LogisticsService(db), delivery };
}

describe('Recepción independiente del comprador', () => {
  it.each([['completed', 5, '5000'], ['partial', 2, '2000'], ['failed', 0, '0']] as const)('cierra %s y liquida solo los kilos aceptados', async (status, kg, amount) => {
    const { db, service } = fixture();
    const result = await service.closeDelivery(deliveryId, { status, reason: 'Prueba de recepción', acceptedLots: [{ reservationId, acceptedQuantityKg: kg }] }, buyer, false, operation, operation, true);
    expect(result.status).toBe(status);
    expect(db.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'order.fulfillment_closed', payload: expect.objectContaining({ accepted_amount: amount }) }) }));
  });
  it('no permite al transportista aprobar la recepción', async () => {
    const { service, db } = fixture();
    await expect(service.closeDelivery(deliveryId, { status: 'completed', acceptedLots: [{ reservationId, acceptedQuantityKg: 5 }] }, driver, false, operation, operation)).rejects.toThrow('comprador');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('no permite confirmar antes de registrar la llegada', async () => {
    const { service, db } = fixture(false);
    await expect(service.closeDelivery(deliveryId, { status: 'completed', acceptedLots: [{ reservationId, acceptedQuantityKg: 5 }] }, buyer, false, operation, operation, true)).rejects.toThrow('llegada');
    expect(db.delivery.update).not.toHaveBeenCalled();
  });
  it('rechaza otro comprador incluso al reutilizar el UUID de una operación', async () => {
    const { service, db } = fixture();
    db.processedOperation.findUnique.mockResolvedValue({ operation: 'delivery.close', resourceId: deliveryId });
    await expect(service.closeDelivery(deliveryId, { status: 'completed', acceptedLots: [{ reservationId, acceptedQuantityKg: 5 }] }, driver, false, operation, operation, true)).rejects.toThrow('pertenece');
    expect(db.processedOperation.findUnique).not.toHaveBeenCalled();
  });
  it('exige un motivo para el fallo registrado por el transportista', async () => {
    const { service } = fixture();
    await expect(service.closeDelivery(deliveryId, { status: 'failed', acceptedLots: [{ reservationId, acceptedQuantityKg: 0 }] }, driver, false, operation, operation)).rejects.toThrow('motivo');
  });
  it('no cierra el pedido mientras falta otra entrega', async () => {
    const { service, db } = fixture(); db.delivery.count.mockResolvedValue(1);
    await service.closeDelivery(deliveryId, { status: 'completed', acceptedLots: [{ reservationId, acceptedQuantityKg: 5 }] }, buyer, false, operation, operation, true);
    expect(db.deliveryPlan.update).not.toHaveBeenCalled();
    expect(db.route.update).not.toHaveBeenCalled();
  });
  it('permite registrar un fallo motivado al transportista asignado', async () => {
    const { service } = fixture();
    await expect(service.closeDelivery(deliveryId, { status: 'failed', reason: 'Destinatario ausente', acceptedLots: [{ reservationId, acceptedQuantityKg: 0 }] }, driver, false, operation, operation)).resolves.toHaveProperty('status', 'failed');
  });
});
