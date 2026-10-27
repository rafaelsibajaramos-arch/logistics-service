CREATE TABLE "logistics_processed_events" (
    "eventId" UUID NOT NULL,
    "eventType" VARCHAR(120) NOT NULL,
    "sourceService" VARCHAR(80) NOT NULL,
    "entityId" UUID NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "logistics_processed_events_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "logistics_processed_events_entityId_eventType_idx"
  ON "logistics_processed_events"("entityId", "eventType");
