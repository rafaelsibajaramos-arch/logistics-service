import { bicycleNeedsProfile, cityKey, tripWithinVehicleRange } from './fleet-location';
describe('Ciudad base de recursos', () => {
  it('reconoce la misma ciudad con acentos, espacios y mayúsculas', () => {
    expect(cityKey(' Montería ', 'CÓRDOBA')).toBe(cityKey('monteria','cordoba'));
  });
  it('no confunde municipios homónimos de departamentos distintos', () => {
    expect(cityKey('San Carlos','Córdoba')).not.toBe(cityKey('San Carlos','Antioquia'));
  });
  it('no asigna una ciudad ficticia cuando falta registrar la base', () => {
    expect(cityKey(null,'Córdoba')).toBeNull(); expect(cityKey('Montería','')).toBeNull();
  });
});

describe('Compatibilidad del vehículo con la distancia', () => {
  const monteria: [number, number] = [-75.88, 8.75];
  const medellin: [number, number] = [-75.58, 6.25];
  const local: [number, number] = [-75.85, 8.77];
  it('rechaza una bicicleta de Montería para recoger en Medellín', () => {
    expect(tripWithinVehicleRange('bicycle', monteria, medellin, monteria)).toBe(false);
    expect(tripWithinVehicleRange('cargo_bike', monteria, medellin, monteria)).toBe(false);
  });
  it('permite trayectos locales y exige perfil ciclista para bicicletas', () => {
    expect(tripWithinVehicleRange('bicycle', monteria, local, monteria)).toBe(true);
    expect(bicycleNeedsProfile('bicycle')).toBe(true);
    expect(bicycleNeedsProfile('van')).toBe(false);
  });
  it('rechaza un recorrido interurbano en motocicleta y admite un camión adecuado', () => {
    expect(tripWithinVehicleRange('motorcycle', monteria, medellin, monteria)).toBe(false);
    expect(tripWithinVehicleRange('truck', monteria, medellin, monteria)).toBe(true);
  });
});
