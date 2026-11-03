import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Req, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { CloseDeliveryDto, ConfirmRoadRouteDto, CreateDeliveryPlanDto, CreateDriverDto, CreateRouteDto, CreateVehicleDto, CreateZoneDto, DeliveryLocationDto, PlanRoadRouteDto, RecordTemperatureDto, RouteIncidentDto, RoutePositionDto, SetActiveDto } from './logistics.dto';
import { LogisticsService } from './logistics.service';
import { OperationsService } from './operations.service';
import { SimulationService } from './simulation.service';
import { AutoPlanRouteDto } from './logistics.dto';
import { LogisticsAccessService } from './logistics-access.service';
import { SimulationControlDto, ReceiptAcknowledgementDto } from './logistics.dto';

interface AuthenticatedRequest extends Request {
  user: { sub: string; roles: string[] };
}

@Controller()
export class LogisticsController {
  constructor(private readonly service: LogisticsService, private readonly operations: OperationsService, private readonly simulations: SimulationService, private readonly access: LogisticsAccessService) {}
  @Get('logistics/resources') resources(@Req() req: AuthenticatedRequest) { return this.operations.resources(req.user.sub, req.user.roles); }
  @Post('routes/:id/simulation') simulation(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SimulationControlDto, @Req() req: AuthenticatedRequest) { return this.simulations.control(id, dto, req.user.sub, req.user.roles); }
  @Post('deliveries/:id/acknowledge') acknowledge(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReceiptAcknowledgementDto, @Req() req: AuthenticatedRequest) { return this.operations.acknowledge(id, req.user.sub, dto.receivedByName, dto.receiptNotes); }

  @Get('logistics/overview') overview(@Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.operations.overview(); }
  @Patch('vehicles/:id') editVehicle(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CreateVehicleDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.operations.updateVehicle(id, dto); }
  @Patch('drivers/:id') editDriver(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CreateDriverDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.operations.updateDriver(id, dto); }
  @Patch('deliveries/:id/location') location(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: DeliveryLocationDto, @Req() req: AuthenticatedRequest) { return this.operations.locateDelivery(id, dto, req.user.sub, req.user.roles); }
  @Get('deliveries/:id/tracking') tracking(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) { return this.operations.tracking(id, req.user.sub, req.user.roles); }
  @Post('routes/preview') preview(@Body() dto: PlanRoadRouteDto, @Req() req: AuthenticatedRequest) { return this.operations.preview(dto, req.user.sub, req.user.roles); }
  @Post('routes/auto-plan') autoPlan(@Body() dto: AutoPlanRouteDto, @Req() req: AuthenticatedRequest) { return this.operations.autoPlan(dto.deliveryIds, req.user.sub, req.user.roles); }
  @Post('routes/confirm') confirm(@Body() dto: ConfirmRoadRouteDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlation?: string) { return this.operations.confirmProposal(dto.proposalId, req.user.sub, correlation ?? '', req.user.roles); }
  @Patch('routes/:id/cancel') async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) { await this.access.manageRoute(id, req.user.sub, req.user.roles); return this.operations.cancelRoute(id, req.user.sub); }
  @Post('routes/:id/position') position(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RoutePositionDto, @Req() req: AuthenticatedRequest) { return this.operations.position(id, dto, req.user.sub, req.user.roles); }
  @Post('routes/:id/incidents') incident(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RouteIncidentDto, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string) { return this.operations.incident(id, dto, req.user.sub, req.user.roles, operationId ?? ''); }
  @Patch('routes/:routeId/incidents/:id/resolve') resolve(@Param('routeId', new ParseUUIDPipe()) routeId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.operations.resolveIncident(routeId, id, req.user.sub); }

  @Get('deliveries') deliveries(@Req() req: AuthenticatedRequest) { return this.service.listDeliveries(req.user.sub, req.user.roles); }
  @Patch('deliveries/:id/confirm') confirmDelivery(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CloseDeliveryDto, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string, @Headers('x-correlation-id') correlationId?: string) {
    return this.service.closeDelivery(id, dto, req.user.sub, false, operationId ?? '', correlationId ?? '', true);
  }

  @Get('logistics/zones') zones() { return this.service.listZones(); }
  @Post('logistics/zones') createZone(@Body() dto: CreateZoneDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.createZone(dto); }
  @Patch('logistics/zones/:code/active') setZoneActive(@Param('code') code: string, @Body() dto: SetActiveDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.setZoneActive(code, dto.active); }
  @Get('drivers') drivers(@Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.listDrivers(); }
  @Post('drivers') createDriver(@Body() dto: CreateDriverDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.createDriver(dto); }
  @Patch('drivers/:id/active') setDriverActive(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SetActiveDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.setDriverActive(id, dto.active); }
  @Get('vehicles') vehicles(@Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.listVehicles(); }
  @Post('vehicles') createVehicle(@Body() dto: CreateVehicleDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.createVehicle(dto); }
  @Patch('vehicles/:id/active') setVehicleActive(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SetActiveDto, @Req() req: AuthenticatedRequest) { this.requireAdmin(req); return this.service.setVehicleActive(id, dto.active); }

  /** Solo el Gateway/service account puede crear el plan desde el pedido confirmado. */
  @Post('internal/logistics/plans') createPlan(@Body() dto: CreateDeliveryPlanDto, @Headers('x-internal-api-key') key: string, @Headers('x-correlation-id') correlationId?: string) {
    this.requireInternalKey(key);
    return this.service.createPlan(dto, correlationId ?? '');
  }

  @Get('routes') routes(@Req() req: AuthenticatedRequest) {
    if (!req.user.roles?.some(r => ['admin', 'logistics_admin'].includes(r)) && req.user.roles?.includes('producer')) return this.operations.producerRoutes(req.user.sub, req.user.roles);
    if (req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')) return this.service.listRoutes();
    if (req.user.roles?.includes('driver')) return this.service.listRoutes(req.user.sub);
    throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
  }
  @Post('routes') createRoute(@Body() dto: CreateRouteDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) {
    this.requireAdmin(req);
    if (process.env.ALLOW_LEGACY_ROUTE_CREATION !== 'true') throw new ForbiddenException('Calcula y confirma una propuesta vial antes de crear la ruta');
    return this.service.createRoute(dto, correlationId ?? '');
  }
  @Patch('routes/:id/dispatch') dispatch(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.dispatchRoute(id, req.user.sub, Boolean(req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')), operationId ?? '', correlationId ?? '');
  }
  @Patch('deliveries/:id/close') closeDelivery(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CloseDeliveryDto, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.closeDelivery(id, dto, req.user.sub, req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin') || false, operationId ?? '', correlationId ?? '');
  }
  @Post('deliveries/:id/temperature') temperature(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RecordTemperatureDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user.roles?.includes('driver') && !req.user.roles?.includes('admin') && !req.user.roles?.includes('logistics_admin')) throw new ForbiddenException('Se requiere el rol driver o logistics_admin');
    return this.service.recordTemperature(id, dto, req.user.sub, Boolean(req.user.roles?.includes('admin') || req.user.roles?.includes('logistics_admin')), correlationId ?? '');
  }
  @Patch('routes/:routeId/stops/:stopId/arrive') arriveAtStop(@Param('routeId', new ParseUUIDPipe()) routeId: string, @Param('stopId', new ParseUUIDPipe()) stopId: string, @Req() req: AuthenticatedRequest, @Headers('x-operation-id') operationId?: string) {
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
