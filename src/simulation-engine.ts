import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type SimulationTimeline = { coordinates: number[][]; cumulative: number[]; distance: number; duration: number; preparationSeconds: number; stops: { id: string; deliveryId: string; type: string; distance: number; arrivalSeconds: number; departureSeconds: number }[] };
export function meters(a: number[], b: number[]) {
  const rad = Math.PI / 180, lat = (b[1] - a[1]) * rad, lng = (b[0] - a[0]) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function simulationTimeline(geometry: { type?: string; coordinates?: number[][] }, duration: number, stops: { id: string; deliveryId: string; type: string; latitude: number | null; longitude: number | null; plannedAt?: Date }[], preparationSeconds = 0, serviceSeconds = 120, scheduledStart?: Date): SimulationTimeline {
  const coordinates = geometry?.coordinates;
  if (geometry?.type !== 'LineString' || !coordinates || coordinates.length < 2 || !Number.isFinite(duration) || duration < 0 || coordinates.some(p => p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) throw new BadRequestException('La simulación requiere un recorrido vial calculado');
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) cumulative.push(cumulative[i - 1] + meters(coordinates[i - 1], coordinates[i]));
  const distance = cumulative[cumulative.length - 1];
  let previous = 0, previousDeparture = preparationSeconds, previousDistance = 0;
  const timeline = stops.map((s) => {
    if (s.latitude == null || s.longitude == null) throw new BadRequestException('Todas las paradas necesitan coordenadas');
    let index = previous, best = Infinity;
    for (let k = previous; k < coordinates.length; k++) { const d = meters(coordinates[k], [s.longitude, s.latitude]); if (d < best) { best = d; index = k; } }
    if (best > 600) throw new BadRequestException('Una parada no coincide con el recorrido vial');
    previous = index;
    const travel = Math.max(1, distance ? (cumulative[index] - previousDistance) / distance * Math.max(duration, 60) : 0);
    const plannedOffset = scheduledStart && s.plannedAt ? Math.max(0, (s.plannedAt.getTime() - scheduledStart.getTime()) / 1000) : 0;
    const arrivalSeconds = Math.max(previousDeparture + travel, preparationSeconds + plannedOffset);
    const departureSeconds = arrivalSeconds + serviceSeconds;
    previousDeparture = departureSeconds; previousDistance = cumulative[index];
    return { id: s.id, deliveryId: s.deliveryId, type: s.type, distance: cumulative[index], arrivalSeconds, departureSeconds };
  });
  return { coordinates, cumulative, distance, duration: timeline.at(-1)?.departureSeconds ?? 0, preparationSeconds, stops: timeline };
}
export function simulationProgress(plan: SimulationTimeline, elapsed: number) {
  let priorSeconds = plan.preparationSeconds ?? 0, priorDistance = 0, distance = plan.distance;
  for (const stop of plan.stops) {
    if (elapsed < stop.arrivalSeconds) { distance = priorDistance + (stop.distance - priorDistance) * Math.max(0, (elapsed - priorSeconds) / Math.max(1, stop.arrivalSeconds - priorSeconds)); break; }
    if (elapsed < stop.departureSeconds) { distance = stop.distance; break; }
    priorSeconds = stop.departureSeconds; priorDistance = stop.distance;
  }
  let i = 1; while (i < plan.cumulative.length - 1 && plan.cumulative[i] < distance) i++;
  const span = plan.cumulative[i] - plan.cumulative[i - 1];
  const f = span ? Math.min(1, Math.max(0, (distance - plan.cumulative[i - 1]) / span)) : 0;
  const a = plan.coordinates[i - 1], b = plan.coordinates[i];
  return { longitude: a[0] + (b[0] - a[0]) * f, latitude: a[1] + (b[1] - a[1]) * f, distance, percent: plan.distance ? Math.min(100, distance / plan.distance * 100) : elapsed >= plan.duration ? 100 : 0 };
}
export function simulationElapsed(sim: { elapsedSeconds: number; status: string; anchorAt: Date; speed: number }, now = Date.now()) { return Math.max(0, sim.elapsedSeconds + (sim.status === 'running' ? Math.max(0, now - sim.anchorAt.getTime()) / 1000 * sim.speed : 0)); }
export function simulationOperation(value: string) { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }
