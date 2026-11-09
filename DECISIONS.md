# Decisiones

Cada decisión: qué elegí, por qué (con un dato), la alternativa que descarté y qué cambia a escala.
Los códigos HTTP de cada caso están en la tabla del README.

## D-01 Stack: NestJS 11 + TypeORM sólo como conexión + SQL explícito
NestJS (lo nombra el enunciado) da módulos, inyección de dependencias y validación. TypeORM sólo aporta el `DataSource` y las transacciones: no hay entidades ni repositorios, porque el esquema es fijo y las consultas de dinero son agregados que se leen mejor en SQL. Todo SQL usa parámetros (`$1`), nunca concatenación.
**Alternativa descartada:** Prisma o entidades TypeORM: agregan un modelo que no aporta nada sobre un esquema dado y esconden el SQL que hay que defender. `pg.Pool` directo: ahorraría una dependencia, pero TypeORM es el stack de Cocos y su `DataSource` es lo que un revisor del equipo ya conoce.
**A escala:** igual. El núcleo (`decide.ts`, `positions.ts`) no importa nada de Nest ni de TypeORM, así que cambiar el framework no toca la lógica.

## D-02 El estado se deriva del log `orders`, no se guarda
El enunciado pide calcular tenencia y pesos "utilizando todos los movimientos pertinentes que hay en la tabla `orders`". Cash = Σ CASH_IN + SELL − CASH_OUT − BUY de las órdenes FILLED (`size × price`). Las posiciones salen de plegar las FILLED en orden de `id` (`src/ledger.ts`): bajo el lock, el orden de inserción es el de ejecución, y en el seed los ids ya siguen a `datetime`. Esta API nunca llena una LIMIT; si algo la llenara después, el orden de ejecución sería el del evento FILLED en `order_events`. Cada orden nueva guarda `clock_timestamp()` tomado después del lock. `datetime` no tiene zona horaria: leo el seed como UTC y escribo en UTC. No hay una segunda copia que pueda desincronizarse.
**Alternativa descartada:** una tabla `balances`/`positions`. Hoy sería estado duplicado sin necesidad: con 11 órdenes por usuario la suma cuesta microsegundos.
**A escala:** tabla `positions` actualizada en la misma transacción que la orden, más una reconciliación nocturna contra `orders` (el log sigue siendo la fuente de verdad).

## D-03 Las órdenes NEW reservan cash o acciones
Una LIMIT BUY NEW retiene `size × price`; una LIMIT SELL NEW retiene `size` acciones. Disponible = saldo − reservas, para el cash y para cada posición (`reservedQuantity`, `availableQuantity`). Sin esto, el usuario 1 podría gastar dos veces los 125.500 que ya comprometió (órdenes 5 y 7 del seed). Cancelar libera la reserva.
**Alternativa descartada:** validar sólo contra el saldo FILLED. Permite sobregirar con órdenes abiertas.
**A escala:** ejecutar una LIMIT es pasarla de NEW a FILLED a su precio límite: la reserva pasa a ser el débito. Un precio de ejecución distinto iría a una tabla `executions` por orden, y cash y posiciones se leerían de ella.

