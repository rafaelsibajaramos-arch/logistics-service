export interface EventEnvelope {
  event_id: string;
  event_type: string;
  source_service: string;
  entity_id: string;
  entity_version: number;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}
