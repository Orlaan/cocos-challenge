# Decisiones

Cada una: qué elegí y por qué, lo que descarté y qué cambia a escala. Los códigos HTTP están en el README.

## D-01 NestJS + SQL explícito; TypeORM sólo como conexión
Sin entidades ni repositorios: el esquema es fijo y las cuentas de dinero son agregados que se leen mejor en SQL. Todo SQL va con parámetros.
**Descarté** Prisma o entidades TypeORM (un modelo que esconde el SQL a defender) y `pg.Pool` directo (TypeORM es el stack de Cocos). Tampoco `@nestjs/typeorm`: sin entidades no aporta repositorios, y sus reintentos por defecto esconden una URL mala ~27 s; `DatabaseModule` da el mismo `DataSource` global. Ni `@nestjs/config`: son dos variables.

## D-02 Cash y posiciones se derivan de `orders`
Lo pide el enunciado. Cash = CASH_IN − CASH_OUT (`size`) + SELL − BUY (`size × price`) de las FILLED (`cash` en `src/ledger.repository.ts`). Las posiciones pliegan las FILLED en orden de `id`, que bajo el lock es el de ejecución (`foldPositions`). `datetime` no tiene zona: leo y escribo UTC.
**Descarté** una tabla `positions`: estado duplicado para 11 órdenes. **A escala:** esa tabla, escrita en la misma transacción, con reconciliación nocturna contra `orders`.

## D-03 Una orden NEW reserva
Una LIMIT BUY NEW retiene `size × price`; una LIMIT SELL NEW, `size` acciones. Disponible = saldo − reservas. Sin esto el usuario 1 gastaría dos veces los 125.500 de las órdenes 5 y 7. Cancelar libera.
**A escala:** ejecutar una LIMIT es pasarla a FILLED; una NEW vencida al cierre pasa a CANCELLED.

## D-04 Concurrencia: un lock por usuario
Leer disponible → decidir → insertar es un check-then-act. Cada orden toma `SELECT … FROM users WHERE id = $1 FOR NO KEY UPDATE` antes de leer precio y disponible (`lockUser`): serializa las órdenes de un usuario y no frena los chequeos de foreign key. Cancelar no lo toma: sólo libera (D-09).
- **Prueba:** `test/concurrency.e2e-spec.ts` retiene la fila, encola 5 órdenes con saldo para 4 y la suelta: 4 pasan, 1 es REJECTED. Sin el lock falla.
- **Límites:** 3 s de lock, 5 s por sentencia, 2 s de transacción inactiva, 3 s por una de las 10 conexiones. Pasado cualquiera: 503, nada guardado.
- **Costo:** 5 a 7 idas y vueltas bajo el lock. Una ráfaga de un usuario recibe 503 y ocupa conexiones de otros: el límite por usuario va en el API Gateway.
- **Descarté** SERIALIZABLE (reintentos), advisory locks (otro espacio de claves), mutex en memoria (falla con 2 instancias).
- **A escala:** el lock vive en Postgres, así que sirve con N instancias y con PgBouncer en modo transacción (`SET LOCAL`).

## D-05 Rendimiento: costo promedio ponderado
Total = valor de mercado / costo de las acciones en cartera − 1; una venta saca acciones al costo promedio. Diario = `close / previousClose − 1`. **Descarté** FIFO: necesita lotes y no hay una definición pública de Cocos.

## D-06 Dinero exacto
`NUMERIC` llega como string y se calcula con `decimal.js` a 40 dígitos (`src/money.ts`). El dinero viaja como string decimal (`"price": "900.00"`); un número JSON → 400. Los límites salen del esquema (`src/limits.ts` y los patrones de `src/orders/order.dto.ts`).

## D-07 Un rechazo de negocio es una orden guardada
"Tiene que ser rechazada y guardarse en estado REJECTED": 201 con `status: REJECTED` y un `reason`. Una request mal formada es 400 y no guarda nada. El `reason` va en la respuesta y el log: `orders` no tiene columna para él.
**A escala:** el `reason` como columna de `order_events` (D-10).

## D-08 Orden por monto
`size = floor(amount / precio)`. Menos de una acción → 400 `AMOUNT_BELOW_ONE_SHARE`; más de un INT → 400 `AMOUNT_TOO_LARGE`; MARKET sin precio → 400 `AMOUNT_NEEDS_A_PRICE`. Se reserva `size × precio`, no el monto.

## D-09 Cancelación atómica
`UPDATE … SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW'`: chequeo y cambio en un paso. Sin el lock, una orden en paralelo a lo sumo ve menos disponible del que hay. Orden ajena → 404; no NEW → 409. `order_events` guarda NEW y después CANCELLED.

## D-10 El esquema provisto no cambia
- La app corre sobre `database.sql` tal cual: `test/provided-db.e2e-spec.ts` lo prueba en una copia local con SSL. No lo corrí contra Neon.
- `db/local-additions.sql` (lo aplican `docker compose` y los tests) agrega `idempotency_keys` y `order_events`, con un trigger que registra cada estado de cada orden, también los cambios hechos a mano por SQL. Mientras corre bloquea las escrituras de `orders`. Se puede repetir.
- Sin él: `Idempotency-Key` → 501 y no hay `order_events`. **Descarté** que la app migre sola: cambiaría una base ajena.
- **A escala:** migraciones versionadas, un rol que no edita ni borra historia, índices `orders (userid, status)` y `marketdata (instrumentid, date DESC)`.

## D-11 Anomalías del seed: se muestran
BMA queda en −10 acciones (la orden 11 vende 30 con 20): su valor negativo resta del total y una venta de BMA es REJECTED mientras la posición no sea positiva. PGR e IRCP no tienen precio: MARKET → REJECTED `NO_MARKET_PRICE`, y `unpricedInstrumentIds` dice qué quedó fuera del total. No corrijo datos de un registro.

## D-12 Búsqueda
`q` de 1 a 50 caracteres, parcial en ticker o nombre (`ILIKE` con `%` y `_` escapados), sin ARS, ticker exacto primero, máximo 20. **A escala:** índices `pg_trgm` y cache de instrumentos.

## D-13 Idempotencia
Con `Idempotency-Key`, la clave se busca y se guarda bajo el mismo lock y en la misma transacción que la orden: 5 reintentos paralelos crean 1 orden y los otros reciben la misma respuesta (`Idempotent-Replayed: true`). Misma clave con otro body → 422 (`"10000"` y `"10000.00"` son el mismo). La clave es opcional porque el enunciado define el endpoint sin ella; sin clave, cada request es nueva.
**Descarté** Redis (puede desincronizarse de la orden) e ignorar el header donde no hay tabla (prometería un reintento seguro). **A escala:** borrar claves de más de 24 h por `created_at`.

## Cómo usé IA
Escribí la solución con agentes de IA y verifiqué cada garantía rompiendo el código: sin el lock, sin `NULLS LAST` o con un `statement_timeout` mayor, su test falla.
