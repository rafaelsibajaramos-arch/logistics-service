ALTER TABLE "vehicles"
 ADD COLUMN "kind" VARCHAR(30) NOT NULL DEFAULT 'van',
 ADD COLUMN "brand" VARCHAR(80), ADD COLUMN "model" VARCHAR(80),
 ADD COLUMN "operationalStatus" VARCHAR(30) NOT NULL DEFAULT 'available',
 ADD COLUMN "insuranceUntil" DATE, ADD COLUMN "inspectionUntil" DATE,
 ADD CONSTRAINT "vehicle_operational_status" CHECK ("operationalStatus" IN ('available','maintenance','out_of_service'));
ALTER TABLE "deliveries" ADD COLUMN "latitude" DOUBLE PRECISION, ADD COLUMN "longitude" DOUBLE PRECISION,
 ADD COLUMN "zoneCode" VARCHAR(80), ADD COLUMN "locationConfirmedAt" TIMESTAMP(3),
 ADD CONSTRAINT "delivery_coordinates" CHECK (("latitude" IS NULL AND "longitude" IS NULL) OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180));
ALTER TABLE "routes" ADD COLUMN "roadPlan" JSONB, ADD COLUMN "calculatedAt" TIMESTAMP(3),
 ADD COLUMN "distanceMeters" DOUBLE PRECISION, ADD COLUMN "durationSeconds" DOUBLE PRECISION,
 ADD COLUMN "peakLoadKg" DECIMAL(12,3), ADD COLUMN "lastLatitude" DOUBLE PRECISION,
 ADD COLUMN "lastLongitude" DOUBLE PRECISION, ADD COLUMN "lastAccuracy" DOUBLE PRECISION, ADD COLUMN "lastPositionAt" TIMESTAMP(3);
ALTER TABLE "route_stops" ADD COLUMN "latitude" DOUBLE PRECISION, ADD COLUMN "longitude" DOUBLE PRECISION;
CREATE TABLE "route_activities" (
 "id" UUID NOT NULL, "routeId" UUID NOT NULL, "deliveryId" UUID, "actorId" UUID NOT NULL,
 "kind" VARCHAR(40) NOT NULL, "message" VARCHAR(1000) NOT NULL, "operationId" UUID NOT NULL,
 "resolvedAt" TIMESTAMP(3), "resolvedBy" UUID, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "route_activities_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "route_activities_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "route_activities_operationId_key" ON "route_activities"("operationId");
CREATE INDEX "route_activities_routeId_createdAt_idx" ON "route_activities"("routeId","createdAt");
CREATE TABLE "route_proposals" (
 "id" UUID NOT NULL, "actorId" UUID NOT NULL, "payload" JSONB NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "routeId" UUID, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "route_proposals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "route_proposals_expiresAt_idx" ON "route_proposals"("expiresAt");
ALTER TABLE "vehicles" ADD COLUMN "costPerKm" DECIMAL(12,2), ADD CONSTRAINT "vehicle_cost_nonnegative" CHECK ("costPerKm" IS NULL OR "costPerKm" >= 0);
ALTER TABLE "routes" ADD COLUMN "estimatedCost" DECIMAL(14,2);
ALTER TABLE "deliveries" ADD COLUMN "receivedByName" VARCHAR(150), ADD COLUMN "receiptNotes" VARCHAR(1000);
