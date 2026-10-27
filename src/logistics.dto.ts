import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';

export class CreateZoneDto {
  @IsString() @Length(2, 80) code!: string;
  @IsString() @Length(2, 120) name!: string;
}

export class SetActiveDto {
  @IsBoolean() active!: boolean;
}

export class CreateDriverDto {
  @IsUUID() userId!: string;
  @IsString() @Length(2, 150) fullName!: string;
  @IsString() @Length(5, 25) phone!: string;
  @IsString() @Length(3, 40) licenseNumber!: string;
}

export class CreateVehicleDto {
  @IsString() @Length(3, 12) plate!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) capacityKg!: number;
  @IsOptional() @IsBoolean() refrigerated?: boolean;
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
  @IsOptional() @IsString() @Length(5, 500) reason?: string;
  @IsIn(['completed', 'partial', 'failed']) status!: 'completed' | 'partial' | 'failed';
  @IsArray() @ValidateNested({ each: true }) @Type(() => AcceptedLotDto) acceptedLots!: AcceptedLotDto[];
}

export class RecordTemperatureDto {
  @IsNumber({ maxDecimalPlaces: 2 }) temperature!: number;
  @IsDateString() recordedAt!: string;
  @IsString() @Length(3, 100) sensorEventId!: string;
}
