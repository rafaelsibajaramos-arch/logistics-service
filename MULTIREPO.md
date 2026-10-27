# logistics-service: repositorio independiente

[![CI/CD](https://github.com/rafaelsibajaramos-arch/logistics-service/actions/workflows/deploy.yml/badge.svg)](https://github.com/rafaelsibajaramos-arch/logistics-service/actions/workflows/deploy.yml)

Código exportado del proyecto [FarmToTable](https://github.com/rafaelsibajaramos-arch/fram), commit `c1ed790`. No se copió el historial anterior, archivos `.env`, respaldos ni dependencias instaladas.

## Desarrollo

```sh
npm ci
npm run prisma:generate
npm run typecheck
npm run lint
npm test -- --runInBand
npm run build
```

La configuración ESLint es local: `eslint.config.mjs`. Consulta también `README.md` y `.env.example`. Solo usa el ejemplo como plantilla y configura credenciales fuera de Git.

## Workflow conectado

`.github/workflows/deploy.yml` invoca [pipelines](https://github.com/rafaelsibajaramos-arch/pipelines) mediante `workflow_call`.

- PR: pruebas, tipos, lint, compilación e imagen Docker, sin despliegue ni secretos de producción.
- Push a `main`: mismas validaciones, imagen GHCR etiquetada con SHA y despliegue si `DEPLOY_ENABLED=true`.
- Ejecución manual con `failure-demo=true`: prueba intencionalmente fallida; Docker y deploy deben quedar omitidos.
- Los datos de Neon y credenciales de la aplicación permanecen en Railway, no en GitHub.
- El job deploy publica en Railway el mismo commit validado. Railway vuelve a construirlo con este Dockerfile; la imagen GHCR es una evidencia auditable del job Docker, no una imagen distinta usada en producción.

### Configuración de GitHub Actions

Repository variables: `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `DEPLOY_ENABLED`.

Repository secret: `RAILWAY_TOKEN`, token de proyecto acotado al entorno producción. No utilizar un token personal de cuenta para desplegar.

Railway debe apuntar a la raíz `/`, Dockerfile `Dockerfile` y configuración `/railway.toml`. El despliegue lo controla Actions; no mantener un segundo autodespliegue desde `fram` que pueda saltarse las pruebas.

## Evidencias académicas

Enlaces de ejecuciones, capturas y reflexión: [repositorio pipelines](https://github.com/rafaelsibajaramos-arch/pipelines). No marcar una ejecución como exitosa hasta que el job deploy confirme `SUCCESS` en Railway.
