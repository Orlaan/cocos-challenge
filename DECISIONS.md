# Decisiones

Una API de broker en NestJS + PostgreSQL. Las tres decisiones clave son D-02, D-03 y D-04. Los ejemplos son del usuario 1 del seed; los códigos HTTP están en el [README](README.md).

## D-01 NestJS para la API; SQL a mano para la base

El enunciado deja elegir "Express o NestJS". NestJS trae validación de DTOs (`ValidationPipe`), un solo filtro de errores (`ProblemFilter`) e inyección de dependencias: los tests cambian el `DataSource` sin tocar código ([`test/harness.ts`](test/harness.ts)).

Cada `*.repository.ts` tiene SQL explícito con parámetros y recibe la transacción: las cuentas de plata son sumas que se leen mejor en SQL. TypeORM sólo da el pool y `transaction()` ([`src/database/db.ts`](src/database/db.ts)).

**Descarté** Prisma y las entidades de TypeORM (esconden el SQL) y `@nestjs/typeorm` (sus reintentos esconden una URL mala ~27 s). **En producción**, cuando aparezca CRUD (altas y lecturas simples), entidades TypeORM para eso y SQL para lo crítico; cada repository decide por su cuenta, sin tocar los servicios.

## D-02 Cash y posiciones se calculan desde `orders`

Lo pide el enunciado: "utilizar todos los movimientos pertinentes que hay en la tabla `orders`". Cash = CASH_IN − CASH_OUT + SELL − BUY de las FILLED ([`src/ledger.repository.ts`](src/ledger.repository.ts)); las posiciones recorren las FILLED en orden de `id` (`foldPositions`). Usuario 1: 753.000. `datetime` no tiene zona: uso UTC.

**Descarté** una tabla `positions`: estado duplicado para 11 órdenes. **En producción**, con miles de órdenes por usuario, esa tabla escrita en la misma transacción que la orden.

## D-03 Una LIMIT pendiente aparta su plata o sus acciones

Sin reservas, varias LIMIT pendientes gastan la misma plata. Mientras una LIMIT está en NEW, aparta:

| Orden | Reserva |
|---|---|
| LIMIT BUY | `size × price` pesos |
| LIMIT SELL | `size` acciones |

**Disponible = saldo − reservas.** Cancelar libera la reserva. Una LIMIT queda NEW hasta que se cancela: no simulo el mercado.

Usuario 1 del seed:

| | Pesos |
|---|---|
| Saldo | 753.000 |
| Orden 5: 50 LOMA a 710 | −35.500 |
| Orden 7: 60 BMA a 1.500 | −90.000 |
| **Disponible** | **627.500** |

## D-04 Un lock por usuario

Leer el disponible, decidir e insertar son pasos separados: dos órdenes simultáneas leen el mismo disponible y lo gastan dos veces. Cada orden toma antes `SELECT … FROM users WHERE id = $1 FOR NO KEY UPDATE` (`lockUser`): las de un usuario corren de a una y las de otros no esperan este lock. En [`test/concurrency.e2e-spec.ts`](test/concurrency.e2e-spec.ts), 5 compras con saldo para 4: sin lock, 5 FILLED y −121.001,00; con lock, 4 FILLED y 1 REJECTED.

Cada espera tiene un tope; pasado el tope, 503 y nada guardado:

| Espera… | Tope | Quién corta |
|---|---|---|
| una de las 10 conexiones del pool | 3 s | la app (`connectionTimeoutMillis`) |
| el lock | 3 s | Postgres (`lock_timeout`) |
| una consulta | 5 s | Postgres (`statement_timeout`) |
| una transacción inactiva | 2 s | Postgres (`idle_in_transaction_session_timeout`) |

Si Postgres no contesta, la request espera: un `query_timeout` en el cliente no garantiza "nada guardado" si corta en el `COMMIT`.

