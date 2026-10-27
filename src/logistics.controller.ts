import { Body, Controller, ForbiddenException, Get, Headers, Param, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { CloseDeliveryDto, CreateDeliveryPlanDto, CreateDriverDto, CreateRouteDto, CreateVehicleDto, CreateZoneDto, RecordTemperatureDto, SetActiveDto } from './logistics.dto';
import { LogisticsService } from './logistics.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; roles: string[] };
}

@Controller()
export class LogisticsController {
  constructor(private readonly service: LogisticsService) {}

  @Get('deliveries') deliveries(@Req() req: AuthenticatedRequest) { return this.service.listDeliveries(req.user.sub, req.user.roles); }
  @Patch('deliveries/:id/confirm') confirmDelivery(@Param('id') id: string, @Body() dto: CloseDeliveryDto, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string, @Headers('x-correlation-id') correlationId?: string) {
    return this.service.closeDelivery(id, dto, req.user.sub, false, operationId ?? '', correlationId ?? '', true);
  }

  @Get('logistics/zones') zones() { return this.service.listZones(); }
  @Post('logistics/zones') createZone(@Body() dto: CreateZoneDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.createZone(dto); }
  @Patch('logistics/zones/:code/active') setZoneActive(@Param('code') code: string, @Body() dto: SetActiveDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.setZoneActive(code, dto.active); }
  @Get('drivers') drivers(@Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.listDrivers(); }
  @Post('drivers') createDriver(@Body() dto: CreateDriverDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.createDriver(dto); }
  @Patch('drivers/:id/active') setDriverActive(@Param('id') id: string, @Body() dto: SetActiveDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.setDriverActive(id, dto.active); }
  @Get('vehicles') vehicles(@Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.listVehicles(); }
  @Post('vehicles') createVehicle(@Body() dto: CreateVehicleDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.createVehicle(dto); }
  @Patch('vehicles/:id/active') setVehicleActive(@Param('id') id: string, @Body() dto: SetActiveDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.setVehicleActive(id, dto.active); }

  /** Solo el Gateway/service account puede crear el plan desde el pedido confirmado. */
  @Post('internal/logistics/plans') createPlan(@Body() dto: CreateDeliveryPlanDto, @Headers('x-internal-api-key') key: string, @Headers('x-correlation-id') correlationId?: string) {
    this.requireInternalKey(key);
    return this.service.createPlan(dto, correlationId ?? '');
  }

  @Get('routes') routes(@Req() req: AuthenticatedRequest) {
    if (req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')) return this.service.listRoutes();
    if (req.user.roles?.includes('driver')) return this.service.listRoutes(req.user.sub);
    throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
  }
  @Post('routes') createRoute(@Body() dto: CreateRouteDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) {
    this.requireAdmin(req);
    return this.service.createRoute(dto, correlationId ?? '');
  }
  @Patch('routes/:id/dispatch') dispatch(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.dispatchRoute(id, req.user.sub, Boolean(req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')), operationId ?? '', correlationId ?? '');
  }
  @Patch('deliveries/:id/close') closeDelivery(@Param('id') id: string, @Body() dto: CloseDeliveryDto, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.closeDelivery(id, dto, req.user.sub, req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin') || false, operationId ?? '', correlationId ?? '');
  }
  @Post('deliveries/:id/temperature') temperature(@Param('id') id: string, @Body() dto: RecordTemperatureDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.recordTemperature(id, dto, req.user.sub, Boolean(req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')), correlationId ?? '');
  }
  @Patch('routes/:routeId/stops/:stopId/arrive') arriveAtStop(@Param('routeId') routeId: string, @Param('stopId') stopId: string, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.arriveAtStop(routeId, stopId, req.user.sub, Boolean(req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')), operationId ?? '');
  }

  private requireAdmin(req: AuthenticatedRequest) {
    if (!req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol logistics_admin');
  }
  private requireInternalKey(supplied: string | undefined) {
    const expected = process.env.INTERNAL_API_KEY ?? '';
    const a = Buffer.from(String(supplied ?? '')); const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Clave de servicio inválida');
  }
}
