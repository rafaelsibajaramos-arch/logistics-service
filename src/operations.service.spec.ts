import { OperationsService } from './operations.service';

const actor = '11111111-1111-4111-8111-111111111111';
describe('Operación y privacidad de logística', () => {
  it('impide cambiar un destino ajeno', async () => {
    const tx: any = { delivery: { findUnique: jest.fn().mockResolvedValue({ plan: { buyerId: 'other' } }), update: jest.fn() } };
    const db: any = { $transaction: (f: any) => f(tx) };
    await expect(new OperationsService(db, {} as any).locateDelivery('id', { latitude: 8, longitude: -75, zoneCode: 'N' }, actor, ['buyer'])).rejects.toThrow('productor responsable');
    expect(tx.delivery.update).not.toHaveBeenCalled();
  });
  it('impide modificar un vehículo comprometido en una ruta', async () => {
    const tx: any = { vehicle: { findUnique: jest.fn().mockResolvedValue({ id: 'v' }), update: jest.fn() }, route: { count: jest.fn().mockResolvedValue(1) } };
    await expect(new OperationsService({ $transaction: (f: any) => f(tx) } as any, {} as any).updateVehicle('v', { plate: 'AAA111', capacityKg: 500 })).rejects.toThrow('rutas activas');
    expect(tx.vehicle.update).not.toHaveBeenCalled();
  });
  it('solo el conductor asignado puede compartir GPS, incluso si el actor es administrador', async () => {
    const db: any = { route: { findUnique: jest.fn().mockResolvedValue({ driver: { userId: 'other' }, status: 'in_transit' }), updateMany: jest.fn() } };
    await expect(new OperationsService(db, {} as any).position('id', { latitude: 8, longitude: -75, accuracy: 5, recordedAt: new Date().toISOString() }, actor, ['admin'])).rejects.toThrow('conductor asignado');
    expect(db.route.updateMany).not.toHaveBeenCalled();
  });
  it('no acepta posiciones antiguas como señal actual', async () => {
    const db: any = { route: { findUnique: jest.fn().mockResolvedValue({ driver: { userId: actor }, status: 'in_transit' }), updateMany: jest.fn() } };
    await expect(new OperationsService(db, {} as any).position('id', { latitude: 8, longitude: -75, accuracy: 5, recordedAt: '2020-01-01T00:00:00Z' }, actor, ['driver'])).rejects.toThrow('antigua');
  });
  it('no permite consultar el seguimiento de otro comprador', async () => {
    const db: any = { delivery: { findUnique: jest.fn().mockResolvedValue({ plan: { buyerId: 'other' }, route: null }) } };
    await expect(new OperationsService(db, {} as any).tracking('id', actor, ['buyer'])).rejects.toThrow('consultar');
  });
  it('reutiliza la ruta ya confirmada al reintentar la propuesta', async () => {
    const db: any = { routeProposal: { findUnique: jest.fn().mockResolvedValue({ actorId: actor, routeId: 'existing' }) }, route: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'existing' }) } };
    const logistics: any = { createRoute: jest.fn() };
    await expect(new OperationsService(db, logistics).confirmProposal('id', actor, actor)).resolves.toEqual({ id: 'existing' });
    expect(logistics.createRoute).not.toHaveBeenCalled();
  });
});
