import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreateRouteDto } from './logistics.dto';

export type Point = { latitude: number; longitude: number };
export type RoadStop = Point & { deliveryId: string; farmId?: string; type: 'pickup' | 'dropoff'; address: string; kg: number; earliest: number; latest: number };
export type RoadLeg = { duration: number; distance: number };
export type RoadGeometry = { type: 'LineString'; coordinates: number[][] };
export type ProposalPayload = { dto: CreateRouteDto; fingerprint: string; geometry: RoadGeometry; distance: number; duration: number; peakLoadKg: number; calculatedAt: string; estimatedEnd: string; origin: Point; provider: string; serviceMinutes: number; estimatedCost?: number };
export function planningFingerprint(driver: { updatedAt: Date }, vehicle: { updatedAt: Date }, deliveries: { id: string; updatedAt: Date }[]) {
  return createHash('sha256').update(JSON.stringify({ driver: driver.updatedAt, vehicle: vehicle.updatedAt, deliveries: [...deliveries].sort((a, b) => a.id.localeCompare(b.id)).map(d => [d.id, d.updatedAt]) })).digest('hex');
}

/** Bounded beam search: precedence, time windows, service time and load per leg.
 * A feasible heuristic is returned, never a claim of a global optimum. */
export function sequenceStops(stops: RoadStop[], matrix: (number | null)[][], start: number, end: number, capacityKg: number, serviceSeconds: number) {
  if (!stops.length || stops.length > 25) throw new BadRequestException('Planifica entre 1 y 25 paradas por ruta');
  type State = { order: number[]; remaining: number[]; time: number; load: number; peak: number; travel: number };
  let beam: State[] = [{ order: [], remaining: stops.map((_, i) => i), time: start, load: 0, peak: 0, travel: 0 }];
  for (let depth = 0; depth < stops.length; depth++) {
    const next: State[] = [];
    for (const state of beam) for (const index of state.remaining) {
      const stop = stops[index];
      if (stop.type === 'dropoff' && state.remaining.some(i => stops[i].deliveryId === stop.deliveryId && stops[i].type === 'pickup')) continue;
      const travel = matrix[state.order.length ? state.order[state.order.length - 1] + 1 : 0]?.[index + 1];
      if (travel == null || !Number.isFinite(travel) || travel < 0) continue;
      const arrival = Math.max(state.time + travel * 1000, stop.earliest);
      const departure = arrival + serviceSeconds * 1000;
      const load = Math.round((state.load + (stop.type === 'pickup' ? stop.kg : -stop.kg)) * 1000) / 1000;
      if (arrival > stop.latest || departure > end || load < -0.0001 || load > capacityKg + 0.0001) continue;
      next.push({ order: [...state.order, index], remaining: state.remaining.filter(i => i !== index), time: departure, load, peak: Math.max(state.peak, load), travel: state.travel + travel });
    }
    next.sort((a, b) => a.time - b.time || a.travel - b.travel);
    beam = next.slice(0, 96);
    if (!beam.length) throw new ConflictException('No se encontró una secuencia factible con esas ventanas y capacidad. Cambia el horario, vehículo o divide las entregas.');
  }
  return beam[0];
}

export function scheduleStops(stops: RoadStop[], order: number[], legs: RoadLeg[], start: number, end: number, capacity: number, serviceSeconds: number) {
  if (legs.length !== order.length) throw new ServiceUnavailableException('El motor devolvió un itinerario incompleto');
  let time = start, load = 0, peak = 0;
  const result = order.map((i, index) => {
    const stop = stops[i], leg = legs[index];
    if (!Number.isFinite(leg.duration) || leg.duration < 0 || !Number.isFinite(leg.distance) || leg.distance < 0) throw new ServiceUnavailableException('El motor devolvió tiempos inválidos');
    const arrival = Math.max(time + leg.duration * 1000, stop.earliest);
    time = arrival + serviceSeconds * 1000;
    load = Math.round((load + (stop.type === 'pickup' ? stop.kg : -stop.kg)) * 1000) / 1000;
    peak = Math.max(peak, load);
    if (arrival > stop.latest || time > end || load > capacity + 0.0001 || load < -0.0001) throw new ConflictException('El recorrido vial final no cumple la capacidad o las ventanas. Replanifica la ruta.');
    return { deliveryId: stop.deliveryId, farmId: stop.farmId, type: stop.type, address: stop.address, latitude: stop.latitude, longitude: stop.longitude, sequence: index + 1, plannedAt: new Date(arrival).toISOString(), departureAt: new Date(time).toISOString(), loadKg: load, legDistanceMeters: leg.distance, legDurationSeconds: leg.duration };
  });
  return { stops: result, peakLoadKg: peak, estimatedEnd: new Date(time).toISOString() };
}

export class OsrmClient {
  private endpoint() {
    const endpoint = process.env.OSRM_URL;
    if (!endpoint) throw new ServiceUnavailableException('Falta conectar el motor de rutas OSRM. Configura OSRM_URL en logística.');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ServiceUnavailableException('La configuración de OSRM no es válida');
    return url.toString().replace(/\/$/, '');
  }
  private async request(service: string, points: Point[], options: string) {
    const coordinates = points.map(p => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
    try {
      const response = await fetch(`${this.endpoint()}/${service}/v1/driving/${coordinates}?${options}&radiuses=${points.map(() => '500').join(';')}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { code?: string; message?: string };
        if (failure.code === 'NoSegment') throw new ConflictException('Un punto de recogida, entrega o salida no coincide con una carretera transitable. Confirma su ubicación exacta en el mapa.');
        throw new Error('OSRM HTTP');
      }
      const data = await response.json();
      if (data.code !== 'Ok') throw new Error('OSRM result');
      return data;
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('No se pudo calcular el recorrido por carretera. Revisa los puntos o reintenta; no se ha asignado la ruta.');
    }
  }
  async verifyRoadPoint(point: Point) {
    const url = `${this.endpoint()}/nearest/v1/driving/${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}?number=1&radiuses=500`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await response.json() as { code?: string; waypoints?: { distance?: number }[] };
      if (data.code !== 'Ok' || !Number.isFinite(data.waypoints?.[0]?.distance) || Number(data.waypoints?.[0]?.distance) > 500) throw new ConflictException('El punto está a más de 500 m de una vía transitable. Ajusta el marcador a la entrada por carretera.');
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('No se pudo verificar el acceso vial de la recogida. Reintenta.');
    }
  }
  async matrix(points: Point[]): Promise<(number | null)[][]> {
    const data = await this.request('table', points, 'annotations=duration');
    if (!Array.isArray(data.durations) || data.durations.length !== points.length || data.durations.some((r: unknown[]) => !Array.isArray(r) || r.length !== points.length)) throw new ServiceUnavailableException('Matriz de viajes incompleta');
    return data.durations;
  }
  async route(points: Point[]): Promise<{ geometry: RoadGeometry; legs: RoadLeg[]; distance: number; duration: number }> {
    const data = await this.request('route', points, 'overview=full&geometries=geojson&steps=false');
    const route = data.routes?.[0];
    if (!route || route.geometry?.type !== 'LineString' || !Array.isArray(route.geometry.coordinates) || !Array.isArray(route.legs)) throw new ServiceUnavailableException('Recorrido vial incompleto');
    return route;
  }
}