## D-04 Concurrencia: un lock por usuario
Leer disponible → decidir → insertar es un check-then-act: dos compras paralelas de 400.000 con 627.500 disponibles verían ambas 627.500.
- **Mecanismo:** cada orden toma `SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE` (`src/ledger.ts` `lockUser`) en una transacción READ COMMITTED. Serializa las órdenes del mismo usuario; las de otros usuarios no esperan. Es el lock de fila más débil que choca consigo mismo: no frena los chequeos de foreign key hacia `users`.
- **Regla:** todo lo que pueda gastar cash o acciones toma este lock primero. Cancelar no lo toma: sólo libera (D-09). El precio se lee después del lock: una MARKET que esperó usa el último `close`.
- **Límites:** 3 s esperando el lock, 5 s por sentencia, 3 s esperando una conexión del pool (10). Pasado cualquiera: 503 + `Retry-After`, nada guardado, una línea `busy` en el log. Una transacción inactiva más de 2 s (Node trabado entre dos consultas) la corta Postgres: no retiene el lock de un usuario, y esa request recibe 503.
- **Evidencia:** `test/concurrency.e2e-spec.ts` retiene la fila desde afuera, encola 5 órdenes con saldo para 4 y la suelta: 4 FILLED o NEW, 1 REJECTED. Cubre compras, ventas y LIMIT con MARKET mezcladas. Sin el lock esos tests fallan: las 5 leen el mismo disponible.
- **Tiempo bajo el lock:** después de tomarlo, una orden hace de 5 a 8 idas y vueltas a la base (instrumento, precio, disponible, INSERT, COMMIT; más clave y motivo si los hay). Con 100 ms de latencia (una base en otra región; no lo medí contra Neon) son 0,5 a 0,8 s por orden: con `lock_timeout` de 3 s, la quinta orden simultánea del mismo usuario puede recibir 503. Juntar instrumento, precio y disponible en una sola consulta ahorraría 2 idas y vueltas, pero dejaría una segunda copia de las reglas de cash y de último precio, que hoy están una sola vez en `src/ledger.ts`; lo haría después de medir contra la base real.
- **Trade-off:** cada orden en espera ocupa una de las 10 conexiones del pool hasta 3 s, así que una ráfaga de un usuario trabado puede dar 503 a otros usuarios de la instancia, nunca un sobregiro; un solo cliente abusivo degrada a los demás hasta que exista un límite por usuario en el API Gateway.
- **Alternativa descartada:** SERIALIZABLE (loop de reintentos), advisory locks (otro espacio de claves), mutex en memoria (falla con 2 instancias), `NOWAIT` (da 503 a la segunda de dos órdenes legítimas en paralelo).
- **A escala:** el lock vive en Postgres: sirve con N instancias y con PgBouncer en modo transacción (`SET LOCAL`). El id de usuario es la clave natural para shardear.

## D-05 Rendimiento: costo promedio ponderado
Rendimiento total = valor de mercado / costo de las acciones en cartera − 1. Una compra re-promedia el costo; una venta saca acciones al costo promedio. Si una posición queda en 0 o negativa, la próxima compra reinicia el costo. Rendimiento diario = `close / previousClose − 1` (lo pide el enunciado). Seed: PAMP −0,45 % total, +0,44 % diario.
**Alternativa descartada:** FIFO. Da otro número con las mismas órdenes y necesita guardar lotes; no encontré una definición pública de "rendimiento total" de Cocos, así que elegí la más simple de explicar.
**A escala:** P&L realizado por venta, si negocio lo pide.

## D-06 Dinero exacto
Postgres guarda `NUMERIC(10,2)`; `pg` lo devuelve como string; todo cálculo usa `decimal.js` con 40 dígitos significativos (`src/money.ts`; el default de 20 podría redondear sumas grandes). El dinero viaja como string decimal en los dos sentidos: `"price": "900.00"`, `"amount": "10000"`. Un `price` numérico de JSON → 400. Los límites salen del esquema (`src/limits.ts`): precio menor a 100.000.000, `size` dentro de un INT.
**Alternativa descartada:** `number` de JavaScript (0,1 + 0,2 ≠ 0,3; un test lo cubre) o centavos enteros (otra conversión en cada borde).

