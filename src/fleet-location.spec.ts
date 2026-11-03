import { cityKey } from './fleet-location';
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
