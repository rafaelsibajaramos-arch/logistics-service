ALTER TABLE drivers ADD COLUMN simulated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN "preparationMinutes" INTEGER NOT NULL DEFAULT 15 CHECK ("preparationMinutes" BETWEEN 0 AND 120);
ALTER TABLE vehicles ADD COLUMN "minimumLoadKg" NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK ("minimumLoadKg" >= 0 AND "minimumLoadKg" <= "capacityKg");
ALTER TABLE deliveries ADD COLUMN "pickupReadyAt" TIMESTAMP(3);
ALTER TABLE deliveries ADD COLUMN "pickupDeadlineAt" TIMESTAMP(3);
ALTER TABLE deliveries ADD COLUMN "transportCompletedAt" TIMESTAMP(3);
ALTER TABLE deliveries ADD COLUMN "buyerConfirmedAt" TIMESTAMP(3);
ALTER TABLE deliveries ADD COLUMN "completionSource" VARCHAR(30);
CREATE TABLE route_simulations (
 id UUID PRIMARY KEY, "routeId" UUID NOT NULL UNIQUE REFERENCES routes(id), "actorId" UUID NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'paused', speed DOUBLE PRECISION NOT NULL DEFAULT 30 CHECK (speed BETWEEN 1 AND 120),
 "elapsedSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK ("elapsedSeconds" >= 0), "anchorAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "confirmationDelaySeconds" INTEGER NOT NULL DEFAULT 45 CHECK ("confirmationDelaySeconds" BETWEEN 10 AND 300),
 cursor INTEGER NOT NULL DEFAULT 0, timeline JSONB NOT NULL,
 "leaseUntil" TIMESTAMP(3), "leaseToken" UUID, error VARCHAR(500),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX route_simulations_status_lease_idx ON route_simulations(status,"leaseUntil");
