import { Type } from 'class-transformer';
import { ArrayMinSize, ArrayMaxSize, Equals, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';

export class CreateZoneDto {
  @IsString() @Length(2, 80) code!: string;
  @IsString() @Length(2, 120) name!: string;
}

export class SetActiveDto {
  @IsBoolean() active!: boolean;
}

export class CreateDriverDto {
  @IsString() @Length(2, 80) baseCity?: string;
  @IsString() @Length(2, 80) baseDepartment?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsBoolean() simulated?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 0 }) @Min(0) @Max(120) preparationMinutes?: number;
  @IsString() @Length(2, 150) fullName!: string;
  @IsString() @Length(5, 25) phone!: string;
  @IsString() @Length(3, 40) licenseNumber!: string;
}
export class AutoPlanRouteDto {
  @IsArray() @ArrayMinSize(1) @IsUUID(undefined, { each: true }) deliveryIds!: string[];
}

export class CreateVehicleDto {
  @IsString() @Length(2, 80) baseCity?: string;
  @IsString() @Length(2, 80) baseDepartment?: string;
  @IsString() @Length(3, 500) baseAddress?: string;
  @IsNumber() @Min(-90) @Max(90) baseLatitude?: number;
  @IsNumber() @Min(-180) @Max(180) baseLongitude?: number;
  @IsString() @Length(3, 12) plate!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) capacityKg!: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) minimumLoadKg?: number;
  @IsOptional() @IsBoolean() refrigerated?: boolean;
  @IsOptional() @IsIn(['van', 'truck', 'pickup', 'motorcycle', 'car', 'bicycle', 'cargo_bike']) kind?: string;
  @IsOptional() @IsString() @Length(0, 80) brand?: string;
  @IsOptional() @IsString() @Length(0, 80) model?: string;
  @IsOptional() @IsIn(['available', 'maintenance', 'out_of_service']) operationalStatus?: string;
  @IsOptional() @IsDateString() insuranceUntil?: string;
  @IsOptional() @IsDateString() inspectionUntil?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) costPerKm?: number;
}

export class DeliveryLocationDto {
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @IsString() @Length(2, 80) zoneCode!: string;
  @IsOptional() @IsBoolean() requiresColdChain?: boolean;
  @IsOptional() @IsDateString() pickupReadyAt?: string;
  @IsOptional() @IsDateString() pickupDeadlineAt?: string;
}
export class DeliveryDispatchDto {
  @IsString() @Length(5, 500) address!: string;
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) longitude!: number;
}
export class SimulationControlDto {
  @IsIn(['start', 'pause', 'resume', 'speed']) action!: string;
  @IsOptional() @IsNumber() @Min(1) @Max(120) speed?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 0 }) @Min(10) @Max(300) confirmationDelaySeconds?: number;
}
export class ReceiptAcknowledgementDto {
  @IsString() @Length(2, 150) receivedByName!: string;
  @IsOptional() @IsString() @Length(0, 1000) receiptNotes?: string;
}
export class PlanRoadRouteDto {
  @IsUUID() driverId!: string;
  @IsUUID() vehicleId!: string;
  @IsString() @Length(2, 80) zoneCode!: string;
  @IsDateString() scheduledDate!: string;
  @IsDateString() scheduledEnd!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsUUID(undefined, { each: true }) deliveryIds!: string[];
  @IsNumber() @Min(-90) @Max(90) originLatitude!: number;
  @IsNumber() @Min(-180) @Max(180) originLongitude!: number;
  @IsOptional() @IsNumber() @Min(1) @Max(120) serviceMinutes?: number;
}
export class ConfirmRoadRouteDto {
  @IsUUID() proposalId!: string;
  @Equals(true) roadRestrictionsReviewed!: boolean;
}
export class RoutePositionDto {
  @IsNumber() @Min(-90) @Max(90) latitude!: number;
  @IsNumber() @Min(-180) @Max(180) longitude!: number;
  @IsNumber() @Min(0) @Max(5000) accuracy!: number;
  @IsDateString() recordedAt!: string;
}
export class RouteIncidentDto {
  @IsIn(['delay', 'damage', 'absence', 'breakdown', 'cold_chain', 'other']) kind!: string;
  @IsString() @Length(5, 1000) message!: string;
  @IsOptional() @IsUUID() deliveryId?: string;
}

export class DeliveryLotDto {
  @IsUUID() reservationId!: string;
  @IsUUID() orderItemId!: string;
  @IsOptional() @IsUUID() producerId?: string;
  @IsUUID() harvestBatchId!: string;
  @IsUUID() farmId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) quantityKg!: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) unitPrice?: number;
  @IsString() @Length(3, 500) pickupAddress!: string;
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) pickupLatitude!: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) pickupLongitude!: number;
}

export class DeliveryPlanItemDto {
  @IsString() @Length(3, 500) deliveryAddress!: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
  @IsDateString() windowStart!: string;
  @IsDateString() windowEnd!: string;
  @IsOptional() @IsBoolean() requiresColdChain?: boolean;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DeliveryLotDto) lots!: DeliveryLotDto[];
}

export class CreateDeliveryPlanDto {
  @IsUUID() orderId!: string;
  @IsOptional() @IsUUID() buyerId?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DeliveryPlanItemDto) deliveries!: DeliveryPlanItemDto[];
}

export class RouteStopDto {
  @Type(() => Number) @IsNumber() @Min(1) sequence!: number;
  @IsUUID() deliveryId!: string;
  @IsIn(['pickup', 'dropoff']) type!: 'pickup' | 'dropoff';
  @IsOptional() @IsUUID() farmId?: string;
  @IsString() @Length(3, 500) address!: string;
  @IsDateString() plannedAt!: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;
}

export class CreateRouteDto {
  @IsUUID() driverId!: string;
  @IsUUID() vehicleId!: string;
  @IsString() @Length(2, 80) zoneCode!: string;
  @IsDateString() scheduledDate!: string;
  @IsDateString() scheduledEnd!: string;
  @IsArray() @ArrayMinSize(1) @IsUUID(undefined, { each: true }) deliveryIds!: string[];
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => RouteStopDto) stops!: RouteStopDto[];
}

export class AcceptedLotDto {
  @IsUUID() reservationId!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) acceptedQuantityKg!: number;
}

export class CloseDeliveryDto {
  @IsOptional() @IsString() @Length(2, 150) receivedByName?: string;
  @IsOptional() @IsString() @Length(0, 1000) receiptNotes?: string;
  @IsOptional() @IsString() @Length(5, 500) reason?: string;
  @IsIn(['completed', 'partial', 'failed']) status!: 'completed' | 'partial' | 'failed';
  @IsArray() @ValidateNested({ each: true }) @Type(() => AcceptedLotDto) acceptedLots!: AcceptedLotDto[];
}

export class RecordTemperatureDto {
  @IsNumber({ maxDecimalPlaces: 2 }) temperature!: number;
  @IsDateString() recordedAt!: string;
  @IsString() @Length(3, 100) sensorEventId!: string;
}
