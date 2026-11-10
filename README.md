# Cocos Challenge: portfolio, búsqueda y órdenes

API en NestJS + Postgres para el [enunciado](backend-challenge.md). Lo difícil es que el dinero cierre con órdenes en paralelo. Las decisiones y sus alternativas están en [DECISIONS.md](DECISIONS.md).

Seed, usuario 1: cash 753.000,00, reservado 125.500,00 (dos LIMIT BUY NEW), disponible 627.500,00, valor total 889.756,00. Es el primer test (`test/portfolio.e2e-spec.ts`); las anomalías del seed están en D-11.

## Correr

```bash
docker compose up --build     # Postgres con el seed + API en http://localhost:3000
```

Ejemplos en [requests.http](requests.http). Contra otra base, por ejemplo la provista:

```bash
npm ci
DATABASE_URL='postgres://usuario:clave@host/base?sslmode=verify-full' npm run start:dev
```

La app no crea ni migra nada. Idempotencia y auditoría necesitan `psql "$DATABASE_URL" -f db/local-additions.sql`; sin eso, `Idempotency-Key` recibe 501 (D-10).

## Verificar

```bash
npm run verify   # typecheck + unit + e2e contra Postgres real (Testcontainers)
```

Necesita Docker y Node 22.13+; ~1 min. Cada test o archivo usa una base nueva; el harness se niega a correr contra un host no local. CI corre lo mismo.

## Endpoints

| Método y ruta | Qué hace |
|---|---|
| `GET /users/:userId/portfolio` | Valor total, cash (saldo, reservado, disponible) y posiciones con valor y rendimiento total y diario |
| `GET /instruments?q=gal` | Busca parcial por ticker o nombre; ticker exacto primero |
| `POST /users/:userId/orders` | Envía una orden. Header opcional `Idempotency-Key` |
| `POST /users/:userId/orders/:orderId/cancel` | Cancela una orden NEW |

Orden: `{ "instrumentId": 34, "side": "BUY", "type": "MARKET", "size": 10 }`, o `amount` (ARS) en lugar de `size`. `LIMIT` necesita `price`; `MARKET` toma el último `close`. El dinero viaja como string: `"price": "900.00"`.

## Qué responde cada caso

| Caso | HTTP | Se guarda |
|---|---|---|
| MARKET con fondos o acciones | 201 `FILLED` | sí |
| LIMIT con fondos o acciones (los reserva) | 201 `NEW` | sí |
| Más que el disponible, vender BMA, MARKET sin precio, o monto menor a una acción | 201 `REJECTED` + `reason` | sí |
| Body inválido, `CASH_IN`/`CASH_OUT`, comprar ARS o monto fuera de rango | 400 | no |
| Body de más de 100 kB / charset que no es UTF-8 | 413 / 415 | no |
| Usuario, instrumento u orden inexistente o ajena | 404 | no |
| Cancelar una orden que no está NEW | 409 | no |
| Misma `Idempotency-Key` con otro body | 422 | no |
| `Idempotency-Key` sin la tabla de idempotencia | 501 | no |
| Lock, sentencia, transacción inactiva o pool fuera de tiempo; base que rechaza la conexión | 503 + `Retry-After` | no |
| Error inesperado (conexión perdida a mitad de transacción, bug) | 500 | desconocido: reintentar con la misma `Idempotency-Key` |

Errores en RFC 9457 (`application/problem+json`) con un `code` estable. Cada fila tiene un test e2e, salvo la conexión rechazada (unitario, `src/common/problem.spec.ts`).

## Revisar en 15 minutos

1. `src/orders/orders.service.ts` `place()`: lock → instrumento, precio y disponible → decidir → insertar, en una transacción.
2. `src/ledger.repository.ts` `lockUser` y `src/database/db.ts`: el lock por usuario y los límites de tiempo.
3. `src/orders/decide.ts` y `src/portfolio/positions.ts`: reglas de negocio puras, con tests unitarios.
4. `test/concurrency.e2e-spec.ts`: la carrera, probada. `test/harness.ts` `assertInvariants` revisa cada base antes de cerrarla.
