<!-- PROTOTYPE for #311 -->

# Neon from a Fargate task: results (lane B of #311)

Measured 2026-09-25 against Neon project `patchy-tier2-spike` (`aws-us-east-1`, Postgres 17.11, one 1 CU compute, suspend after 5 min, no pooler) from a one-off ECS Fargate task (0.5 vCPU, 1 GB, public subnet, `us-east-1a`) and, for contrast, from Allison's machine (about 105 ms from us-east-1). Every table below says which. All times are milliseconds unless stated. The raw Markdown blocks the script printed follow the summary; the Fargate one is the run that counts.

## Summary

### 1. Round trip

Warm compute, fresh connection each time, n=50. `pg connect()` is DNS+TCP+SSLRequest+TLS+SASL auth; the raw rows are a separate handshake with no auth.

| measure                                     | Fargate p50 | Fargate p95 | Fargate p99 | local p50 | local p95 | local p99 |
| ------------------------------------------- | ----------- | ----------- | ----------- | --------- | --------- | --------- |
| DNS lookup                                  | 0.7         | 2.5         | 3.2         | 0.7       | 0.9       | 1.4       |
| TCP connect (raw)                           | 2.8         | 4.2         | 69.9        | 108.0     | 162.0     | 182.8     |
| SSLRequest round trip (raw)                 | 1.1         | 1.3         | 1.3         | 106.9     | 163.8     | 173.1     |
| TLS handshake (raw)                         | 4.3         | 4.7         | 6.3         | 115.4     | 160.3     | 167.0     |
| `pg connect()` total                        | 20.4        | 34.5        | 75.0        | 667.3     | 791.3     | 801.7     |
| auth (derived: connect minus raw handshake) | 11.5        | 25.7        | 62.2        | 333.3     | 434.0     | 435.5     |
| first `SELECT 1`                            | 1.9         | 2.2         | 2.3         | 107.8     | 149.5     | 164.3     |
| second `SELECT 1`                           | 1.7         | 1.9         | 1.9         | 107.4     | 156.3     | 164.7     |

SCRAM auth through Neon's proxy costs about three round trips on top of the handshake (11.5 ms from Fargate, 333 ms from 105 ms away): a fresh connection is about 20 ms in-region, a query on an open connection about 2 ms. The ADR-0009 retained pool is what makes tier 2 callbacks cheap.

Cold compute, five suspend cycles through the Neon API, each confirmed `idle` before connecting (Fargate; one local cycle for contrast):

| cycle     | suspend op done | state before | `pg connect()` incl. wake | first `SELECT 1` | second `SELECT 1` |
| --------- | --------------- | ------------ | ------------------------- | ---------------- | ----------------- |
| Fargate 1 | 1877            | idle         | 577.5                     | 7.0              | 1.3               |
| Fargate 2 | 776             | idle         | 579.7                     | 6.5              | 1.9               |
| Fargate 3 | 729             | idle         | 630.9                     | 15.1             | 1.8               |
| Fargate 4 | 718             | idle         | 573.4                     | 5.2              | 1.5               |
| Fargate 5 | 713             | idle         | 561.5                     | 6.5              | 2.1               |
| local 1   | 1727            | idle         | 1183.2                    | 112.0            | 104.5             |

The wake lives inside the connection: TCP and TLS to the proxy complete at warm speed (3 ms, 4.5 ms) while the compute is suspended, then the startup/auth exchange stalls until the compute is up. Wake plus auth is 560 to 630 ms in-region (about 560 ms of wake on top of the 20 ms warm connect), and the first query on the woken compute is 5 to 15 ms instead of 2 (cold caches), the second is back to normal. This matches the "about 0.7 s" the Neon research quoted.

### 2. The ten-callback SERIALIZABLE mutation

One reused connection, `BEGIN ISOLATION LEVEL SERIALIZABLE`, ten statements (list, insert, read-own-write, update, read-own-write, insert, update, count, counter update, counter read), `COMMIT`: 12 round trips, n=100.

| measure                                 | Fargate p50 | Fargate p95 | Fargate p99 | local p50 | local p95 | local p99 |
| --------------------------------------- | ----------- | ----------- | ----------- | --------- | --------- | --------- |
| mutation total (12 round trips)         | 35.5        | 36.8        | 41.2        | 1253.2    | 1425.8    | 1501.7    |
| per-statement round trip (1200 samples) | 2.9         | 3.7         | 3.9         | 104.4     | 122.9     | 142.2     |
| `COMMIT` alone                          | 3.7         | 3.9         | 5.1         | 105.1     | 128.6     | 140.0     |

Every statement costs one network round trip (about 2.9 ms in-region); `COMMIT` is a little more (WAL to the safekeepers). A ten-callback mutation is about 36 ms of database time from Fargate, well inside the five-second deadline, and about 1.25 s from 105 ms away, which is what a cross-cloud hop would have cost per mutation.

Contention on one counter row, each slot looping `BEGIN SERIALIZABLE; SELECT n; UPDATE n = read+1; COMMIT` for 30 s with a retry on `40001`:

| where   | slots | attempts | commits | 40001s | 40001 at UPDATE / COMMIT | commits/s | commit p50 | commit p95 | commit p99 | final = start + commits |
| ------- | ----- | -------- | ------- | ------ | ------------------------ | --------- | ---------- | ---------- | ---------- | ----------------------- |
| Fargate | 4     | 15522    | 4624    | 10898  | 10898 / 0                | 154.1     | 7.1        | 10.6       | 11.1       | yes                     |
| Fargate | 2     | 6310     | 4075    | 2235   | 2235 / 0                 | 135.8     | 7.2        | 12.8       | 13.4       | yes                     |
| local   | 4     | 283      | 87      | 196    | 196 / 0                  | 2.9       | 423.3      | 432.0      | 460.6      | yes                     |
| local   | 2     | 143      | 72      | 71     | 71 / 0                   | 2.4       | 421.3      | 428.8      | 441.1      | yes                     |

On one hot row, four slots commit 13 % more per second than two while wasting 70 % of attempts on `40001` (two slots waste 35 %); every conflict surfaces at the `UPDATE`, none at `COMMIT`, and totals were correct every time. Four slots are not harmful on one hot row, they are just not much better; the #310 comparison should be repeated with reactive reads in the mix.

