import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export const isLogisticsAdmin = (roles: string[]) => roles.some(r => ['admin', 'logistics_admin'].includes(r));
@Injectable()
export class LogisticsAccessService {
  private readonly profiles = new Map<string, { id: string; expires: number }>();
  constructor(private readonly db: PrismaService) {}
  async producerId(userId: string, roles: string[]): Promise<string | null> {
    if (!roles.includes('producer')) return null;
    const cached = this.profiles.get(userId);
    if (cached && cached.expires > Date.now()) return cached.id;
    const key = process.env.INTERNAL_API_KEY;
    const url = process.env.PRODUCER_SERVICE_URL;
    if (!key || !url) throw new ServiceUnavailableException('No está configurado el perfil del productor para logística');
    try {
      const r = await fetch(url.replace(/\/+$/, '') + '/internal/users/' + encodeURIComponent(userId) + '/producer', { headers: { 'x-internal-api-key': key }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error();
      const data = await r.json() as { producer_id?: string };
      if (!data.producer_id) return null;
      if (this.profiles.size >= 500) this.profiles.delete(this.profiles.keys().next().value!);
      this.profiles.set(userId, { id: data.producer_id, expires: Date.now() + 30000 });
      return data.producer_id;
    } catch { throw new ServiceUnavailableException('No se pudo validar el perfil del productor'); }
  }
  async manageDeliveries(ids: string[], userId: string, roles: string[]) {
    if (isLogisticsAdmin(roles)) return;
    const producerId = await this.producerId(userId, roles);
    if (!producerId || !ids.length) throw new ForbiddenException('Solo el productor responsable puede asignar estas entregas');
    const rows = await this.db.delivery.findMany({ where: { id: { in: ids } }, include: { lots: true } });
    if (rows.length !== new Set(ids).size || rows.some(d => !d.lots.length || d.lots.some(l => l.producerId !== producerId))) throw new ForbiddenException('La ruta contiene productos de otro productor; administración debe coordinar los pedidos antiguos mixtos');
  }
  async manageRoute(id: string, userId: string, roles: string[]) {
    const route = await this.db.route.findUnique({ where: { id }, include: { deliveries: true } });
    if (!route) throw new ForbiddenException('Ruta no disponible');
    await this.manageDeliveries(route.deliveries.map(d => d.id), userId, roles);
    return route;
  }
}
