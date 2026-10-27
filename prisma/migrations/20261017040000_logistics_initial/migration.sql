-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('planned', 'in_transit', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('scheduled', 'in_transit', 'completed', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('draft', 'confirmed', 'closed');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('pickup', 'dropoff');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'published', 'failed');

-- CreateTable
CREATE TABLE "zones" (
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fullName" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(25) NOT NULL,
    "licenseNumber" VARCHAR(40) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "plate" VARCHAR(12) NOT NULL,
    "capacityKg" DECIMAL(12,3) NOT NULL,
    "refrigerated" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routes" (
    "id" UUID NOT NULL,
    "driverId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "zoneCode" VARCHAR(80) NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "status" "RouteStatus" NOT NULL DEFAULT 'planned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_plans" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'draft',
    "confirmedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "routeId" UUID,
    "orderId" UUID NOT NULL,
    "deliveryAddress" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'scheduled',
    "requiresColdChain" BOOLEAN NOT NULL DEFAULT false,
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_lots" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "harvestBatchId" UUID NOT NULL,
    "farmId" UUID NOT NULL,
    "quantityKg" DECIMAL(12,3) NOT NULL,
    "acceptedQuantityKg" DECIMAL(12,3),
    "pickupAddress" TEXT NOT NULL,
    "pickupLatitude" DECIMAL(9,6) NOT NULL,
    "pickupLongitude" DECIMAL(9,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_stops" (
    "id" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "StopType" NOT NULL,
    "farmId" UUID,
    "address" TEXT NOT NULL,
    "plannedAt" TIMESTAMP(3) NOT NULL,
    "actualAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temperature_records" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "temperature" DECIMAL(5,2) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "sensorEventId" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperature_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_operations" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "operation" VARCHAR(80) NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logistics_outbox_events" (
    "id" UUID NOT NULL,
    "eventType" VARCHAR(120) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "routingKey" VARCHAR(160),
    "sourceService" VARCHAR(80) NOT NULL DEFAULT 'logistics-service',
    "entityVersion" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "correlationId" VARCHAR(180) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "logistics_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_userId_key" ON "drivers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_licenseNumber_key" ON "drivers"("licenseNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_plate_key" ON "vehicles"("plate");

-- CreateIndex
CREATE INDEX "routes_driverId_scheduledDate_scheduledEnd_idx" ON "routes"("driverId", "scheduledDate", "scheduledEnd");

-- CreateIndex
CREATE INDEX "routes_vehicleId_scheduledDate_scheduledEnd_idx" ON "routes"("vehicleId", "scheduledDate", "scheduledEnd");

-- CreateIndex
CREATE INDEX "routes_zoneCode_scheduledDate_idx" ON "routes"("zoneCode", "scheduledDate");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_plans_orderId_key" ON "delivery_plans"("orderId");

-- CreateIndex
CREATE INDEX "deliveries_routeId_status_idx" ON "deliveries"("routeId", "status");

-- CreateIndex
CREATE INDEX "deliveries_orderId_idx" ON "deliveries"("orderId");

-- CreateIndex
CREATE INDEX "deliveries_planId_idx" ON "deliveries"("planId");

-- CreateIndex
CREATE INDEX "delivery_lots_reservationId_idx" ON "delivery_lots"("reservationId");

-- CreateIndex
CREATE INDEX "delivery_lots_harvestBatchId_idx" ON "delivery_lots"("harvestBatchId");

-- CreateIndex
CREATE INDEX "delivery_lots_farmId_idx" ON "delivery_lots"("farmId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_lots_deliveryId_reservationId_key" ON "delivery_lots"("deliveryId", "reservationId");

-- CreateIndex
CREATE INDEX "route_stops_deliveryId_idx" ON "route_stops"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "route_stops_routeId_sequence_key" ON "route_stops"("routeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "temperature_records_sensorEventId_key" ON "temperature_records"("sensorEventId");

-- CreateIndex
CREATE INDEX "temperature_records_deliveryId_recordedAt_idx" ON "temperature_records"("deliveryId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "processed_operations_operationId_key" ON "processed_operations"("operationId");

-- CreateIndex
CREATE INDEX "processed_operations_operation_resourceId_idx" ON "processed_operations"("operation", "resourceId");

-- CreateIndex
CREATE INDEX "logistics_outbox_events_status_availableAt_idx" ON "logistics_outbox_events"("status", "availableAt");

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_zoneCode_fkey" FOREIGN KEY ("zoneCode") REFERENCES "zones"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_planId_fkey" FOREIGN KEY ("planId") REFERENCES "delivery_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_lots" ADD CONSTRAINT "delivery_lots_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temperature_records" ADD CONSTRAINT "temperature_records_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
