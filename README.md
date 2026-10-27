# Logistics Service

Servicio NestJS/Prisma dueño de zonas, perfiles operativos de conductores, vehículos, planes, rutas, paradas, entregas parciales y lecturas de cadena de frío. Las referencias a pedidos, reservas, lotes, fincas y usuarios son UUID externos; no se crean claves foráneas entre bases.

## Configuración local

Copiar `.env.example` a `.env` dentro de este servicio. `DATABASE_URL` es la conexión runtime; `DIRECT_URL` debe ser conexión PostgreSQL directa para migraciones (sin `-pooler`). `INTERNAL_API_KEY` debe coincidir con la de los servicios que llamen endpoints internos. No usar credenciales de producción en pruebas.

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
npm test
```

El servicio escucha `PORT` (3007 por defecto), bajo `/api/v1`, y publica eventos durables por outbox a `RABBITMQ_EXCHANGE`. Si RabbitMQ no está disponible, conserva los eventos pendientes y readiness responde 503.

El consumer `logistics-service.orders` materializa `order.confirmed` en un plan con ventanas deterministas derivadas de `occurred_at`; configura `DELIVERY_WINDOW_START_DAYS` y `DELIVERY_WINDOW_END_DAYS` (por defecto 1 y 7). `order.cancelled` se registra idempotentemente y no puede cancelar entregas que ya tengan ruta asignada.

## Endpoints implementados

- `GET /api/v1/health` y `GET /api/v1/health/ready`.
- `GET/POST /api/v1/logistics/zones`; `POST` requiere admin o `logistics_admin`.
- `GET/POST /api/v1/drivers` y `/api/v1/vehicles`; requieren admin o `logistics_admin`.
- `POST /api/v1/internal/logistics/plans`; requiere `x-internal-api-key`. Crea idempotentemente un plan con una o más entregas, ventanas, asignaciones de reserva/lote/finca y snapshots de recogida.
- `GET/POST /api/v1/routes`; administra la planificación, valida que conductor/vehículo estén disponibles, la capacidad, refrigeración, ventanas, paradas y precedencia recogida→entrega. La lectura de rutas del conductor se limita a su `user_id`.
- `PATCH /api/v1/routes/:id/dispatch`, `PATCH /api/v1/routes/:routeId/stops/:stopId/arrive`, `PATCH /api/v1/deliveries/:id/close` y `POST /api/v1/deliveries/:id/temperature`; conductor asignado o admin, con `x-operation-id` en operaciones móviles. Temperatura usa `sensorEventId` idempotente y emite `cold_chain.alert` sobre `COLD_CHAIN_MAX_C`.

Cerrar todas las entregas de un plan emite `order.fulfillment_closed` con kg e importe aceptados por línea, usando snapshots del precio y el pago del pedido. Pedidos y Pagos consumen ese evento con inbox idempotente: Pedidos marca el resultado completo/parcial/fallido y Pagos captura solo lo aceptado, libera el restante o anula la autorización si no se aceptó nada. `completed` exige aceptación total; `partial` exige una cantidad estrictamente intermedia; `failed` exige cero. Los estados físicos no reponen inventario por sí solos.

## Estado / límites conocidos

Las migraciones inicial, inbox y snapshot financiero fueron generadas desde el esquema Prisma y aplicadas a un contenedor PostgreSQL 16 efímero. Nueve pruebas unitarias validan reglas críticas, el contrato de `order.confirmed` y la transacción del inbox. Aún faltan: verificar autorización vigente antes del despacho, reprogramaciones auditadas, pruebas E2E/concurrencia y la app React Native offline-first especificada en `MOMENTO 1.pdf`. Por eso la saga completa no se declara lista.
