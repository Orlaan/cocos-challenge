# Decisiones

Cada decisión: qué elegí, por qué (con un dato), la alternativa que descarté y qué cambia a escala.
Los códigos HTTP de cada caso están en la tabla del README.

## D-01 Stack: NestJS 11 + TypeORM sólo como conexión + SQL explícito
NestJS (lo nombra el enunciado) da módulos, inyección de dependencias y validación. TypeORM sólo aporta el `DataSource` y las transacciones: no hay entidades ni repositorios, porque el esquema es fijo y las consultas de dinero son agregados que se leen mejor en SQL. Todo SQL usa parámetros (`$1`), nunca concatenación.
**Alternativa descartada:** Prisma o entidades TypeORM: agregan un modelo que no aporta nada sobre un esquema dado y esconden el SQL que hay que defender.
**A escala:** igual. El núcleo (`decide.ts`, `positions.ts`) no importa nada de Nest ni de TypeORM, así que cambiar el framework no toca la lógica.

## D-02 El estado se deriva del log `orders`, no se guarda
El enunciado pide calcular tenencia y pesos "utilizando todos los movimientos pertinentes que hay en la tabla `orders`". Cash = Σ CASH_IN + SELL − CASH_OUT − BUY de las órdenes FILLED (`size × price`). Las posiciones salen de plegar las FILLED en orden de `datetime, id` (`src/ledger.ts`). Cada orden nueva guarda `clock_timestamp()` tomado después del lock, así el orden temporal es el orden real de ejecución. No hay una segunda copia que pueda desincronizarse.
**Alternativa descartada:** una tabla `balances`/`positions`. Hoy sería estado duplicado sin necesidad: con 11 órdenes por usuario la suma cuesta microsegundos.
**A escala:** tabla `positions` actualizada en la misma transacción que la orden, más una reconciliación nocturna contra `orders` (el log sigue siendo la fuente de verdad).

## D-03 Las órdenes NEW reservan cash o acciones
Una LIMIT BUY NEW retiene `size × price`; una LIMIT SELL NEW retiene `size` acciones. Disponible = saldo − reservas, para el cash y para cada posición (`reservedQuantity`, `availableQuantity`). Sin esto, el usuario 1 podría gastar dos veces los 125.500 que ya comprometió (órdenes 5 y 7 del seed). Cancelar libera la reserva.
**Alternativa descartada:** validar sólo contra el saldo FILLED. Permite sobregirar con órdenes abiertas.
**A escala:** al ejecutarse una LIMIT, liquidar al precio de ejecución y devolver la diferencia de la reserva.

## D-04 Concurrencia: un lock por usuario
Leer disponible → decidir → insertar es un check-then-act. Dos compras paralelas de 400.000 con 627.500 disponibles verían ambas 627.500 y dejarían el saldo en −172.500. Cada orden corre en una transacción READ COMMITTED que primero hace `SET LOCAL lock_timeout = '3s'` y después `SELECT id FROM users WHERE id = $1 FOR UPDATE` (`src/db.ts`). Las órdenes del mismo usuario se serializan; las de usuarios distintos no se bloquean. La misma consulta da el 404 si el usuario no existe. Si el lock tarda más de 3 s → 503 + `Retry-After` (SQLSTATE `55P03`). Toda transacción (órdenes, cancelaciones y lecturas) tiene los mismos límites: 3 s esperando un lock, 5 s por sentencia (`statement_timeout`), y 3 s para conseguir una conexión del pool. Pasado cualquiera: 503, nada guardado, una línea `busy` en el log. Nunca una request colgada.
**Evidencia:** `test/concurrency.e2e-spec.ts` retiene el lock desde afuera, encola 5 compras con cash para 4 y lo suelta: 4 FILLED, 1 REJECTED. Lo mismo con 5 ventas y acciones para 4. Para verlo fallar: borrar `FOR UPDATE` en `src/db.ts` y correr `npx jest test/concurrency`: los dos tests fallan con 5 FILLED. Otros tests comprueban la espera, el 503, y que una cancelación no espera el lock y libera cash para la orden que sí espera.
**Alternativa descartada:** SERIALIZABLE (necesita un loop de reintentos y aborta transacciones sanas), advisory locks (otro espacio de claves que mantener), mutex en memoria (falla con 2 instancias de la API).
**A escala:** el lock vive en Postgres, así que funciona con N instancias. Con PgBouncer en modo transacción, `SET LOCAL` no se filtra a otra sesión. Un usuario con muchas órdenes en espera ocupa conexiones del pool hasta 3 s cada una: el próximo paso es limitar órdenes en vuelo por usuario. El id de usuario es también la clave natural para shardear.

