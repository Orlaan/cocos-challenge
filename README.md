# Cocos Challenge: portfolio, búsqueda y órdenes

*English: a NestJS + Postgres API for the Cocos challenge. Orders of one user are serialised by a Postgres row lock, so cash and shares never go negative under parallel orders (`test/concurrency.e2e-spec.ts`). Docs are in Spanish; code and tests in English.*

API en NestJS + Postgres que resuelve el [enunciado](backend-challenge.md). La parte difícil no son los endpoints: es que el dinero cierre aunque lleguen órdenes en paralelo. Las decisiones, con su alternativa descartada, están en [DECISIONS.md](DECISIONS.md).

## Lo que devuelve el seed (usuario 1)

| | ARS | De dónde sale |
|---|---|---|
| Cash | 753.000,00 | 1.000.000 ingresados − 100.000 retirados − compras + ventas (órdenes FILLED) |
| Reservado | 125.500,00 | LIMIT BUY NEW: LOMA 50 × 710 + BMA 60 × 1.500 |
| **Disponible para operar** | **627.500,00** | cash − reservado |
| **Valor total** | **889.756,00** | cash + PAMP 37.034 + METR 114.750 + BMA −15.028 |

Dos anomalías del seed que la API muestra tal cual: BMA queda en **−10** acciones (la orden 11 vende 30 con 20 en cartera), y **PGR e IRCP no tienen precio**, así que una MARKET sobre ellos es REJECTED (`NO_MARKET_PRICE`). Estos números son el primer test (`test/portfolio.e2e-spec.ts`).

## Correr

Con Docker:

```bash
docker compose up --build     # Postgres con el seed + API en http://localhost:3000
```

Después, los ejemplos de [requests.http](requests.http) (VS Code REST Client o JetBrains).

Contra otra base (por ejemplo la provista, con SSL):

```bash
npm ci
DATABASE_URL='postgres://usuario:clave@host/base?sslmode=verify-full' npm run start:dev
```

- `verify-full` verifica el certificado de Neon. Los tests usan `no-verify` porque su Postgres tiene uno autofirmado.
- No lo corrí contra Neon: la prueba de SSL es local.
- La app no crea ni migra nada en esa base.
- Idempotencia y auditoría necesitan `psql "$DATABASE_URL" -f db/local-additions.sql`; sin eso, `Idempotency-Key` recibe 501 (D-10). En producción el script va aplicado.

## Verificar

```bash
npm run verify   # typecheck + unit + e2e (Postgres real vía Testcontainers)
```

Necesita Docker y Node 22.13+; tarda ~1 min con la imagen de Postgres ya descargada. Los e2e levantan un Postgres con SSL, clonan una base nueva por test o por archivo y se niegan a correr contra un host que no sea local. CI corre lo mismo (`.github/workflows/ci.yml`).

## Endpoints

| Método y ruta | Qué hace |
|---|---|
| `GET /users/:userId/portfolio` | Valor total, cash (saldo, reservado, disponible) y posiciones con cantidad (total, reservada, disponible), valor, rendimiento total y diario. `unpricedInstrumentIds` lista las posiciones que el total no pudo valuar |
| `GET /instruments?q=gal` | Busca parcial por ticker o nombre; ticker exacto primero; ARS no aparece |
| `POST /users/:userId/orders` | Envía una orden. Header opcional `Idempotency-Key` |
| `POST /users/:userId/orders/:orderId/cancel` | Cancela una orden NEW |

Orden: `{ "instrumentId": 34, "side": "BUY", "type": "MARKET", "size": 10 }`. En lugar de `size` se puede mandar `amount` (ARS): la API compra (o vende) la mayor cantidad de acciones enteras que alcanza. `LIMIT` necesita `price`; `MARKET` toma el último `close`. El dinero viaja como string decimal, igual que en las respuestas: `"price": "900.00"`, `"amount": "10000"`.

## Qué responde cada caso

| Caso | HTTP | Se guarda |
|---|---|---|
| MARKET con fondos o acciones | 201 `FILLED` | sí |
| LIMIT con fondos o acciones (reserva cash o acciones) | 201 `NEW` | sí |
| Más que el disponible (reservas incluidas), vender BMA, o MARKET sin precio | 201 `REJECTED` + `reason` | sí |
| Body inválido, `CASH_IN`/`CASH_OUT`, comprar ARS, monto menor a una acción, mayor al tamaño máximo o sin precio para calcularlo | 400 | no |
| Usuario, instrumento u orden inexistente (u orden de otro usuario) | 404 | no |
| Cancelar una orden que no está NEW | 409 | no |
| Misma `Idempotency-Key` con otro body | 422 | no |
| `Idempotency-Key` en una base sin la tabla de idempotencia | 501 | no |
| Lock ocupado más de 3 s, sentencia de más de 5 s, transacción inactiva más de 2 s, pool sin conexiones o base que rechaza la conexión | 503 + `Retry-After` | no |
| Error inesperado (conexión perdida a mitad de una transacción, bug) | 500 | desconocido: reintentar sólo con la misma `Idempotency-Key` (con `db/local-additions.sql` aplicado) |

Los errores siguen RFC 9457 (`application/problem+json`) con un `code` estable. Cada fila tiene su test por HTTP, salvo la base que rechaza la conexión:

- 500 y 503: `test/failures.e2e-spec.ts` y `test/concurrency.e2e-spec.ts`.
- Base que rechaza la conexión: test unitario (`src/problem.spec.ts`).
- Conexión perdida durante el COMMIT: `test/idempotency.e2e-spec.ts`. Responde 500, y el reintento con la misma clave recibe esa orden.
- Con `db/local-additions.sql` aplicado, cada cambio de estado queda en `order_events`, y un REJECTED con su motivo (D-07). Sin él, el motivo queda sólo en la respuesta y el log.

## Revisar en 15 minutos

1. `src/orders/orders.ts` `place()`: leer instrumento → lock → leer precio y disponible → decidir → insertar, en una transacción. El motivo de un REJECTED llega a `order_events` por `set_config('app.order_reason')`, que lee el trigger de `db/local-additions.sql`.
2. `src/ledger.ts` `lockUser`: el lock por usuario. `src/db.ts`: los límites de tiempo de toda transacción.
3. `src/orders/decide.ts` y `src/portfolio/positions.ts`: las reglas de negocio, puras, con tests unitarios.
4. `test/concurrency.e2e-spec.ts`: la carrera, probada; `test/harness.ts` `assertInvariants` revisa cada base de test antes de cerrarla: nadie gastó más cash ni vendió más acciones de las que tenía.

## Si esto crece

El camino está en cada "A escala" de [DECISIONS.md](DECISIONS.md). Lo primero que se agota es el pool (D-04): el primer paso es un límite por usuario en el API Gateway.
