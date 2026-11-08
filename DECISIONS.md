# Decisiones

Cada decisión: qué elegí, por qué (con un dato), la alternativa que descarté y qué cambia a escala.
Los códigos HTTP de cada caso están en la tabla del README.

## D-01 Stack: NestJS 11 + TypeORM sólo como conexión + SQL explícito
NestJS (lo nombra el enunciado) da módulos, inyección de dependencias y validación. TypeORM sólo aporta el `DataSource` y las transacciones: no hay entidades ni repositorios, porque el esquema es fijo y las consultas de dinero son agregados que se leen mejor en SQL. Todo SQL usa parámetros (`$1`), nunca concatenación.
**Alternativa descartada:** Prisma o entidades TypeORM: agregan un modelo que no aporta nada sobre un esquema dado y esconden el SQL que hay que defender.
**A escala:** igual. El núcleo (`decide.ts`, `positions.ts`) no importa nada de Nest ni de TypeORM, así que cambiar el framework no toca la lógica.

## D-02 El estado se deriva del log `orders`, no se guarda
El enunciado pide calcular tenencia y pesos "utilizando todos los movimientos pertinentes que hay en la tabla `orders`". Cash = Σ CASH_IN + SELL − CASH_OUT − BUY de las órdenes FILLED (`size × price`). Las posiciones salen de plegar las FILLED en orden de `datetime, id` (`src/ledger.ts`). Cada orden nueva guarda `clock_timestamp()` tomado después del lock, así el orden temporal es el orden real de ejecución. `datetime` no tiene zona horaria: leo el seed como UTC y escribo en UTC. No hay una segunda copia que pueda desincronizarse.
**Alternativa descartada:** una tabla `balances`/`positions`. Hoy sería estado duplicado sin necesidad: con 11 órdenes por usuario la suma cuesta microsegundos.
**A escala:** tabla `positions` actualizada en la misma transacción que la orden, más una reconciliación nocturna contra `orders` (el log sigue siendo la fuente de verdad).

## D-03 Las órdenes NEW reservan cash o acciones
Una LIMIT BUY NEW retiene `size × price`; una LIMIT SELL NEW retiene `size` acciones. Disponible = saldo − reservas, para el cash y para cada posición (`reservedQuantity`, `availableQuantity`). Sin esto, el usuario 1 podría gastar dos veces los 125.500 que ya comprometió (órdenes 5 y 7 del seed). Cancelar libera la reserva.
**Alternativa descartada:** validar sólo contra el saldo FILLED. Permite sobregirar con órdenes abiertas.
**A escala:** al ejecutarse una LIMIT, liquidar al precio de ejecución y devolver la diferencia de la reserva.

