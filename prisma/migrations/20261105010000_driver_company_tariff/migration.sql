ALTER TABLE "drivers" ALTER COLUMN "payPerDelivery" SET DEFAULT 12000, ALTER COLUMN "payPerKm" SET DEFAULT 650;
UPDATE "drivers" SET "payPerDelivery" = 12000, "payPerKm" = 650 WHERE "payPerDelivery" = 5000 AND "payPerKm" = 0;