## D-05 Rendimiento: costo promedio ponderado
Rendimiento total = valor de mercado / costo de las acciones en cartera − 1. Una compra re-promedia el costo; una venta saca acciones al costo promedio. Si una posición queda en 0 o negativa, la próxima compra reinicia el costo. Rendimiento diario = `close / previousClose − 1` (lo pide el enunciado). Seed: PAMP −0,45 % total, +0,44 % diario.
**Alternativa descartada:** FIFO. Da otro número con las mismas órdenes y necesita guardar lotes; no encontré una definición pública de "rendimiento total" de Cocos, así que elegí la más simple de explicar.
**A escala:** P&L realizado por venta, si negocio lo pide.

## D-06 Dinero exacto
Postgres guarda `NUMERIC(10,2)`; `pg` lo devuelve como string; todo cálculo usa `decimal.js`. El dinero viaja como string decimal en los dos sentidos: `"price": "900.00"`, `"amount": "10000"`. Un `price` numérico de JSON → 400. Los límites salen del esquema (`src/limits.ts`): precio menor a 100.000.000, `size` dentro de un INT.
**Alternativa descartada:** `number` de JavaScript (0,1 + 0,2 ≠ 0,3; un test lo cubre) o centavos enteros (otra conversión en cada borde).

## D-07 Un rechazo de negocio es una orden guardada
"La orden tiene que ser rechazada y guardarse en estado REJECTED". Responde 201 con `status: REJECTED` y un `reason` (`INSUFFICIENT_FUNDS`, `INSUFFICIENT_SHARES`, `NO_MARKET_PRICE`). Una request mal formada no es una orden: 400 y no se guarda nada.
**Alternativa descartada:** 4xx para fondos insuficientes. Pierde el registro de auditoría que un broker necesita.
**A escala:** guardar el `reason` en una columna (hoy no existe y no toco el esquema provisto; viaja en la respuesta y en el log).

## D-08 Orden por monto
`size = floor(amount / precio)`, con el último `close` para MARKET y el precio límite para LIMIT. Si da 0 acciones → 400 `AMOUNT_BELOW_ONE_SHARE`: la request nunca podría ejecutarse. Sólo se debita o reserva `size × precio`, no el monto entero.
**Alternativa descartada:** guardarla como REJECTED. No hay una orden posible que rechazar.

## D-09 Cancelación atómica
`UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW'`: la condición y el cambio son un solo paso, sin carrera entre leer y escribir. Si no actualiza nada: 404 si la orden no es de ese usuario (no revela que existe), 409 si ya no está NEW (también un segundo cancel).
**Alternativa descartada:** 200 idempotente en el segundo cancel. Es defendible, pero 409 dice la verdad: esa orden ya no se puede cancelar.
Cada cancelación deja una línea `cancel` en el log, porque la fila pierde su estado anterior.
**A escala:** una tabla append-only `order_events` para no perder el estado anterior (trazabilidad que exige CNV).

## D-10 El esquema provisto no se toca
La app corre sobre la base provista tal cual (`test/provided-db.e2e-spec.ts` lo prueba con sólo `database.sql` y SSL, como Neon). Lo único agregado es `db/local-additions.sql` (tabla de idempotencia), que crean `docker compose` y los tests, nunca la base provista. Índices propuestos en `db/optional-hardening.sql`, cada uno con la consulta que acelera; con 11 órdenes Postgres igual elige un seq scan.
**Alternativa descartada:** migrar la base provista. El enunciado lo permite, pero cada cambio exige justificarlo y hoy ninguno es necesario para que funcione.
**A escala:** aplicar `optional-hardening.sql` con una migración versionada.

