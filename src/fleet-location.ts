export function cityKey(city?: string | null, department?: string | null) {
  const normalize = (v: string) => v.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').replace(/\s+/g, ' ');
  return city?.trim() && department?.trim() ? normalize(city) + '|' + normalize(department) : null;
}