## D-07 Un rechazo de negocio es una orden guardada
"La orden tiene que ser rechazada y guardarse en estado REJECTED". Responde 201 con `status: REJECTED` y un `reason` (`INSUFFICIENT_FUNDS`, `INSUFFICIENT_SHARES`, `NO_MARKET_PRICE`). Una request mal formada no es una orden: 400 y no se guarda nada.
**Alternativa descartada:** 4xx para fondos insuficientes. Pierde el registro de auditoría que un broker necesita.
El `reason` queda en la base, en `order_events` (`db/local-additions.sql`): un trigger registra cada estado de cada orden, y la API le pasa el motivo en una variable de la transacción (`app.order_reason`). Como es un trigger, también queda registrado un cambio de estado hecho a mano por SQL. Registra estados, no otras columnas: la API nunca cambia precio, tamaño ni lado de una orden guardada. En la base provista, sin el agregado, el motivo queda en la respuesta y en el log.
**A escala:** `order_events` es el registro de auditoría; se consulta por `orderid`.

## D-08 Orden por monto
`size = floor(amount / precio)`, con el último `close` para MARKET y el precio límite para LIMIT. Si da 0 acciones → 400 `AMOUNT_BELOW_ONE_SHARE`: la request nunca podría ejecutarse. Si da más de lo que entra en `orders.size` (INT) → 400 `AMOUNT_TOO_LARGE`. Sólo se debita o reserva `size × precio`, no el monto entero.
**Alternativa descartada:** guardarla como REJECTED. No hay una orden posible que rechazar.

## D-09 Cancelación atómica
`UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW'`: la condición y el cambio son un solo paso, sin carrera entre leer y escribir. No toma el lock del usuario: sólo libera, así que una orden que decide en paralelo a lo sumo ve menos disponible del que hay y rechaza de más, nunca gasta de más. Si no actualiza nada: 404 si la orden no es de ese usuario (no revela que existe), 409 si ya no está NEW (también un segundo cancel).
**Alternativa descartada:** 200 idempotente en el segundo cancel. Es defendible, pero 409 dice la verdad: esa orden ya no se puede cancelar.
La fila pierde su estado anterior, pero `order_events` guarda NEW y después CANCELLED (D-07), y el log tiene una línea `cancel`.
**A escala:** igual.

## D-10 El esquema provisto no cambia; los agregados son un paso de deploy
- **Base provista:** la app corre sobre ella tal cual. `test/provided-db.e2e-spec.ts` lo prueba sobre una copia local con sólo `database.sql` y SSL: prueba el esquema y SSL, no la conexión a Neon.
- **Agregado:** `db/local-additions.sql` crea `idempotency_keys` y `order_events` y agrega un trigger a `orders`. No cambia columnas ni filas existentes. Cada INSERT o cambio de estado en `orders` escribe una fila en `order_events`, en la misma transacción. Una orden guardada ya no se edita: sólo una NEW cambia de `status`, y sólo a FILLED o CANCELLED. `order_events` sólo acepta filas nuevas. Un error se corrige con una orden nueva que lo compensa, como en un libro contable. Borrar una orden falla: su historia en `order_events` la referencia.
- **Cómo se aplica:** espera hasta 5 s el lock de `orders` y bloquea sus escrituras mientras corre (con 11 órdenes, milisegundos), para que el arranque de `order_events` no pierda ninguna. El arranque guarda sólo el estado actual de cada orden existente: su historia anterior no está en ningún lado. Se puede correr más de una vez (`IF NOT EXISTS`, `NOT EXISTS`). Lo aplican `docker compose` y los tests.
- **Sin aplicar:** no lo corrí sobre la base provista porque no es mía. La API funciona y dice qué falta: 501 para `Idempotency-Key`; el motivo de un REJECTED queda en la respuesta y el log.
- **Índice:** `orders (userid, status)`: cada lectura de dinero filtra las órdenes de un usuario bajo el lock, y varias también por estado. Con 11 órdenes Postgres igual elige un seq scan.
- **Alternativa descartada:** que la app migre sola al arrancar. Cambiaría una base ajena sin que nadie lo decida, y una base sin permisos de DDL no arrancaría.
- **A escala:** migraciones versionadas en lugar de un script.