## D-04 Concurrencia: un lock por usuario
Leer disponible → decidir → insertar es un check-then-act: dos compras paralelas de 400.000 con 627.500 disponibles verían ambas 627.500.
**Mecanismo:** cada orden toma `SELECT id FROM users WHERE id = $1 FOR UPDATE` (`src/db.ts`) en una transacción READ COMMITTED. Las órdenes del mismo usuario se serializan; las de usuarios distintos no se bloquean. Regla: todo lo que pueda gastar cash o acciones toma este lock primero. Cancelar no lo necesita: sólo libera (D-09). El precio se lee después del lock, así que una MARKET usa el último `close` aunque haya esperado.
**Límites:** toda transacción espera un lock hasta 3 s, corre cada sentencia hasta 5 s y espera una conexión del pool (10) hasta 3 s. Pasado cualquiera: 503 + `Retry-After`, nada guardado, una línea `busy` en el log.
**Evidencia:** `test/concurrency.e2e-spec.ts` retiene el lock desde afuera, encola 5 compras con cash para 4 y lo suelta: 4 FILLED, 1 REJECTED; igual con ventas. Sin `FOR UPDATE` los dos tests dan 5 FILLED: las 5 igual esperan en el chequeo de foreign key del INSERT, pero cada una ya leyó el mismo disponible. **Trade-off, medido:** cada orden en espera ocupa una conexión del pool (10 por instancia). Con el lock de un usuario trabado y 30 órdenes suyas, otro usuario espera ~3 s (la cola del pool es FIFO) y puede recibir 503; nunca hay sobregiro. Bajar `lock_timeout` a 1 s no lo mejora: 3 tandas de 10 × 1 s. `FOR UPDATE NOWAIT` lo baja a ~20 ms, pero rechaza con 503 la segunda de dos órdenes legítimas en paralelo. Elegí esperar: las órdenes de un usuario se ejecutan en orden. Un usuario que abusa se frena antes del pool, con un límite por usuario en el API Gateway.
**Alternativa descartada:** SERIALIZABLE (loop de reintentos), advisory locks (otro espacio de claves), mutex en memoria (falla con 2 instancias).
**A escala:** el lock vive en Postgres, así que sirve con N instancias y con PgBouncer en modo transacción (`SET LOCAL`). Lo primero que se agota es el pool. PgBouncer no lo evita: una transacción esperando un lock igual ocupa una conexión del servidor; el límite por usuario va en el gateway. El id de usuario es la clave natural para shardear.

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
`size = floor(amount / precio)`, con el último `close` para MARKET y el precio límite para LIMIT. Si da 0 acciones → 400 `AMOUNT_BELOW_ONE_SHARE`: la request nunca podría ejecutarse. Sólo se debita o reserva `size × precio`, no el monto entero.
**Alternativa descartada:** guardarla como REJECTED. No hay una orden posible que rechazar.

## D-09 Cancelación atómica
`UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userid = $2 AND status = 'NEW'`: la condición y el cambio son un solo paso, sin carrera entre leer y escribir. Si no actualiza nada: 404 si la orden no es de ese usuario (no revela que existe), 409 si ya no está NEW (también un segundo cancel).
**Alternativa descartada:** 200 idempotente en el segundo cancel. Es defendible, pero 409 dice la verdad: esa orden ya no se puede cancelar.
La fila pierde su estado anterior, pero `order_events` guarda NEW y después CANCELLED (D-07), y el log tiene una línea `cancel`.
**A escala:** igual.

## D-10 El esquema provisto no cambia; los agregados son un paso de deploy
La app corre sobre la base provista tal cual: `test/provided-db.e2e-spec.ts` lo prueba sobre una copia local con sólo `database.sql` y SSL. Prueba el esquema y SSL, no la conexión a Neon. Lo único agregado es `db/local-additions.sql`: `idempotency_keys` y `order_events`. Crea dos tablas nuevas y agrega un trigger a `orders`: no cambia columnas ni filas existentes, pero cada INSERT o cambio de estado en `orders` escribe también una fila en `order_events`, en la misma transacción, y una orden guardada ya no se puede editar: sólo cambia su `status`. Mientras corre, bloquea escrituras en `orders` hasta 5 s, para que el arranque de `order_events` con el estado de cada orden existente no pierda ninguna. Lo aplican `docker compose` y los tests. Es el paso de deploy recomendado para la base provista: es aditivo y se puede correr más de una vez (`IF NOT EXISTS`, `NOT EXISTS`). No lo corrí sobre ella porque no es mía: sin él, la API funciona y dice qué le falta (501 para `Idempotency-Key`; el motivo de un REJECTED queda en la respuesta y el log). Índices propuestos en `db/optional-hardening.sql`, cada uno con la consulta que acelera; con 11 órdenes Postgres igual elige un seq scan.
**Alternativa descartada:** que la app migre sola al arrancar. Cambiaría una base ajena sin que nadie lo decida, y una base sin permisos de DDL no arrancaría.
**A escala:** aplicar `optional-hardening.sql` con una migración versionada.