**Descarté** SERIALIZABLE (obliga a reintentar) y advisory locks (otro espacio de claves). **En producción**, el lock ya sirve con N instancias (pods en EKS contra RDS PostgreSQL) y PgBouncer. El riesgo es un burst: un usuario manda muchas órdenes en pocos milisegundos, por ejemplo un bot o un script que reintenta. El lock las pone en fila, pero cada una espera con una conexión tomada; con 10 conexiones el pool se llena y los demás usuarios reciben 503. Por eso sumaría un límite por usuario en la app, que responda 429 antes de tomar una conexión.

## D-05 Rendimiento contra el costo promedio

Total = valor de mercado / costo − 1; una venta saca acciones al costo promedio. Diario = `close / previousClose − 1`. PAMP del usuario 1: −0,45 %.

**Descarté** FIFO: necesita lotes de compra y Cocos no define cuál usa.

## D-06 La plata nunca pasa por un float

En JavaScript, 169 × 885,80 da `149700.19999999998`. Calculo con `decimal.js` a 40 dígitos ([`src/money.ts`](src/money.ts)) y la plata viaja como string (`"885.80"`). Un número JSON da 400: `JSON.parse` ya lo convirtió en float. Los topes salen del esquema ([`src/limits.ts`](src/limits.ts)).

## D-07 Un rechazo de negocio es una orden guardada

"Tiene que ser rechazada y guardarse en estado REJECTED": 201 con `status: REJECTED` y un `reason`. Una request mal formada es 400 y no guarda nada. El `reason` va en la respuesta y el log: `orders` no tiene esa columna y no cambio el esquema (D-10).

**En producción**, la columna `orders.reason`, agregada con una migración.

## D-08 Orden por monto

`size = floor(amount / precio)`, y reservo `size × precio`: 150.000 en GGAL son 169 acciones. Menos de una acción → REJECTED `AMOUNT_BELOW_ONE_SHARE`; MARKET por monto sin precio → REJECTED `NO_MARKET_PRICE`. Las dos quedan con `size` 0. Más acciones que un INT → 400 `AMOUNT_TOO_LARGE`.

## D-09 Cancelar es un solo `UPDATE`

`UPDATE … SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW'`: chequeo y cambio atómicos, sin lock. Orden ajena → 404; orden que no está NEW → 409.

## D-10 No toco el esquema provisto

La app corre sobre `database.sql` tal cual ([`test/provided-db.e2e-spec.ts`](test/provided-db.e2e-spec.ts)). Lo extra va en [`db/local-additions.sql`](db/local-additions.sql): `idempotency_keys` y `order_events`, donde un trigger guarda cada estado de cada orden. Sin ese archivo la app anda, y `Idempotency-Key` da 501.

**Descarté** que la app migre sola una base ajena. **En producción**, migraciones versionadas e índices como `orders (userid, status)`; con 11 órdenes hoy no hacen falta.

## D-11 Los datos raros del seed se muestran

BMA queda en −10 (la orden 11 vende 30 teniendo 20): resta del total, y una venta de BMA es REJECTED. PGR e IRCP no tienen precio: una MARKET es REJECTED `NO_MARKET_PRICE`. No corrijo un registro de lo que pasó.

## D-12 Búsqueda

`q` de 1 a 50 caracteres, parcial en ticker o nombre (`ILIKE`, con `\`, `%` y `_` escapados), ticker exacto primero, máximo 20, sin ARS.

**En producción**, índices `pg_trgm`; con 66 instrumentos hoy no hacen falta.

## D-13 Reintentar no duplica

Con la misma `Idempotency-Key`, el reintento recibe la primera respuesta (`Idempotent-Replayed: true`). La clave se guarda bajo el lock y en la misma transacción que la orden: 5 reintentos en paralelo crean 1 orden. Misma clave con otro body → 422. Es opcional porque el enunciado define el endpoint sin ella.

**Descarté** Redis: se puede desincronizar de la orden.

## D-14 Transferencias: se cuentan, no se crean

El cash suma CASH_IN y CASH_OUT, pero el endpoint sólo acepta BUY y SELL: crear transferencias pide autenticación y su propia validación.

**En producción**, endpoints de depósito y retiro autenticados, con el mismo lock por usuario.
