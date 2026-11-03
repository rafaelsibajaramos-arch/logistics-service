import { OsrmClient, RoadStop, scheduleStops, sequenceStops } from './road-planner';

const at = new Date('2030-01-01T08:00:00Z').getTime();
const pickup = (deliveryId: string, kg: number): RoadStop => ({ deliveryId, farmId: deliveryId, type: 'pickup', address: 'Finca', latitude: 8.7, longitude: -75.8, kg, earliest: at, latest: at + 3600000 });
const dropoff = (deliveryId: string, kg: number): RoadStop => ({ ...pickup(deliveryId, kg), farmId: undefined, type: 'dropoff' });
describe('Planificación vial y restricciones de negocio', () => {
  it('permite transportar pedidos mayores a la capacidad total si cada tramo cabe', () => {
    const stops = [pickup('a', 8), dropoff('a', 8), pickup('b', 8), dropoff('b', 8)];
    const matrix = Array.from({ length: 5 }, () => Array(5).fill(60));
    const result = sequenceStops(stops, matrix, at, at + 3600000, 10, 60);
    expect(result.peak).toBe(8);
    expect(result.order.indexOf(0)).toBeLessThan(result.order.indexOf(1));
    expect(result.order.indexOf(2)).toBeLessThan(result.order.indexOf(3));
  });
  it('rechaza una carga indivisible mayor que el vehículo', () => {
    expect(() => sequenceStops([pickup('a', 11), dropoff('a', 11)], [[0, 60, 60], [60, 0, 60], [60, 60, 0]], at, at + 3600000, 10, 60)).toThrow('No se encontró');
  });
  it('espera el inicio de ventana sin modificar el compromiso original', () => {
    const stops = [pickup('a', 4), { ...dropoff('a', 4), earliest: at + 1800000 }];
    const result = scheduleStops(stops, [0, 1], [{ distance: 500, duration: 60 }, { distance: 500, duration: 60 }], at, at + 3600000, 10, 60);
    expect(result.stops[1].plannedAt).toBe(new Date(at + 1800000).toISOString());
    expect(result.stops[1].loadKg).toBe(0);
  });
  it('rechaza una ventana imposible por carretera, aunque los puntos sean cercanos', () => {
    const matrix = [[0, 600, 600], [600, 0, 3600], [600, 3600, 0]];
    expect(() => sequenceStops([pickup('a', 4), { ...dropoff('a', 4), latest: at + 900000 }], matrix, at, at + 7200000, 10, 60)).toThrow('No se encontró');
  });
  it('no utiliza distancias en línea recta cuando no hay conexión vial', () => {
    expect(() => sequenceStops([pickup('a', 4)], [[0, null], [null, 0]], at, at + 3600000, 10, 60)).toThrow('No se encontró');
  });
  it('vuelve a comprobar los tiempos del itinerario final', () => {
    expect(() => scheduleStops([pickup('a', 4)], [0], [{ duration: 7200, distance: 2000 }], at, at + 3600000, 10, 60)).toThrow('recorrido vial final');
  });
  it('no inventa ruta si el proveedor está caído', async () => {
    const previous = process.env.OSRM_URL; process.env.OSRM_URL = 'http://osrm.test';
    const mock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unavailable'));
    try { await expect(new OsrmClient().matrix([pickup('a', 4)])).rejects.toThrow('No se pudo calcular'); }
    finally { mock.mockRestore(); if (previous) process.env.OSRM_URL = previous; else delete process.env.OSRM_URL; }
  });
  it('identifica un punto fuera de la red vial sin asignar recorrido', async () => {
    const previous = process.env.OSRM_URL; process.env.OSRM_URL = 'http://osrm.test';
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, json: async () => ({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 1' }) } as Response);
    try { await expect(new OsrmClient().matrix([pickup('a', 4)])).rejects.toThrow('no coincide con una carretera'); }
    finally { mock.mockRestore(); if (previous) process.env.OSRM_URL = previous; else delete process.env.OSRM_URL; }
  });
  it('rechaza una conexión vial inexistente sin crear una ruta', async () => {
    const previous = process.env.OSRM_URL; process.env.OSRM_URL = 'http://osrm.test';
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ code: 'NoRoute' }) } as Response);
    try { await expect(new OsrmClient().route([pickup('a', 4)])).rejects.toThrow('No existe un recorrido transitable'); }
    finally { mock.mockRestore(); if (previous) process.env.OSRM_URL = previous; else delete process.env.OSRM_URL; }
  });
  it('rechaza una salida de mercancía que OSRM ubica lejos de una vía', async () => {
    const previous = process.env.OSRM_URL; process.env.OSRM_URL = 'http://osrm.test';
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ code: 'Ok', waypoints: [{ distance: 501 }] }) } as Response);
    try { await expect(new OsrmClient().verifyRoadPoint(pickup('a', 4))).rejects.toThrow('más de 200 m'); }
    finally { mock.mockRestore(); if (previous) process.env.OSRM_URL = previous; else delete process.env.OSRM_URL; }
  });
  it('rechaza puntos que la matriz ajustaría demasiado lejos de la vía', async () => {
    const previous = process.env.OSRM_URL; process.env.OSRM_URL = 'http://osrm.test';
    const mock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ code: 'Ok', durations: [[0]], sources: [{ distance: 250 }], destinations: [{ distance: 250 }] }) } as Response);
    try { await expect(new OsrmClient().matrix([pickup('a', 4)])).rejects.toThrow('lejos de la carretera'); }
    finally { mock.mockRestore(); if (previous) process.env.OSRM_URL = previous; else delete process.env.OSRM_URL; }
  });
});
