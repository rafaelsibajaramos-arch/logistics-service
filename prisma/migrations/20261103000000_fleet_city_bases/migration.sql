ALTER TABLE drivers ADD COLUMN "baseCity" VARCHAR(80), ADD COLUMN "baseDepartment" VARCHAR(80);
ALTER TABLE vehicles ADD COLUMN "baseCity" VARCHAR(80), ADD COLUMN "baseDepartment" VARCHAR(80), ADD COLUMN "baseAddress" VARCHAR(500), ADD COLUMN "baseLatitude" DOUBLE PRECISION, ADD COLUMN "baseLongitude" DOUBLE PRECISION;
ALTER TABLE vehicles ADD CONSTRAINT vehicle_base_coordinates CHECK (("baseLatitude" IS NULL AND "baseLongitude" IS NULL) OR ("baseLatitude" IS NOT NULL AND "baseLongitude" IS NOT NULL AND "baseLatitude" BETWEEN -90 AND 90 AND "baseLongitude" BETWEEN -180 AND 180));