## D-11 Anomalías del seed: se muestran, no se corrigen
- El usuario 1 tiene BMA −10 (la orden 11 vende 30 con 20 en cartera). Se muestra con su valor negativo, sin rendimiento total, y toda venta nueva de BMA es REJECTED.
- PGR (id 3) e IRCP (id 10) no tienen `marketdata`: MARKET → 201 REJECTED `NO_MARKET_PRICE` (por `amount`, 400 `AMOUNT_NEEDS_A_PRICE`: no hay `size` posible); LIMIT se acepta. Un `close` en 0 cuenta como sin precio.
- Una posición sin precio muestra su cantidad con valor null; `unpricedInstrumentIds` dice qué quedó fuera del total, así un total parcial no parece completo.
- Los precios son de 2023-07-14. No valido antigüedad.
**Alternativa descartada:** corregir el seed. Los datos son un registro: no se reescribe historia.
**A escala:** rechazar MARKET si el último `close` tiene más de N minutos.

## D-12 Búsqueda
Un parámetro `q` (1 a 50 caracteres) busca parcial en ticker o nombre, sin distinguir mayúsculas (`ILIKE`, con `%` y `_` escapados), excluye ARS (MONEDA), ticker exacto primero, máximo 20.
**Alternativa descartada:** insensible a acentos con `unaccent`: es una extensión, o sea DDL sobre la base provista.
**A escala:** índices GIN `pg_trgm` sobre `ticker` y `name` (una extensión: DDL que decide quien opera la base) y cache de instrumentos (cambian poco; los saldos no se cachean nunca).

## D-13 Idempotencia
Un reintento de red no puede crear dos órdenes.
- **Mecanismo:** con el header `Idempotency-Key`, la clave se busca y se guarda dentro del mismo lock y la misma transacción que la orden. 5 reintentos paralelos crean 1 orden; los otros 4 reciben la misma respuesta (`Idempotent-Replayed: true`), incluido el `reason` de un REJECTED.
- **Reglas:** misma clave con otro body → 422; `"10000"` y `"10000.00"` son el mismo body. Un 400 no guarda la clave. La clave se busca antes de validar el instrumento: el reintento recibe su respuesta original, y una clave reusada da 422, aunque el instrumento haya cambiado o no exista. Si la orden se canceló después, el reintento sigue diciendo NEW.
- **Clave opcional:** el enunciado define el endpoint sin ella; exigirla daría 400 a un cliente que lo sigue. Sin header, cada request es nueva: la API no puede distinguir un reintento de una orden nueva.
- **Base provista:** la tabla no existe. La búsqueda falla con SQLSTATE `42P01` y la request recibe 501 `IDEMPOTENCY_UNAVAILABLE` sin guardar nada: aceptar el header sin cumplirlo prometería reintentos seguros. Quien opere la base decide si la crea: `psql "$DATABASE_URL" -f db/local-additions.sql`.
- **Alternativa descartada:** Redis (otro sistema que puede desincronizarse de la orden; en Postgres se confirman juntas). Ignorar el header en silencio (un reintento duplicaría la orden).
- **A escala:** las claves no vencen: una fila por orden con clave. Un job diario borraría las de más de 24 h; el `DELETE` está comentado en `db/local-additions.sql`.

## Lo que no construí, y por qué
- Endpoints de CASH_IN / CASH_OUT: el enunciado pide tres endpoints; las transferencias del seed se leen igual. `side: CASH_IN` en `/orders` → 400.
- Ejecución de órdenes LIMIT: "NO hace falta simular el mercado".
- Autenticación: fuera de alcance según el enunciado.
- Vencimiento diario de LIMIT, paginación, métricas.

## Cómo usé IA
Escribí la solución con agentes de IA y verifiqué cada parte con tests sobre Postgres real. Las garantías centrales las comprobé rompiendo el código: sin el lock, sin `NULLS LAST` o con un `statement_timeout` mayor, su test falla. Una corrección concreta: `lock_timeout` tiene que fijarse antes de tomar el lock; al revés nunca se aplica.
