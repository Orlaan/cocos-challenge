# Cocos Challenge: portfolio, búsqueda y órdenes

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
DATABASE_URL='postgres://usuario:clave@host/base?sslmode=require' npm run start:dev
```

La app no crea ni migra nada en esa base. Sin la tabla local de idempotencia, ignora el header `Idempotency-Key` y lo avisa en el log.

## Verificar

```bash
npm run verify   # typecheck + unit + e2e (Postgres real vía Testcontainers) + chequeos de diseño
```

Necesita Docker y Node 22.13+. Los e2e levantan un Postgres con SSL, clonan una base nueva por archivo de test y se niegan a correr contra un host que no sea local. CI corre lo mismo (`.github/workflows/ci.yml`).

## Endpoints

| Método y ruta | Qué hace |
|---|---|
| `GET /users/:userId/portfolio` | Valor total, cash (saldo, reservado, disponible) y posiciones con cantidad, valor, rendimiento total y diario |
| `GET /instruments?q=gal` | Busca parcial por ticker o nombre; ticker exacto primero; ARS no aparece |
| `POST /users/:userId/orders` | Envía una orden. Header opcional `Idempotency-Key` |
| `POST /users/:userId/orders/:orderId/cancel` | Cancela una orden NEW |

Orden: `{ "instrumentId": 34, "side": "BUY", "type": "MARKET", "size": 10 }`. En lugar de `size` se puede mandar `amount` (ARS): la API compra la mayor cantidad de acciones enteras que alcanza. `LIMIT` necesita `price`; `MARKET` toma el último `close`.

## Qué responde cada caso

| Caso | HTTP | Se guarda |
|---|---|---|
| MARKET con fondos o acciones | 201 `FILLED` | sí |
| LIMIT con fondos o acciones (reserva cash o acciones) | 201 `NEW` | sí |
| Más que el disponible (reservas incluidas), BMA, o MARKET sin precio | 201 `REJECTED` + `reason` | sí |
| Body inválido, `CASH_IN`/`CASH_OUT`, comprar ARS, monto menor a una acción | 400 | no |
| Usuario, instrumento u orden inexistente (u orden de otro usuario) | 404 | no |
| Cancelar una orden que no está NEW | 409 | no |
| Misma `Idempotency-Key` con otro body | 422 | no |
| Otra orden del mismo usuario retiene el lock más de 3 s | 503 + `Retry-After` | no |

Los errores siguen RFC 9457 (`application/problem+json`) con un `code` estable.

## Cómo está hecho

```
src/
  db.ts            transacción + lock por usuario (SET LOCAL lock_timeout, SELECT … FOR UPDATE)
  ledger.ts        cash, reservas y acciones derivadas de la tabla orders
  orders/          decide.ts: la decisión de negocio, pura · orders.ts: lock → leer → decidir → insertar
  portfolio/       positions.ts: costo promedio ponderado, puro · portfolio.ts: endpoint
  instruments/     búsqueda
  problem.ts       errores RFC 9457
test/              e2e sobre Postgres real, uno por regla
db/                database.sql (sin cambios) · local-additions.sql · optional-hardening.sql
```

- **Nada se guarda dos veces.** Cash y posiciones salen de las órdenes en cada lectura (D-02).
- **Las órdenes del mismo usuario se serializan** en Postgres, así que funciona con varias instancias. Probado: 5 compras paralelas con cash para 4 → 4 FILLED, 1 REJECTED. Sin el lock, el mismo test sobregira (D-04).
- **Dinero exacto:** `NUMERIC` + `decimal.js`; la API devuelve strings (D-06).
- **El núcleo es puro:** `decide.ts` y `positions.ts` no conocen HTTP ni SQL y tienen tests unitarios propios.

## Si esto crece

1. Más tráfico: PgBouncer en modo transacción (por eso `SET LOCAL`) e instancias horizontales; el lock sigue en la base.
2. Muchas órdenes: índices de `optional-hardening.sql`, después una tabla `positions` actualizada en la misma transacción y reconciliada contra `orders`.
3. Lecturas: réplicas para búsqueda y market data; las validaciones de dinero siempre en el primario.
4. Market data: cache con límite de antigüedad; los saldos nunca se cachean.
5. Mercado real: outbox + consumidores idempotentes para enviar órdenes y recibir ejecuciones.
6. Muchos usuarios: shard por usuario; el lock por usuario ya encaja.

## Supuestos

Ver [DECISIONS.md](DECISIONS.md): rendimiento por costo promedio ponderado, reservas de órdenes NEW, BMA −10 y PGR/IRCP sin precio. Varios coinciden con respuestas de Cocos a otros candidatos; no son reglas oficiales.
