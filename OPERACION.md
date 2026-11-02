# Centro logístico

Incluye flota y conductores, planificación vial, despacho, seguimiento, incidencias, GPS voluntario y comprobante de recepción.

## Configuración

`OSRM_URL` debe apuntar al motor privado que tenga cartografía de la zona operativa. En Railway: `http://routing-osrm.railway.internal:5000`. No contiene una clave ni debe exponerse al navegador. La aplicación falla con un mensaje claro si no puede calcular la ruta; no usa recorridos ficticios ni cambia de proveedor silenciosamente.

`ALLOW_LEGACY_ROUTE_CREATION=false` mantiene deshabilitada la creación manual sin propuesta vial. Las rutas existentes se conservan. Las nuevas se crean con `POST /api/v1/routes/preview` y `POST /api/v1/routes/confirm`; la confirmación requiere `roadRestrictionsReviewed: true`.

## Reglas

- Vehículos: placa única, capacidad positiva, refrigeración y estado operativo. Las modificaciones se bloquean si hay rutas activas.
- Destinos: punto geográfico y zona confirmados antes de planificar. Logística establece el requisito de frío; el comprador solo puede corregir su destino antes de asignación.
- Propuesta: hasta diez entregas y 25 paradas, salida futura y duración máxima de 48 horas. Se calculan tiempos por carretera y carga por tramo, con recogida previa a entrega y ventanas originales.
- La búsqueda es una heurística acotada; no promete un óptimo global. OSRM usa perfil de automóvil, sin tráfico en vivo. El operador revisa restricciones de acceso del vehículo antes de confirmar.
- La propuesta vence a los quince minutos; confirmar revalida recursos y cambios de datos dentro de una transacción serializable. Reintentar la misma propuesta conserva la ruta.
- Conductor: únicamente rutas asignadas. La ubicación se transmite voluntariamente mientras esté abierta la ventana de operación. Se guarda solo la última posición, con hora y precisión; una señal mayor a dos minutos se marca antigua. El comprador solo la ve mientras su entrega esté en tránsito.
- Las incidencias y operaciones usan claves de idempotencia. No permiten completar una entrega en nombre del comprador. El comprador confirma kilos y recepción después de la llegada registrada.
- Costos por km y recorridos son estimaciones, no cargos ni kilómetros medidos por GPS. Vencimientos documentales generan avisos; no se presentan como verificación legal automatizada.

## Verificación

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
En el proyecto de integración, `scripts/operations-integration.cjs` utiliza una base PostgreSQL local exclusiva, OSRM local y Playwright; cubre registro/edición de flota, permisos, planificación, despacho, GPS, incidencias, llegada y recepción idempotente. No lee `.env` ni envía correos reales. El servicio de pagos en esa prueba es un doble HTTP controlado; el cierre continúa emitiendo eventos financieros para el flujo existente.

La migración es aditiva y se ha probado tanto desde una base vacía como sobre un vehículo creado con el esquema anterior.
