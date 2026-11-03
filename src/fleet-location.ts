import { meters } from './simulation-engine';

export function cityKey(city?: string | null, department?: string | null) {
  const normalize = (v: string) => v.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/\s+/g, ' ');
  return city?.trim() && department?.trim() ? normalize(city) + '|' + normalize(department) : null;
}

// Límite conservador para una sola ruta, incluida la aproximación desde la base.
// OSRM_URL usa el perfil driving; una bicicleta requiere un motor propio para
// comprobar que puede circular legalmente por todas las vías de la propuesta.
export const vehicleRoadLimitKm: Record<string, number> = {
  bicycle: 20,
  cargo_bike: 30,
  motorcycle: 160,
  car: 800,
  pickup: 1000,
  van: 1000,
  truck: 1400,
};

export function roadLimitKm(kind?: string | null) {
  return vehicleRoadLimitKm[kind ?? ''] ?? 0;
}

export function bicycleNeedsProfile(kind?: string | null) {
  return kind === 'bicycle' || kind === 'cargo_bike';
}
export function tripWithinVehicleRange(kind: string | null | undefined, base: [number, number], pickup: [number, number], destination: [number, number]) {
  const limit = roadLimitKm(kind);
  return limit > 0 && meters(base, pickup) / 1000 <= limit * .45 && meters(pickup, destination) / 1000 <= limit * .8;
}
