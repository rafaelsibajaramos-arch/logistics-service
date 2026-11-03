ALTER TABLE "drivers" ADD COLUMN "payPerDelivery" DECIMAL(12,2) NOT NULL DEFAULT 5000, ADD COLUMN "payPerKm" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "routes" ADD COLUMN "driverPayPerDelivery" DECIMAL(12,2), ADD COLUMN "driverPayPerKm" DECIMAL(12,2);
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_pay_nonnegative" CHECK ("payPerDelivery" >= 0 AND "payPerKm" >= 0);
ALTER TABLE "routes" ADD CONSTRAINT "routes_driver_pay_nonnegative" CHECK (("driverPayPerDelivery" IS NULL OR "driverPayPerDelivery" >= 0) AND ("driverPayPerKm" IS NULL OR "driverPayPerKm" >= 0));