## D-11 Anomalías del seed: se muestran, no se corrigen
- El usuario 1 tiene BMA −10 (la orden 11 vende 30 con 20 en cartera). Se muestra con su valor negativo, sin rendimiento total, y toda venta nueva de BMA es REJECTED.
- PGR (id 3) e IRCP (id 10) no tienen `marketdata`: MARKET → 201 REJECTED `NO_MARKET_PRICE`; LIMIT se acepta (el precio límite alcanza). Si esa MARKET vino por `amount`, no hay `size` posible: la fila REJECTED queda con `size` y `price` en null. Un `close` en 0 cuenta como sin precio.
- Una posición sin precio muestra su cantidad con valor null y no suma al valor total. Con el seed no pasa: ninguna orden FILLED usa PGR o IRCP.
- Los precios son de 2023-07-14. No valido antigüedad.
**Alternativa descartada:** corregir el seed. Los datos son un registro: no se reescribe historia.
**A escala:** rechazar MARKET si el último `close` tiene más de N minutos.

## D-12 Búsqueda
Un parámetro `q` (1 a 50 caracteres) busca parcial en ticker o nombre, sin distinguir mayúsculas (`ILIKE`, con `%` y `_` escapados), excluye ARS (MONEDA), ticker exacto primero, máximo 20.
**Alternativa descartada:** insensible a acentos con `unaccent`: es una extensión, o sea DDL sobre la base provista.
**A escala:** índice `pg_trgm` GIN (en `optional-hardening.sql`) y cache de instrumentos (cambian poco; los saldos no se cachean nunca).

## D-13 Idempotencia
Un reintento de red no puede crear dos órdenes. Con el header `Idempotency-Key`, la clave se busca y se guarda dentro del mismo lock y la misma transacción que la orden: 5 reintentos paralelos crean 1 orden y los otros 4 reciben la misma respuesta (`Idempotent-Replayed: true`), incluido el `reason` de un REJECTED. Misma clave con otro body → 422. Sin header, cada request es nueva. Un 400 no guarda la clave.
La tabla es el único agregado al esquema (`db/local-additions.sql`). En la base provista no existe: una request con el header recibe 501 `IDEMPOTENCY_UNAVAILABLE` y no se guarda nada. Aceptar el header sin cumplirlo sería prometer reintentos seguros que no lo son. Quien opere esa base decide si la crea: `psql "$DATABASE_URL" -f db/local-additions.sql`. La API lo detecta sin reiniciar.
**Alternativa descartada:** Redis. Otro sistema que puede quedar desincronizado con la orden; en Postgres la clave y la orden se confirman juntas. Ignorar el header en silencio: un reintento duplicaría la orden.
**A escala:** expirar claves después de 24 h.

## Estabilidad y seguridad
Una transacción por orden; lock por usuario con timeout; el test de carrera demuestra que no hay sobregiro; los REJECTED quedan como auditoría; ningún error interno filtra detalles (500 con `INTERNAL_ERROR`). Un 500 puede tener resultado desconocido (conexión cortada en el COMMIT): por eso el único reintento seguro de una orden es con la misma `Idempotency-Key`; los tests se niegan a correr contra una base que no sea local. Bajo carga, lo primero que se agota es el pool de conexiones: PgBouncer antes que más instancias.

## Lo que no construí, y por qué
- Endpoints de CASH_IN / CASH_OUT: el enunciado pide tres endpoints; las transferencias del seed se leen igual. `side: CASH_IN` en `/orders` → 400.
- Ejecución de órdenes LIMIT: "NO hace falta simular el mercado".
- Autenticación: fuera de alcance según el enunciado.
- Vencimiento diario de LIMIT, kill switch por instrumento, paginación, métricas: próximos pasos. Los dos primeros entran en `decide.ts` y `orders.ts` sin tocar el resto.

## Cómo usé IA
Escribí la solución con agentes de IA y verifiqué cada parte con tests sobre Postgres real. Correcciones concretas: el orden de `SET LOCAL lock_timeout` (antes del `FOR UPDATE`; al revés el timeout nunca se aplica); NestJS 11 y no 12, porque la 12 sólo publica ES modules y Jest no los carga en Node 22 (lo probé); Testcontainers 11.x porque la 12 exige Node 22.19. El test de carrera lo validé sacando el lock a mano.