Deterministic `40001` (Fargate and local identical): A and B both `SELECT` the row under SERIALIZABLE, A updates and commits, B's `UPDATE` fails with SQLSTATE `40001` "could not serialize access due to concurrent update"; B rolls back, reruns from the top and commits; counter 0 to 2.

Five-second cancellation (`SET LOCAL statement_timeout = '5000'` plus a client timer at 5000 ms around `pg_sleep(10)` in a SERIALIZABLE transaction with one insert):

| where   | fired first                | statement ended after | SQLSTATE | message                                      | backend after the error         | after `end()`       |
| ------- | -------------------------- | --------------------- | -------- | -------------------------------------------- | ------------------------------- | ------------------- |
| Fargate | server `statement_timeout` | 5002.2                | 57014    | canceling statement due to statement timeout | `idle in transaction (aborted)` | gone, 0 rows landed |
| local   | server `statement_timeout` | 5105.9                | 57014    | canceling statement due to statement timeout | `idle in transaction (aborted)` | gone, 0 rows landed |

Both paths give the same SQLSTATE; only the message says which. The server timer wins because it starts when the statement starts executing and the client's starts when it is sent. `pg`'s own cancel path (a plaintext `CancelRequest` on a new TCP connection with the key pair the proxy handed out) also works against Neon: sent at 1.0 s into `pg_sleep(10)`, the statement ended 16 ms later from Fargate (441 ms locally) with 57014 "canceling statement due to user request". Neon's proxy hands out its own BackendKeyData (a negative process id, not the backend pid) and maps it, so `pg_stat_activity` must be looked up by `pg_backend_pid()`, not by what the client holds. A `COMMIT` on the aborted transaction is accepted and acts as `ROLLBACK`.

Lost commit reply (Fargate and local identical): through a local TCP proxy that forwards `COMMIT` and drops the reply, the client sees "Connection terminated unexpectedly" and the row **is present**. With `stream.destroy()` in the same tick as `query("COMMIT")`, the client sees the same error and the row is **absent** (the buffered `COMMIT` never left). Same client-side signal, opposite outcome: `unknown_outcome` is the only honest answer, as #310 decided.

### 3. Forced compute restart mid-mutation (Fargate, once)

