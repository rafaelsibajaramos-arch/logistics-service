import { simulationElapsed, simulationOperation, simulationProgress, simulationTimeline } from './simulation-engine';

const geometry = { type: 'LineString', coordinates: [[-75.88,8.75],[-75.879,8.75],[-75.879,8.751],[-75.878,8.751]] };
const stops = [{ id:'pickup', deliveryId:'d', type:'pickup', latitude:8.75, longitude:-75.879 }, {id:'dropoff',deliveryId:'d',type:'dropoff',latitude:8.751,longitude:-75.878}];
describe('Motor de simulación sobre carretera', () => {
  it('mantiene al repartidor en origen durante la preparación y recorre la geometría', () => {
    const plan = simulationTimeline(geometry, 300, stops, 900);
    expect(simulationProgress(plan, 100).longitude).toBe(-75.88);
    const atPickup = simulationProgress(plan, plan.stops[0].arrivalSeconds);
    expect(atPickup.longitude).toBeCloseTo(-75.879,6);
    expect(atPickup.latitude).toBeCloseTo(8.75,6);
    const end = simulationProgress(plan, 99999); expect(end.percent).toBe(100); expect(end.latitude).toBeCloseTo(8.751);
  });
  it('respeta el tiempo de atención en cada parada y su orden', () => {
    const plan = simulationTimeline(geometry, 300, stops);
    expect(plan.stops[1].arrivalSeconds).toBeGreaterThan(plan.stops[0].departureSeconds);
    expect(simulationProgress(plan,plan.stops[0].arrivalSeconds+60).distance).toBe(plan.stops[0].distance);
  });
  it('no inventa una línea recta cuando faltan carretera o coordenadas', () => {
    expect(()=>simulationTimeline({},300,stops)).toThrow();
    expect(()=>simulationTimeline(geometry,300,[{...stops[0],latitude:null}])).toThrow();
    expect(()=>simulationTimeline(geometry,300,[{...stops[0],latitude:4}])).toThrow();
  });
  it('conserva las esperas planificadas para recoger y el tiempo de carga', () => {
    const start = new Date('2026-11-02T12:00:00Z');
    const timed = stops.map((s, i) => ({...s, plannedAt: new Date(start.getTime() + (i ? 3600 : 1800) * 1000)}));
    const plan = simulationTimeline(geometry, 300, timed, 900, 300, start);
    expect(plan.stops[0].arrivalSeconds).toBe(2700);
    expect(plan.stops[0].departureSeconds).toBe(3000);
    expect(plan.stops[1].arrivalSeconds).toBe(4500);
  });
  it('recupera el avance desde el reloj persistido y no avanza en pausa', () => {
    const state={elapsedSeconds:10,status:'running',speed:30,anchorAt:new Date(1000)};
    expect(simulationElapsed(state,2000)).toBe(40);
    expect(simulationElapsed({...state,status:'paused'},2000)).toBe(10);
    expect(simulationElapsed(state,0)).toBe(10);
  });
  it('las operaciones se repiten con el mismo UUID y separan rutas y paradas', () => {
    const id=simulationOperation('r1:pickup1'); expect(id).toMatch(/^[0-9a-f-]{36}$/);expect(id).toBe(simulationOperation('r1:pickup1'));expect(id).not.toBe(simulationOperation('r2:pickup1'));
  });
});