## D-11 Anomalías del seed: se muestran, no se corrigen
- El usuario 1 tiene BMA −10 (la orden 11 vende 30 con 20 en cartera). Se muestra con su valor negativo, sin rendimiento total, y toda venta nueva de BMA es REJECTED.
- PGR (id 3) e IRCP (id 10) no tienen `marketdata`: MARKET → 201 REJECTED `NO_MARKET_PRICE`; LIMIT se acepta (el precio límite alcanza). Si esa MARKET viene por `amount`, no hay `size` posible: 400 `AMOUNT_NEEDS_A_PRICE`, como un monto menor a una acción (D-08); una orden guardada siempre tiene `size`. Un `close` en 0 cuenta como sin precio.
- Una posición sin precio muestra su cantidad con valor null. El valor total suma lo que sí tiene precio y `unpricedInstrumentIds` dice qué quedó afuera, así un total parcial no parece completo. Con el seed no pasa: ninguna orden FILLED usa PGR o IRCP (un test lo cubre insertando una).
- Los precios son de 2023-07-14. No valido antigüedad.
**Alternativa descartada:** corregir el seed. Los datos son un registro: no se reescribe historia.
**A escala:** rechazar MARKET si el último `close` tiene más de N minutos.

## D-12 Búsqueda
Un parámetro `q` (1 a 50 caracteres) busca parcial en ticker o nombre, sin distinguir mayúsculas (`ILIKE`, con `%` y `_` escapados), excluye ARS (MONEDA), ticker exacto primero, máximo 20.
**Alternativa descartada:** insensible a acentos con `unaccent`: es una extensión, o sea DDL sobre la base provista.
**A escala:** índice `pg_trgm` GIN (en `optional-hardening.sql`) y cache de instrumentos (cambian poco; los saldos no se cachean nunca).

## D-13 Idempotencia
Un reintento de red no puede crear dos órdenes. Con el header `Idempotency-Key`, la clave se busca y se guarda dentro del mismo lock y la misma transacción que la orden: 5 reintentos paralelos crean 1 orden y los otros 4 reciben la misma respuesta (`Idempotent-Replayed: true`), incluido el `reason` de un REJECTED. Misma clave con otro body → 422; el mismo monto escrito de otra forma (`"10000"` y `"10000.00"`) es el mismo body. Sin header, cada request es nueva: no la exijo porque el enunciado define el endpoint sin ella, y un cliente que lo sigue recibiría 400. Un 400 no guarda la clave. La clave se busca antes de validar el instrumento: un reintento recibe su respuesta original aunque el instrumento haya cambiado, y una clave reusada con otro body da 422 aunque el instrumento no exista. Un reintento recibe la respuesta original: si la orden se canceló después, sigue diciendo NEW.
La tabla está en `db/local-additions.sql`. En la base provista no existe: la búsqueda de la clave, dentro del lock, falla con SQLSTATE `42P01`, y la request recibe 501 `IDEMPOTENCY_UNAVAILABLE` sin guardar nada. Aceptar el header sin cumplirlo sería prometer reintentos seguros que no lo son. Quien opere esa base decide si la crea: `psql "$DATABASE_URL" -f db/local-additions.sql`. La API no guarda estado sobre esto: lo ve en la request siguiente.
**Alternativa descartada:** Redis. Otro sistema que puede quedar desincronizado con la orden; en Postgres la clave y la orden se confirman juntas. Ignorar el header en silencio: un reintento duplicaría la orden.
Las claves no vencen: una fila por orden con clave. **A escala:** un job diario borra las de más de 24 h (el `DELETE` está comentado en `db/local-additions.sql`).

## Lo que no construí, y por qué
- Endpoints de CASH_IN / CASH_OUT: el enunciado pide tres endpoints; las transferencias del seed se leen igual. `side: CASH_IN` en `/orders` → 400.
- Ejecución de órdenes LIMIT: "NO hace falta simular el mercado".
- Autenticación: fuera de alcance según el enunciado.
- Vencimiento diario de LIMIT, kill switch por instrumento, paginación, métricas: próximos pasos. Los dos primeros entran en `decide.ts` y `orders.ts` sin tocar el resto.

## Cómo usé IA
Escribí la solución con agentes de IA y verifiqué cada parte con tests sobre Postgres real. Las garantías centrales las comprobé rompiendo el código: sin el lock, sin `NULLS LAST` o con un `statement_timeout` mayor, su test falla. Una corrección concreta: `lock_timeout` tiene que fijarse antes del `FOR UPDATE`; al revés nunca se aplica.