Transaction open with three statements done (insert, update, select), then `POST .../restart`: the API answered in 202 ms and its operations (`start_compute`, `prewarm_replica`, `suspend_compute`, `promote_replica`, `start_compute`, `suspend_compute`, a replica-promotion restart) finished after 2773 ms. The fourth statement and the `COMMIT` both failed with `pg`'s client-side "Client has encountered a connection error and is not queryable" (no SQLSTATE; the underlying event was the socket closing). The marker row and the counter update did not land. A new connection succeeded on the first attempt 2809 ms after the restart call (tried once the operations reported done, so this is an upper bound). The first attempt at this step, in the full run, aborted on my side: the restart's `start_compute` came back `skipped` because a reconnecting pool (the other lane's) had already started the compute, and the script treated `skipped` as a failure. The other lane therefore saw two drops from the restart, on top of the five suspends of the cold cycles.

### 4. ADR-0009 provisioning under `neon_superuser` (Fargate; local agrees, slower)

| step                                                                          | result                                                                                          | Fargate ms | local ms   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- | ---------- |
| `CREATE ROLE company_x LOGIN PASSWORD`                                        | ok; creator gets membership `admin=true set=false inherit=false`                                | 98         | 146        |
| `CREATE DATABASE company_x OWNER company_x`                                   | **refused** 42501 "must be able to SET ROLE company_x"                                          | 3          | 105        |
| `GRANT company_x TO patchy_admin WITH SET TRUE`                               | ok (INHERIT defaults to the grantee's attribute, so it is `set=true inherit=true`)              | 44         | 128        |
| `CREATE DATABASE company_x OWNER company_x` again                             | ok, `datdba` is `company_x`                                                                     | 1375       | 155        |
| connect to `company_x` as admin, `SET ROLE company_x`                         | `current_user=company_x session_user=patchy_admin`                                              | 35 + 4     | 645 + 213  |
| `CREATE TABLE`, `CREATE SCHEMA patchy` as the role                            | owner `company_x`                                                                               | 12, 5      | 216, 212   |
| `RESET ROLE`, admin reads the table                                           | ok (INHERIT was on for this grant)                                                              | 4, 2       | 212, 105   |
| log in as `company_x` with its password, insert                               | ok                                                                                              | 30         | 861        |
| `REVOKE company_x FROM patchy_admin`, then `SET ROLE`                         | refused 42501 "permission denied to set role"                                                   | 33, 37     | 130, 869   |
| `DROP DATABASE company_x` with no membership                                  | **refused** 42501 "must be owner of database"                                                   | 5          | 104        |
| re-grant `WITH SET TRUE, INHERIT FALSE`, `DROP DATABASE`                      | **refused** 42501 "must be owner" (ownership checks need INHERIT)                               | 31, 3      | 130, 103   |
| `SET ROLE company_x; DROP DATABASE company_x; RESET ROLE`                     | ok                                                                                              | 41         | 340        |
| `DROP ROLE company_x`                                                         | ok                                                                                              | 36         | 131        |
| NOLOGIN variant with `SET createrole_self_grant = 'set'` before `CREATE ROLE` | membership `set=true inherit=false` arrives automatically; create, own, `SET ROLE`, drop all ok | 181 total  | 1154 total |
| `BEGIN; CREATE DATABASE`                                                      | refused 25001, as on any Postgres                                                               | 8          | 314        |

Neon refused nothing that stock Postgres 17 would allow. What bit is Postgres 16+'s `CREATE ROLE` semantics on Neon's defaults: the creator gets `ADMIN OPTION` only, not `SET`, so `CREATE DATABASE … OWNER` needs one more grant. The ADR's "permission to `SET ROLE` to the data role" is satisfied either by `GRANT company_x TO patchy_admin WITH SET TRUE, INHERIT FALSE` after each `CREATE ROLE` or by `ALTER ROLE patchy_admin SET createrole_self_grant = 'set'` once; and reclamation must run as the owner (`SET ROLE company_x; DROP DATABASE`) because `DROP DATABASE` checks ownership through inherited privileges, which SET-only membership does not give. `CREATE DATABASE` took 1.4 s on Fargate in the provisioning step (58 ms for the scratch database at the start, 1.4 s locally): Neon forwards role and database DDL to its control plane (`neon.forward_ddl = on`), and that hop is variable.

### Server settings and the idle connection

`PostgreSQL 17.11 on aarch64`, `max_connections 450` (6 reserved), `idle_in_transaction_session_timeout 300000` (five minutes, set by Neon: a held transaction dies after five idle minutes, harmless against our five-second deadline), `statement_timeout 0`, `default_transaction_isolation read committed`, `max_prepared_transactions 0`, `wal_level replica`, `ssl off` (TLS terminates at the proxy), 121 `neon.*` settings visible (`neon.forward_ddl on`, `neon.privileged_role_name neon_superuser`, `neon.file_cache_size_limit 3276MB`, `neon.max_cluster_size 16777216`). `createrole_self_grant` is empty.

One idle connection (not in a transaction) held open from Fargate: the endpoint stayed `active` for the whole 8-minute watch and the socket stayed usable afterwards. The other lane's pool had two idle `patchy_admin` connections open at the same time, so this run cannot separate "idle connections keep the compute up" from "the other lane kept it up"; Neon's documentation says idle connections do not block suspend, and the five API suspends in step 1b did suspend the compute with those same connections open. Treat as unresolved, cheap to re-measure alone.

## What Neon refused or made awkward

- Nothing was refused outright. The `42501` refusals above are Postgres 17 role semantics under Neon's defaults (empty `createrole_self_grant`), and they reshape the provisioning SQL: one extra `GRANT … WITH SET TRUE` per company role, and reclamation as the owner via `SET ROLE`.
- The proxy's BackendKeyData is synthetic (negative process id, its own secret key). Cancellation works through it, plaintext or TLS, but anything that joins the client's `processID` to `pg_stat_activity.pid` (ADR-0009's earlier `pg_cancel_backend(client.processID)` note) is wrong on Neon: use `pg_backend_pid()` from the session or protocol-level cancel.
- A suspend or restart through the API drops every connection on the compute, including long-lived admin ones: any provisioning or sweep connection opened before a suspend is dead afterwards, with `pg` reporting it lazily as "Client has encountered a connection error" on the next query. Reconnect-on-use, not connection reuse across minutes.
- `restart` returned `start_compute = skipped` when a pool reconnected first; operation pollers must treat `skipped` as done. The Neon API also reports the restart as six operations including replica prewarm and promotion, so "restart" is not one atomic event to time.
- `CREATE DATABASE` latency swings from 58 ms to 1.4 s because Neon forwards the DDL to its control plane. Provisioning should not sit on a request path.
- `idle_in_transaction_session_timeout` is preset to five minutes and `neon_superuser` can change it; `max_connections` is fixed at 450 for this 1 CU compute, comfortably above ADR-0009's 200-backend budget.
- The `DATABASE_URL` in `~/.config/patchy-cloud/neon-spike.env` carries an unquoted `&` (`?sslmode=require&channel_binding=require`), so `source` silently backgrounds the assignment and the variable stays empty; both runners read it with `grep`. `pg` 8 also warns that `sslmode=require` is treated as `verify-full`; the script passes an explicit TLS config instead.
- AWS side: nothing refused. Building with `crane append` on `node:24-slim` and running one-off tasks in the public subnet with the host security group worked first time; the logs arrive in CloudWatch a few seconds behind. Fargate task start to container running was about 20 s. The task's Neon credentials ride in the task definition environment, a spike shortcut.

## State at the end

- No ECS task or service of this lane running; two one-off tasks ran and stopped (`4e14fc4b…` full run, exit 1 on the restart bug; `712b35c8…` restart-only rerun, exit 0). Task-definition family `tier2-spike-neon-bench` (two revisions) deregistered; image tags `neon-bench-682e32d-173436` and `neon-bench-71de680-174646` left in ECR (a few MB).
- Neon: scratch database `neon_bench`, `company_x`, `company_y` and their roles dropped (databases `patchy, postgres, template0, template1`; roles `cloud_admin, neon_service, neon_superuser, patchy_admin`). Endpoint `ep-rough-base-b7yg8olj` left as found: suspend enabled at the default five minutes, compute `active` at exit.

# Fargate run, raw output

The full run (task `4e14fc4b`), with section 3 taken from the restart-only rerun (task `712b35c8`).

# Neon bench results (fargate), 2026-09-25T15:35:16.316Z

Host `ep-rough-base-b7yg8olj.c-13.us-east-1.aws.neon.tech`, project `fancy-mode-72369071`, endpoint `ep-rough-base-b7yg8olj`, steps: settings, warm, cold, mutation, contention, conflict, cancel, lostcommit, provision, idle, restart.

## Server settings (fargate)

- version: `PostgreSQL 17.11 (8a81ecb) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit`
- connected as `patchy_admin` to `patchy`
  | setting | value |
  |---|---|
  | createrole_self_grant | |
  | default_transaction_isolation | read committed |
  | idle_in_transaction_session_timeout | 300000 ms |
  | idle_session_timeout | 0 ms |
  | lock_timeout | 0 ms |
  | max_connections | 450 |
  | max_locks_per_transaction | 64 |
  | max_pred_locks_per_transaction | 64 |
  | max_prepared_transactions | 0 |
  | server_version | 17.11 (8a81ecb) |
  | shared_buffers | 16384 8kB |
  | ssl | off |
  | statement_timeout | 0 ms |
  | superuser_reserved_connections | 6 |
  | wal_level | replica |
  | work_mem | 4096 kB |
  `neon.*` settings visible: 121. A selection:
  | setting | value |
  |---|---|
  | neon.communicator_mode | multiplexer |
  | neon.compute_mode | primary |
  | neon.endpoint_id | ep-rough-base-b7yg8olj |
  | neon.event_triggers | on |
  | neon.file_cache_size_limit | 3276MB |
  | neon.forward_ddl | on |
  | neon.lakebase_mode | off |
  | neon.max_cluster_size | 16777216 |
  | neon.max_reconnect_attempts | 60 |
  | neon.privileged_role_name | neon_superuser |
  | neon.protocol_version | 3 |
  | neon.safekeeper_proto_version | 4 |
  | role | super | createdb | createrole | login |
  |---|---|---|---|---|
  | cloud_admin | true | true | true | true |
  | neon_service | false | true | true | true |
  | neon_superuser | false | true | true | false |
  | patchy_admin | false | true | true | true |
  Client backends at start (other lanes share this compute):
  | user | application | state | n |
  |---|---|---|---|
  | cloud_admin | compute_ctl:compute_monitor | idle | 1 |
  | cloud_admin | neon_compute_sql_exporter | idle | 1 |
  | cloud_admin | postgres-exporter | idle | 1 |
  | cloud_admin | vm-monitor | idle | 1 |
  | patchy_admin | | idle | 1 |
  | patchy_admin | neon-bench-fargate | active | 1 |
- `CREATE DATABASE neon_bench`: 57.8 ms

## 1a. Round trip, warm compute (fargate, n=50)

Endpoint state before: `active`.
Resolved `ep-rough-base-b7yg8olj.c-13.us-east-1.aws.neon.tech` to `52.2.183.93`. Each iteration: a DNS lookup, a raw TCP+SSLRequest+TLS handshake (no auth, closed), then a fresh `pg` `connect()` (its own DNS+TCP+TLS+SASL auth), `SELECT 1` twice, `end()`. "auth (derived)" is pg connect minus the separately measured DNS+TCP+SSLRequest+TLS, so it also absorbs any variance between the two handshakes.

| measure                               | n   | min   | p50  | p95  | p99   | max   | mean |
| ------------------------------------- | --- | ----- | ---- | ---- | ----- | ----- | ---- |
| DNS lookup                            | 50  | 0.5   | 0.7  | 2.5  | 3.2   | 3.2   | 1.0  |
| TCP connect (raw)                     | 50  | 2.3   | 2.8  | 4.2  | 69.9  | 69.9  | 4.3  |
| SSLRequest round trip (raw)           | 50  | 0.7   | 1.1  | 1.3  | 1.3   | 1.3   | 1.1  |
| TLS handshake (raw)                   | 50  | 3.8   | 4.3  | 4.7  | 6.3   | 6.3   | 4.4  |
| pg connect() total (DNS+TCP+TLS+auth) | 50  | 18.1  | 20.4 | 34.5 | 75.0  | 75.0  | 22.8 |
| auth (derived)                        | 50  | -48.7 | 11.5 | 25.7 | 62.2  | 62.2  | 12.1 |
| first SELECT 1                        | 50  | 1.4   | 1.9  | 2.2  | 2.3   | 2.3   | 1.9  |
| second SELECT 1                       | 50  | 1.1   | 1.7  | 1.9  | 1.9   | 1.9   | 1.6  |
| iteration total                       | 50  | 31.0  | 35.2 | 64.1 | 110.0 | 110.0 | 38.6 |

## 1b. Round trip, cold compute (fargate, n=5 suspend cycles)

Each cycle: `POST .../suspend` and wait for its operation, wait 3 s, read the endpoint state, then a DNS lookup, a raw TCP+TLS handshake to the proxy (no auth), a fresh `pg` `connect()` (this is where the proxy wakes the compute), `SELECT 1`, `end()`. If the state before connecting is not `idle`, something else (the other lane's pool) woke the compute first and the cycle is not cold.

| cycle                           | suspend API | suspend op done | state before connect | DNS   | raw TCP | raw TLS | pg connect() (includes wake) | first SELECT 1 | second SELECT 1 | state after |
| ------------------------------- | ----------- | --------------- | -------------------- | ----- | ------- | ------- | ---------------------------- | -------------- | --------------- | ----------- |
| 1                               | 113.6       | 1877.0          | idle                 | 0.7   | 9.0     | 4.6     | 577.5                        | 7.0            | 1.3             | active      |
| 2                               | 93.5        | 776.4           | idle                 | 2.9   | 3.1     | 4.5     | 579.7                        | 6.5            | 1.9             | active      |
| 3                               | 100.2       | 729.0           | idle                 | 0.9   | 2.9     | 4.5     | 630.9                        | 15.1           | 1.8             | active      |
| 4                               | 93.6        | 718.2           | idle                 | 0.6   | 2.5     | 4.2     | 573.4                        | 5.2            | 1.5             | active      |
| 5                               | 90.9        | 713.0           | idle                 | 2.1   | 3.2     | 4.6     | 561.5                        | 5.6            | 2.1             | active      |
| measure                         | n           | min             | p50                  | p95   | p99     | max     | mean                         |
| ---                             | ---         | ---             | ---                  | ---   | ---     | ---     | ---                          |
| cold pg connect() (wake + auth) | 5           | 561.5           | 577.5                | 630.9 | 630.9   | 630.9   | 584.6                        |
| cold first SELECT 1             | 5           | 5.2             | 6.5                  | 15.1  | 15.1    | 15.1    | 7.9                          |

## 2a. Ten-callback SERIALIZABLE mutation, warm, one reused connection (fargate, n=100)

Connection opened in 36.3 ms and reused (a pooled host connection). Each mutation is `BEGIN ISOLATION LEVEL SERIALIZABLE`, ten statements (list, insert, read-own-write, update, read-own-write, insert, update, count, counter update, counter read), `COMMIT`: 12 round trips.

| measure                                     | n    | min  | p50  | p95  | p99  | max  | mean |
| ------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| mutation total (12 round trips)             | 100  | 32.6 | 35.5 | 36.8 | 41.2 | 42.3 | 35.5 |
| per-statement round trip (all 12 positions) | 1200 | 2.3  | 2.9  | 3.7  | 3.9  | 10.2 | 3.0  |
| 1. BEGIN SERIALIZABLE                       | 100  | 2.3  | 2.8  | 3.0  | 3.1  | 3.3  | 2.8  |
| 2. SELECT list (20 rows)                    | 100  | 2.5  | 2.9  | 3.1  | 3.1  | 3.2  | 2.9  |
| 3. INSERT RETURNING                         | 100  | 2.4  | 2.9  | 3.1  | 3.2  | 3.2  | 2.9  |
| 4. SELECT own write                         | 100  | 2.4  | 2.9  | 3.1  | 3.2  | 3.2  | 2.9  |
| 5. UPDATE RETURNING                         | 100  | 2.5  | 2.9  | 3.1  | 3.3  | 3.5  | 2.9  |
| 6. SELECT own write                         | 100  | 2.4  | 2.9  | 3.1  | 3.2  | 3.2  | 2.9  |
| 7. INSERT RETURNING                         | 100  | 2.4  | 2.9  | 3.1  | 3.2  | 3.3  | 2.9  |
| 8. UPDATE two rows                          | 100  | 2.5  | 2.9  | 3.2  | 4.0  | 4.6  | 2.9  |
| 9. SELECT count                             | 100  | 2.5  | 2.9  | 3.1  | 3.2  | 3.4  | 2.9  |
| 10. UPDATE counter                          | 100  | 2.5  | 2.9  | 3.1  | 3.1  | 3.1  | 2.9  |
| 11. SELECT counter                          | 100  | 2.3  | 2.8  | 3.0  | 3.6  | 7.9  | 2.9  |
| 12. COMMIT                                  | 100  | 3.0  | 3.7  | 3.9  | 5.1  | 10.2 | 3.7  |

## 2b. Contention on one counter row, SERIALIZABLE read-then-write, retry on 40001 (fargate)

Each slot loops `BEGIN SERIALIZABLE; SELECT n; UPDATE n = read+1; COMMIT` on its own connection for 30 s; a `40001` rolls back and retries. Correct means the final counter equals start + commits.

| slots | seconds | attempts | commits | 40001s | 40001 at UPDATE | 40001 at COMMIT | other errors | commits/s | commit p50 | commit p95 | commit p99 | counter start -> end | correct |
| ----- | ------- | -------- | ------- | ------ | --------------- | --------------- | ------------ | --------- | ---------- | ---------- | ---------- | -------------------- | ------- |
| 4     | 30      | 15522    | 4624    | 10898  | 10898           | 0               | 0            | 154.1     | 7.1        | 10.6       | 11.1       | 0 -> 4624            | true    |
| 2     | 30      | 6310     | 4075    | 2235   | 2235            | 0               | 0            | 135.8     | 7.2        | 12.8       | 13.4       | 4624 -> 8699         | true    |

## 2c. Confirmed 40001, deterministic: two transactions read then write the same row (fargate)

- A read 0, B read 0; A wrote 1 and committed.
- B's UPDATE failed: SQLSTATE `40001`, `could not serialize access due to concurrent update`.
- B retried from the top: read 1, wrote 2, committed. Counter 0 -> 2; correct: true.

## 2d. Cancellation: client-side CancelRequest and the five-second statement_timeout race (fargate)

- BackendKeyData from the proxy: process id -1426772803, secret key nonzero; the real backend pid is 2701, so the proxy hands out its own cancel key and maps it.
- (i) pg's plaintext `CancelRequest` sent at 1.0 s into `pg_sleep(10)` inside `BEGIN`: statement ended after 1017.8 ms (16.3 ms after the cancel), SQLSTATE `57014`, `canceling statement due to user request`.
  - after the error: state=`idle in transaction (aborted)` from a second connection; transaction status on the client: `E`.
  - after `ROLLBACK` + `end()`: gone (no pg_stat_activity row).
- (ii) `SET LOCAL statement_timeout = '5000'` and a client timer at 5000 ms around `pg_sleep(10)` in a SERIALIZABLE transaction with one insert: fired first: **server statement_timeout**; statement ended after 5002.2 ms (client cancel sent at never), SQLSTATE `57014`, `canceling statement due to statement timeout`.
  - after the error: state=`idle in transaction (aborted)`; client transaction status `E`.
  - `COMMIT` on the aborted transaction: accepted (Postgres turns it into ROLLBACK, command tag would say so).
  - after `end()`: gone (no pg_stat_activity row); rows named `cancel-race` in the table: 0 (transaction gone, nothing landed).

## 2e. Lost commit reply (fargate)

- (a) via a local TCP proxy that forwards `COMMIT` and drops the reply, then destroys the socket: client saw after 301.8 ms: `Error`: `Connection terminated unexpectedly`; from a second connection the row is **present** (the commit landed). The client could not tell: `unknown_outcome`.
- (b) `query("COMMIT")` then `stream.destroy()` in the same tick on the direct TLS socket: client saw after 0.7 ms: `Error`: `Connection terminated unexpectedly`; row **absent** (destroy discarded the buffered COMMIT; the server rolled back on disconnect). Same client-side signal either way.

## 3. Forced compute restart mid-mutation (fargate, once, last)

- Transaction open with three statements done (insert, update, select read 1000); `POST .../restart`: API answered in 201.8 ms, operations `start_compute+prewarm_replica+suspend_compute+promote_replica+start_compute+suspend_compute` finished after 2773.1 ms.
- Fourth statement: `Error`: `Client has encountered a connection error and is not queryable`.
- COMMIT: `Error`: `Client has encountered a connection error and is not queryable`.
- New connection succeeded 2808.8 ms after the restart call, on attempt 1.
- Rows did not land: marker row count 0, counter 4 is 0 (was 1000 inside the transaction).
- Endpoint state now: `active`.

## 4. ADR-0009 provisioning path under neon_superuser (fargate)

| step                                                                     | statement                                                                                                                                                               | result                                                                                                                                  | ms     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| create login role                                                        | `CREATE ROLE company_x LOGIN PASSWORD '...'`                                                                                                                            | ok                                                                                                                                      | 98.0   |
| membership granted to creator                                            | `SELECT ... FROM pg_auth_members WHERE roleid = 'company_x'`                                                                                                            | patchy_admin: admin=true set=false inherit=false                                                                                        | 16.5   |
| create database owned (first try)                                        | `CREATE DATABASE company_x OWNER company_x`                                                                                                                             | **refused**: SQLSTATE `42501`, must be able to SET ROLE "company_x"                                                                     | 2.9    |
| grant SET to the creator                                                 | `GRANT company_x TO patchy_admin WITH SET TRUE`                                                                                                                         | ok                                                                                                                                      | 44.1   |
| membership after the grant (INHERIT defaults to the grantee's attribute) | `SELECT ... FROM pg_auth_members WHERE roleid = 'company_x'`                                                                                                            | patchy_admin: admin=true set=false inherit=false; patchy_admin: admin=false set=true inherit=true                                       | 3.0    |
| create database owned (after the grant)                                  | `CREATE DATABASE company_x OWNER company_x`                                                                                                                             | ok                                                                                                                                      | 1375.2 |
| verify owner                                                             | `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'company_x'`                                                                                           | company_x                                                                                                                               | 19.8   |
| admin connects to company_x                                              | `connect(database=company_x) as patchy_admin`                                                                                                                           | ok                                                                                                                                      | 34.8   |
| set role                                                                 | `SET ROLE company_x`                                                                                                                                                    | current_user=company_x session_user=patchy_admin                                                                                        | 4.2    |
| create table as company_x                                                | `CREATE TABLE t (id int)`                                                                                                                                               | owner company_x                                                                                                                         | 11.9   |
| create schema as company_x                                               | `CREATE SCHEMA patchy`                                                                                                                                                  | owner company_x                                                                                                                         | 5.0    |
| reset role                                                               | `RESET ROLE`                                                                                                                                                            | patchy_admin                                                                                                                            | 3.7    |
| admin reads the table without INHERIT                                    | `SELECT count(*) FROM t (as patchy_admin)`                                                                                                                              | 0                                                                                                                                       | 2.2    |
| company_x logs in                                                        | `connect(user=company_x, database=company_x)`                                                                                                                           | ok, inserted id 1                                                                                                                       | 30.0   |
| revoke membership                                                        | `REVOKE company_x FROM patchy_admin`                                                                                                                                    | ok                                                                                                                                      | 33.0   |
| set role after revoke                                                    | `SET ROLE company_x (expected to fail)`                                                                                                                                 | **refused**: SQLSTATE `42501`, permission denied to set role "company_x"                                                                | 36.6   |
| drop database without membership                                         | `DROP DATABASE company_x (as patchy_admin, CREATEDB, not a member)`                                                                                                     | **refused**: SQLSTATE `42501`, must be owner of database company_x                                                                      | 4.7    |
| re-grant SET only (creator holds ADMIN OPTION)                           | `GRANT company_x TO patchy_admin WITH SET TRUE, INHERIT FALSE`                                                                                                          | ok                                                                                                                                      | 31.4   |
| drop database with SET only                                              | `DROP DATABASE company_x (member with SET, no INHERIT; expected 42501)`                                                                                                 | **refused**: SQLSTATE `42501`, must be owner of database company_x                                                                      | 3.2    |
| drop database as the owner                                               | `SET ROLE company_x; DROP DATABASE company_x; RESET ROLE`                                                                                                               | ok                                                                                                                                      | 40.7   |
| drop role                                                                | `DROP ROLE company_x`                                                                                                                                                   | ok                                                                                                                                      | 35.7   |
| nologin variant with self-grant                                          | `SET createrole_self_grant = 'set'; CREATE ROLE company_y NOLOGIN; CREATE DATABASE company_y OWNER company_y; SET ROLE company_y; DROP DATABASE; RESET ROLE; DROP ROLE` | membership patchy_admin: admin=true set=false inherit=false; patchy_admin: admin=false set=true inherit=false; owner company_y; dropped | 180.6  |
| create database inside a transaction                                     | `BEGIN; CREATE DATABASE company_z (expected 25001)`                                                                                                                     | **refused**: SQLSTATE `25001`, CREATE DATABASE cannot run inside a transaction block                                                    | 8.0    |

## Idle connection vs autosuspend (fargate, up to 8 min)

Other client backends when the idle connection opened: cloud_admin/compute_ctl:compute_monitor/idle x1, cloud_admin/neon_compute_sql_exporter/idle x1, cloud_admin/postgres-exporter/idle x1, cloud_admin/vm-monitor/idle x1, patchy_admin//idle x2, patchy_admin/neon-bench-fargate/idle x1. If another lane holds connections, they could either keep the compute awake or be dropped by the suspend along with ours.

| minute | endpoint state | idle socket |
| ------ | -------------- | ----------- |
| 0.0    | active         | open        |
| 0.5    | active         | open        |
| 1.0    | active         | open        |
| 1.5    | active         | open        |
| 2.0    | active         | open        |
| 2.5    | active         | open        |
| 3.0    | active         | open        |
| 3.5    | active         | open        |
| 4.0    | active         | open        |
| 4.5    | active         | open        |
| 5.0    | active         | open        |
| 5.5    | active         | open        |
| 6.0    | active         | open        |
| 6.5    | active         | open        |
| 7.0    | active         | open        |
| 7.5    | active         | open        |
| 8.0    | active         | open        |

- Compute did **not** suspend within 8 min while one idle (not in transaction) connection stayed open.
- `SELECT 1` on the idle connection afterwards: succeeded.

## Cleanup (fargate)

- Dropped `neon_bench` and the provisioning leftovers. Databases now: patchy, postgres, template0, template1. Roles now: cloud_admin, neon_service, neon_superuser, patchy_admin.
- Endpoint state at exit: `active`. Total run 10.3 min.
  file:///app/bench.ts:85
  throw new Error(`operation ${op.action} ${s}`);
  ^
  Error: operation start_compute skipped
  at waitOps (file:///app/bench.ts:85:15)
  at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
  at async endpointAction (file:///app/bench.ts:94:3)
  at async stepRestart (file:///app/bench.ts:1069:13)
  at async file:///app/bench.ts:1142:34
  Node.js v24.21.0

# Local run, raw output

From Allison's machine (about 105 ms from us-east-1), same script, same steps except one cold cycle instead of five, and no idle watch or forced restart (those hit the other lane more than once for no new information).

## 1a. Round trip, warm compute (local, n=50)

Endpoint state before: `active`.
Resolved `ep-rough-base-b7yg8olj.c-13.us-east-1.aws.neon.tech` to `34.205.173.201`. Each iteration: a DNS lookup, a raw TCP+SSLRequest+TLS handshake (no auth, closed), then a fresh `pg` `connect()` (its own DNS+TCP+TLS+SASL auth), `SELECT 1` twice, `end()`. "auth (derived)" is pg connect minus the separately measured DNS+TCP+SSLRequest+TLS, so it also absorbs any variance between the two handshakes.

| measure                               | n   | min    | p50    | p95    | p99    | max    | mean   |
| ------------------------------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| DNS lookup                            | 50  | 0.5    | 0.7    | 0.9    | 1.4    | 1.4    | 0.7    |
| TCP connect (raw)                     | 50  | 103.3  | 108.0  | 162.0  | 182.8  | 182.8  | 117.7  |
| SSLRequest round trip (raw)           | 50  | 101.6  | 106.9  | 163.8  | 173.1  | 173.1  | 115.9  |
| TLS handshake (raw)                   | 50  | 106.2  | 115.4  | 160.3  | 167.0  | 167.0  | 122.9  |
| pg connect() total (DNS+TCP+TLS+auth) | 50  | 634.3  | 667.3  | 791.3  | 801.7  | 801.7  | 689.9  |
| auth (derived)                        | 50  | 199.5  | 333.3  | 434.0  | 435.5  | 435.5  | 332.7  |
| first SELECT 1                        | 50  | 103.4  | 107.8  | 149.5  | 164.3  | 164.3  | 113.1  |
| second SELECT 1                       | 50  | 103.4  | 107.4  | 156.3  | 164.7  | 164.7  | 114.3  |
| iteration total                       | 50  | 1268.7 | 1377.7 | 1572.2 | 1685.2 | 1685.2 | 1388.5 |

## 1b. Round trip, cold compute (local, n=1 suspend cycles)

Each cycle: `POST .../suspend` and wait for its operation, wait 3 s, read the endpoint state, then a DNS lookup, a raw TCP+TLS handshake to the proxy (no auth), a fresh `pg` `connect()` (this is where the proxy wakes the compute), `SELECT 1`, `end()`. If the state before connecting is not `idle`, something else (the other lane's pool) woke the compute first and the cycle is not cold.

| cycle | suspend API | suspend op done | state before connect | DNS | raw TCP | raw TLS | pg connect() (includes wake) | first SELECT 1 | second SELECT 1 | state after |
| ----- | ----------- | --------------- | -------------------- | --- | ------- | ------- | ---------------------------- | -------------- | --------------- | ----------- |
| 1     | 235.5       | 1727.0          | idle                 | 0.8 | 104.5   | 107.8   | 1183.2                       | 112.0          | 104.5           | active      |

| measure                         | n   | min    | p50    | p95    | p99    | max    | mean   |
| ------------------------------- | --- | ------ | ------ | ------ | ------ | ------ | ------ |
| cold pg connect() (wake + auth) | 1   | 1183.2 | 1183.2 | 1183.2 | 1183.2 | 1183.2 | 1183.2 |
| cold first SELECT 1             | 1   | 112.0  | 112.0  | 112.0  | 112.0  | 112.0  | 112.0  |

## 2a. Ten-callback SERIALIZABLE mutation, warm, one reused connection (local, n=100)

Connection opened in 642.7 ms and reused (a pooled host connection). Each mutation is `BEGIN ISOLATION LEVEL SERIALIZABLE`, ten statements (list, insert, read-own-write, update, read-own-write, insert, update, count, counter update, counter read), `COMMIT`: 12 round trips.

| measure                                     | n    | min    | p50    | p95    | p99    | max    | mean   |
| ------------------------------------------- | ---- | ------ | ------ | ------ | ------ | ------ | ------ |
| mutation total (12 round trips)             | 100  | 1244.2 | 1253.2 | 1425.8 | 1501.7 | 1507.6 | 1280.4 |
| per-statement round trip (all 12 positions) | 1200 | 102.6  | 104.4  | 122.9  | 142.2  | 188.4  | 106.7  |
| 1. BEGIN SERIALIZABLE                       | 100  | 102.6  | 104.2  | 122.3  | 145.4  | 188.4  | 107.1  |
| 2. SELECT list (20 rows)                    | 100  | 103.1  | 104.5  | 122.5  | 149.0  | 151.0  | 106.9  |
| 3. INSERT RETURNING                         | 100  | 102.8  | 104.3  | 123.5  | 152.4  | 172.3  | 107.1  |
| 4. SELECT own write                         | 100  | 103.0  | 104.5  | 125.7  | 139.7  | 148.8  | 107.3  |
| 5. UPDATE RETURNING                         | 100  | 103.1  | 104.4  | 123.6  | 139.4  | 140.0  | 106.9  |
| 6. SELECT own write                         | 100  | 102.8  | 104.4  | 109.3  | 136.2  | 137.7  | 105.8  |
| 7. INSERT RETURNING                         | 100  | 103.1  | 104.3  | 111.5  | 122.4  | 133.1  | 105.3  |
| 8. UPDATE two rows                          | 100  | 102.9  | 104.1  | 124.8  | 145.5  | 155.7  | 107.0  |
| 9. SELECT count                             | 100  | 102.9  | 104.6  | 122.7  | 135.2  | 138.1  | 107.0  |
| 10. UPDATE counter                          | 100  | 102.9  | 104.3  | 120.1  | 136.5  | 143.5  | 105.9  |
| 11. SELECT counter                          | 100  | 102.8  | 104.2  | 121.1  | 142.2  | 150.9  | 106.2  |
| 12. COMMIT                                  | 100  | 103.8  | 105.1  | 128.6  | 140.0  | 143.4  | 107.9  |

## 2b. Contention on one counter row, SERIALIZABLE read-then-write, retry on 40001 (local)

Each slot loops `BEGIN SERIALIZABLE; SELECT n; UPDATE n = read+1; COMMIT` on its own connection for 30 s; a `40001` rolls back and retries. Correct means the final counter equals start + commits.

| slots | seconds | attempts | commits | 40001s | 40001 at UPDATE | 40001 at COMMIT | other errors | commits/s | commit p50 | commit p95 | commit p99 | counter start -> end | correct |
| ----- | ------- | -------- | ------- | ------ | --------------- | --------------- | ------------ | --------- | ---------- | ---------- | ---------- | -------------------- | ------- |
| 4     | 30      | 283      | 87      | 196    | 196             | 0               | 0            | 2.9       | 423.3      | 432.0      | 460.6      | 0 -> 87              | true    |
| 2     | 30      | 143      | 72      | 71     | 71              | 0               | 0            | 2.4       | 421.3      | 428.8      | 441.1      | 87 -> 159            | true    |

## 2c. Confirmed 40001, deterministic: two transactions read then write the same row (local)

- A read 0, B read 0; A wrote 1 and committed.
- B's UPDATE failed: SQLSTATE `40001`, `could not serialize access due to concurrent update`.
- B retried from the top: read 1, wrote 2, committed. Counter 0 -> 2; correct: true.

## 2d. Cancellation: client-side CancelRequest and the five-second statement_timeout race (local)

- BackendKeyData from the proxy: process id 158711246, secret key nonzero; the real backend pid is 4742, so the proxy hands out its own cancel key and maps it.
- (i) pg's plaintext `CancelRequest` sent at 1.0 s into `pg_sleep(10)` inside `BEGIN`: statement ended after 1215.8 ms (215.2 ms after the cancel), SQLSTATE `57014`, `canceling statement due to user request`.
  - after the error: state=`idle in transaction (aborted)` from a second connection; transaction status on the client: `E`.
  - after `ROLLBACK` + `end()`: gone (no pg_stat_activity row).
- (ii) `SET LOCAL statement_timeout = '5000'` and a client timer at 5000 ms around `pg_sleep(10)` in a SERIALIZABLE transaction with one insert: fired first: **server statement_timeout**; statement ended after 5105.9 ms (client cancel sent at 5003.3 ms), SQLSTATE `57014`, `canceling statement due to statement timeout`.
  - after the error: state=`idle in transaction (aborted)`; client transaction status `E`.
  - `COMMIT` on the aborted transaction: accepted (Postgres turns it into ROLLBACK, command tag would say so).
  - after `end()`: gone (no pg_stat_activity row); rows named `cancel-race` in the table: 0 (transaction gone, nothing landed).

## 2e. Lost commit reply (local)

- (a) via a local TCP proxy that forwards `COMMIT` and drops the reply, then destroys the socket: client saw after 300.8 ms: `Error`: `Connection terminated unexpectedly`; from a second connection the row is **present** (the commit landed). The client could not tell: `unknown_outcome`.
- (b) `query("COMMIT")` then `stream.destroy()` in the same tick on the direct TLS socket: client saw after 0.5 ms: `Error`: `Connection terminated unexpectedly`; row **absent** (destroy discarded the buffered COMMIT; the server rolled back on disconnect). Same client-side signal either way.

## 4. ADR-0009 provisioning path under neon_superuser (local)

| step                                                                     | statement                                                                                                                                                               | result                                                                                                                                  | ms     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| create login role                                                        | `CREATE ROLE company_x LOGIN PASSWORD '...'`                                                                                                                            | ok                                                                                                                                      | 144.9  |
| membership granted to creator                                            | `SELECT ... FROM pg_auth_members WHERE roleid = 'company_x'`                                                                                                            | patchy_admin: admin=true set=false inherit=false                                                                                        | 103.5  |
| create database owned (first try)                                        | `CREATE DATABASE company_x OWNER company_x`                                                                                                                             | **refused**: SQLSTATE `42501`, must be able to SET ROLE "company_x"                                                                     | 103.1  |
| grant SET to the creator                                                 | `GRANT company_x TO patchy_admin WITH SET TRUE`                                                                                                                         | ok                                                                                                                                      | 130.0  |
| membership after the grant (INHERIT defaults to the grantee's attribute) | `SELECT ... FROM pg_auth_members WHERE roleid = 'company_x'`                                                                                                            | patchy_admin: admin=true set=false inherit=false; patchy_admin: admin=false set=true inherit=true                                       | 103.8  |
| create database owned (after the grant)                                  | `CREATE DATABASE company_x OWNER company_x`                                                                                                                             | ok                                                                                                                                      | 159.1  |
| verify owner                                                             | `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'company_x'`                                                                                           | company_x                                                                                                                               | 103.9  |
| admin connects to company_x                                              | `connect(database=company_x) as patchy_admin`                                                                                                                           | ok                                                                                                                                      | 650.8  |
| set role                                                                 | `SET ROLE company_x`                                                                                                                                                    | current_user=company_x session_user=patchy_admin                                                                                        | 211.2  |
| create table as company_x                                                | `CREATE TABLE t (id int)`                                                                                                                                               | owner company_x                                                                                                                         | 218.0  |
| create schema as company_x                                               | `CREATE SCHEMA patchy`                                                                                                                                                  | owner company_x                                                                                                                         | 217.4  |
| reset role                                                               | `RESET ROLE`                                                                                                                                                            | patchy_admin                                                                                                                            | 212.3  |
| admin reads the table without INHERIT                                    | `SELECT count(*) FROM t (as patchy_admin)`                                                                                                                              | 0                                                                                                                                       | 107.3  |
| company_x logs in                                                        | `connect(user=company_x, database=company_x)`                                                                                                                           | ok, inserted id 1                                                                                                                       | 847.4  |
| revoke membership                                                        | `REVOKE company_x FROM patchy_admin`                                                                                                                                    | ok                                                                                                                                      | 131.5  |
| set role after revoke                                                    | `SET ROLE company_x (expected to fail)`                                                                                                                                 | **refused**: SQLSTATE `42501`, permission denied to set role "company_x"                                                                | 877.9  |
| drop database without membership                                         | `DROP DATABASE company_x (as patchy_admin, CREATEDB, not a member)`                                                                                                     | **refused**: SQLSTATE `42501`, must be owner of database company_x                                                                      | 102.7  |
| re-grant SET only (creator holds ADMIN OPTION)                           | `GRANT company_x TO patchy_admin WITH SET TRUE, INHERIT FALSE`                                                                                                          | ok                                                                                                                                      | 129.8  |
| drop database with SET only                                              | `DROP DATABASE company_x (member with SET, no INHERIT; expected 42501)`                                                                                                 | **refused**: SQLSTATE `42501`, must be owner of database company_x                                                                      | 102.7  |
| drop database as the owner                                               | `SET ROLE company_x; DROP DATABASE company_x; RESET ROLE`                                                                                                               | ok                                                                                                                                      | 340.2  |
| drop role                                                                | `DROP ROLE company_x`                                                                                                                                                   | ok                                                                                                                                      | 130.8  |
| nologin variant with self-grant                                          | `SET createrole_self_grant = 'set'; CREATE ROLE company_y NOLOGIN; CREATE DATABASE company_y OWNER company_y; SET ROLE company_y; DROP DATABASE; RESET ROLE; DROP ROLE` | membership patchy_admin: admin=true set=false inherit=false; patchy_admin: admin=false set=true inherit=false; owner company_y; dropped | 1154.0 |
| create database inside a transaction                                     | `BEGIN; CREATE DATABASE company_z (expected 25001)`                                                                                                                     | **refused**: SQLSTATE `25001`, CREATE DATABASE cannot run inside a transaction block                                                    | 310.7  |
