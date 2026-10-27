ALTER TABLE "delivery_plans" ADD COLUMN "paymentId" UUID;
ALTER TABLE "delivery_lots" ADD COLUMN "unitPrice" DECIMAL(12,2);
