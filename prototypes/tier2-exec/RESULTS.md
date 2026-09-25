<!-- PROTOTYPE for #311 -->

# Results: tier 2 execution-service spike on ECS Fargate

Measured 2026-09-25 from the hosting side. "host-side" means the host task's own clock around the step (returned as `timing` on `/invoke`); "laptop" means wall time from this machine through the ALB over TLS (adds about 100-350 ms of internet round trip and is not a property of the design). Task sizes: host 0.5 vCPU / 1 GB, exec 0.5 vCPU / 1 GB; the alloc test never needed more. Pool size 2, idle release 60 s, four slots per company, 5 s deadline, exec watchdog 4.5 s, RSS bound 512 MB.

## 1. Cold start (fresh task outside the pool, n = 3)

| step (ms, host-side)             | n   | p50   | p95   | p99   | max   |
| -------------------------------- | --- | ----- | ----- | ----- | ----- |
| RunTask to RUNNING               | 3   | 23619 | 26067 | 26067 | 26067 |
| RunTask to supervisor healthy    | 3   | 23923 | 26075 | 26075 | 26075 |
| bind (load the company's Worker) | 3   | 19    | 55    | 55    | 55    |
| Worker load inside bind          | 3   | 5     | 7     | 7     | 7     |
| first invoke after bind          | 3   | 6     | 31    | 31    | 31    |
| RunTask to first invoke          | 3   | 24007 | 26119 | 26119 | 26119 |

Individual RunTask-to-RUNNING: 22.5 s, 23.6 s, 26.1 s. The pool's own tasks over the run: 22.5-27.9 s. workerd itself is ready 24-127 ms after the supervisor starts; the 23 s is Fargate (ENI, image pull of the 140 MB layer through the ECR endpoints, container start).

## 2. Bind on a pre-started task (first open for a fresh company, n = 5)

| step (ms)                     | n   | p50 | p95 | p99 | max |
| ----------------------------- | --- | --- | --- | --- | --- |
| bind round trip (host-side)   | 5   | 16  | 18  | 18  | 18  |
| Worker load inside bind       | 5   | 4   | 5   | 5   | 5   |
| exec hop for the first invoke | 5   | 6   | 8   | 8   | 8   |
| first open total (host-side)  | 5   | 26  | 55  | 55  | 55  |
| first open total (laptop)     | 5   | 341 | 367 | 367 | 367 |

Bind versus cold: **16 ms against 24 s**, three orders of magnitude. The pre-started pool is the whole wake path.

## 3. Simultaneous first opens

| case                       | bind ms | bound after ms | total host-side ms | laptop ms |
| -------------------------- | ------- | -------------- | ------------------ | --------- |
| company a (pool of two)    | 25      | 28             | 68                 | 410       |
| company b (same instant)   | 19      | 19             | 31                 | 377       |
| company c (pool now empty) | 16      | 35407          | 35483              | 35590     |

Both simultaneous opens took a ready task each. The third waited for the replacement task the pool had already started (35.4 s, which is one cold start plus the poll cadence): with the pool empty, first open is a page load that takes half a minute.

## 4. Warm invocation (n = 100 each, host-side unless marked)

| contacts.ping, no callbacks (ms) | n   | p50 | p95 | p99 | max |
| -------------------------------- | --- | --- | --- | --- | --- |
| exec hop (host to exec and back) | 100 | 5   | 19  | 40  | 40  |
| guest time inside workerd        | 100 | 1   | 1   | 8   | 8   |
| invocations row on Neon          | 100 | 4   | 6   | 13  | 13  |
| total host-side                  | 100 | 9   | 26  | 44  | 44  |
| laptop                           | 100 | 115 | 141 | 178 | 178 |

| contacts.list, one callback (ms)                            | n   | p50 | p95 | p99 | max |
| ----------------------------------------------------------- | --- | --- | --- | --- | --- |
| exec hop                                                    | 100 | 13  | 17  | 34  | 34  |
| guest time                                                  | 100 | 9   | 11  | 29  | 29  |
| callback (exec to host to Neon and back)                    | 100 | 7   | 8   | 17  | 17  |
| of which SQL (two statements: the op + its attribution row) | 100 | 7   | 8   | 17  | 17  |
| total host-side                                             | 100 | 17  | 21  | 38  | 38  |
| laptop                                                      | 100 | 126 | 165 | 179 | 179 |

## 5. Ten-callback mutation `contacts.createMany` (n = 60, end to end including commit)

| step (ms)                             | n   | p50    | p95     | p99     | max |
| ------------------------------------- | --- | ------ | ------- | ------- | --- |
| invocations row                       | 60  | 4      | 5       | 5       | 5   |
| exec hop (contains the ten callbacks) | 60  | 84     | 97      | 108     | 108 |
| ten callbacks, summed                 | 60  | 65     | 73      | 81      | 81  |
| of which SQL, summed                  | 60  | 58     | 67      | 73      | 73  |
| COMMIT                                | 60  | 4      | 4       | 4       | 4   |
| **total host-side**                   | 60  | **92** | **106** | **116** | 116 |
| laptop                                | 60  | 199    | 213     | 430     | 430 |

60 of 60 committed, no retries. One run's breakdown (total 90 ms): invocations row 4, exec hop 82 (guest 78: 5 inserts 12/6/6/6/5, list 6, 4 updates 6/5/5/6, each callback 5-6 ms of which SQL 5-6), commit 4. Every callback is two Neon statements (the table op and its `operations` row); the exec-to-host hop inside the VPC costs under 1 ms of the 6.

Attribution, same table:

| invocation            | as               | principal written on the invocation and each of its 10 operation rows |
| --------------------- | ---------------- | --------------------------------------------------------------------- |
| contacts.createMany   | viewer           | `user:allison`                                                        |
| contacts.createMany   | patch            | `patch:crm`                                                           |
| contacts.createMany   | viewer-via-patch | `user:allison via patch:crm`                                          |
| contacts.list (query) | viewer           | `user:allison`                                                        |

## 6. `contacts.createThenFail`

| rows before | callbacks before the throw | outcome                    | rows after | operation rows kept | total ms |
| ----------- | -------------------------- | -------------------------- | ---------- | ------------------- | -------- |
| 5           | 3 inserts                  | `handler_failed`, ROLLBACK | 5          | 0                   | 37       |

## 7. Contention and the slot cap

Two sequential writers (25 `contacts.bump` each, 15 ms transactions against a 120 ms client round trip) never overlapped: 50 committed, 0 retries, counter 50. With overlap forced (20 pairs of concurrent `contacts.bumpSlow`, a 30 ms host-side pause between the read and the write):

|                                                                    | value                    |
| ------------------------------------------------------------------ | ------------------------ |
| invocations                                                        | 40                       |
| committed                                                          | 40 (counter 40, correct) |
| confirmed `40001` on attempt 1, re-invoked, committed on attempt 2 | 19                       |
| attempts > 2                                                       | 0                        |
| total ms, first-try (n = 21)                                       | p50 59, p95 86           |
| total ms, retried (n = 19)                                         | p50 132, p95 148         |

The conflict surfaced inside the callback (`could not serialize access due to concurrent update` on the UPDATE), never at COMMIT. Slot cap: five concurrent `contacts.slow(2000)` on one company: four committed (2.1 s each), the fifth got `busy` in 316 ms laptop time (no exec hop).

## 8. Memory per concurrent invocation (one task, slot cap raised to 64)

| in flight (`contacts.slow` 4 s) | workerd RSS MB | supervisor RSS MB | per invocation MB |
| ------------------------------- | -------------- | ----------------- | ----------------- |
| idle                            | 53             | 102               |                   |
| 1                               | 53             | 102               | 0                 |
| 10                              | 56             | 102               | 0.3               |
| 50                              | 62             | 102               | 0.18              |

All 61 committed. A second isolate (patch `other`) costs about the same as the first; the Node supervisor is twice the size of workerd.

## 9. Neighbour

Baseline ping totals: B (same company, same task, other patch) p50 9 ms; C (other company, other task) p50 9 ms.

`abuse.loop` in patch A:

| what              | result                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A's caller saw    | `watchdog_killed:wall_clock` after 4522 ms (`abuse.loop ran 4512 ms > 4500 ms`)                                                                                                                                                                   |
| watchdog reaction | kill at 4.5 s, workerd back in 36 ms (generation 2), bundles re-sent on the next invoke                                                                                                                                                           |
| B during the loop | first three pings queued behind the loop and died with the kill after 4313 / 4018 / 3523 ms; the next seven were refused `busy` in ~107 ms (the four slots were full: the loop plus three stuck pings); back to 28 ms then 8 ms after the restart |
| C during the loop | 7-37 ms, unaffected                                                                                                                                                                                                                               |

`abuse.alloc` in patch A, three calls:

| call | outcome                                                                    | workerd RSS after |
| ---- | -------------------------------------------------------------------------- | ----------------- |
| 1    | committed, 200 MB held                                                     | 255 MB            |
| 2    | committed, 400 MB held                                                     | 456 MB            |
| 3    | `watchdog_killed:rss` (`550 MB > 512 MB`) 70 ms in; workerd back in 110 ms | 39 MB             |

B and C during the allocations: 7-23 ms, unaffected. `limits: { cpuMs: 100 }` passed on `getEntrypoint` is accepted and changes nothing: the loop ran until the watchdog. Open-source workerd enforces no limits, as the research said.

## 10. Containment

From handler code (`globalOutbound` bound to the loader's refusing loopback):

| probe                                      | result                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `http://169.254.170.2/v2/metadata`         | 403 from the loopback (`refused`), never left workerd                             |
| `http://169.254.169.254/latest/meta-data/` | 403 from the loopback                                                             |
| `https://example.com`                      | 403 from the loopback                                                             |
| `connect("example.com:443")`               | `Error: proxy request failed, cannot connect` (routed to the loopback, no tunnel) |
| `file:///etc/passwd`                       | `TypeError: Fetch API cannot load: file:///etc/passwd`                            |
| `import("node:fs")`                        | `Error: No such module "node:fs"` (no `nodejs_compat` on the guest)               |

From the supervisor process (what the ENI + `exec-bootstrap` SG allow the container):

| probe                        | result                                                         |
| ---------------------------- | -------------------------------------------------------------- |
| task metadata `/v4/.../task` | 200 (cluster and task ARN visible)                             |
| `/v2/credentials`            | 404 (no task role, nothing to hand out)                        |
| IMDS `169.254.169.254`       | `EINVAL`, unreachable                                          |
| `https://example.com`        | `ETIMEDOUT` (no route, SG egress is 443 to the endpoints only) |
| `/etc/passwd`                | readable (it is the container's own filesystem)                |

Sealed SG (`tier2-spike-exec-sealed`, no egress): the task sat in PENDING while the agent retried, then STOPPED after **4 min 49 s** with `TaskFailedToStart`: `ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. ... operation error ECR: GetAuthorizationToken, exceeded maximum number of attempts, 3, ... dial tcp 10.42.10.15:443: i/o timeout`. The patch-facing seal has to live inside the container (the loopback), with the ENI keeping the bootstrap rule.

## 11. Capability replay

| call                                            | status | body                                       |
| ----------------------------------------------- | ------ | ------------------------------------------ |
| replay of the invocation's token after it ended | 403    | `capability_refused`, `invocation_ended`   |
| unknown token                                   | 403    | `capability_refused`, `unknown_capability` |

## 12. Ingress through the ALB (443, self-signed cert)

| check                                                                                  | result                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seven SSE streams, one Chromium, HTTP/2                                                | all seven opened; after 6 s: 6/6/6/6/6/6/5 ticks; the seventh kept flowing (9 ticks)                                                                                                                                                                                                                                                                                                                 |
| seven SSE streams, one Chromium, `--disable-http2` (HTTP/1.1)                          | six opened and flowed (15-18 ticks in 6 s); the seventh page could not even navigate (blocked 10 s behind the six-connections-per-host limit); after closing one stream it opened and flowed (3 ticks in 4 s)                                                                                                                                                                                        |
| one stream held over HTTP/2                                                            | 329 ticks in 330 s, no disconnect (idle timeout 3600 s)                                                                                                                                                                                                                                                                                                                                              |
| deployment drain (`deploy.sh` with a new host task definition while a stream was open) | stream opened 15:50:23 on the old host; deploy began 15:50:25; new host up 15:51:12; ticks continued until 15:52:52 (149 ticks), then the ALB closed the connection cleanly at the end of the 30 s deregistration delay. The client saw EOF, no error and no `bye` event: the ALB cut the connection before ECS sent SIGTERM. Clients need reconnect logic; the server's goodbye never reaches them. |

## 13. Observability

| what                                                         | result                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| how logs were read                                           | `aws logs tail /patchy/tier2-spike --since 5m --format short` (host and exec streams interleaved under prefixes `host/` and `exec/`), `filter-log-events` with `--filter-pattern` for one line                                                                                                                                                                     |
| ingestion lag (`ingestionTime - timestamp`, last 200 events) | p50 4.3 s, p95 4.7 s, max 5.0 s                                                                                                                                                                                                                                                                                                                                    |
| event to visible in `aws logs tail`                          | 8.2 s                                                                                                                                                                                                                                                                                                                                                              |
| what could not be seen                                       | which exec task a company is bound to (only the host's in-memory pool knows; the `/admin/pool` endpoint exists for that reason); RSS of workerd (only via the supervisor's `/stats`); which invocation a guest `console.log` belongs to (workerd prints them without context); the sealed task's failure only in `describe-tasks` (no log stream was ever created) |

## What held and what did not

Held: the Worker Loader boundary (one dynamic Worker per company/patch/version, cached, `globalOutbound` to a refusing loopback, callbacks over a props stub with no token in the guest); the transaction-per-mutation on Neon (10 callbacks in 92 ms p50, rollback, `40001` retried to correct totals, replay refused, `busy` at the cap); the wake path (bind 16 ms on a pre-started task against 24 s cold); per-invocation memory in the tenths of a megabyte; company C untouched by A's abuse.

Did not: **a runaway patch takes its whole company down for the watchdog budget.** workerd runs every isolate in the task on one thread and enforces no limits, so B's requests queued behind A's loop and died with the kill, and the slot cap then turned B away for the rest of the budget. The supervisor is a coarse tool (kill the process, lose every in-flight invocation, resend bundles); Cloudflare's per-isolate CPU interrupt has no open-source equivalent. The exec watchdog fires at 4.5 s, so a mutation that legitimately needs 4 s shares the process with nothing else that needs to respond in that window. Cold start is 24 s, so the pool must never be empty; the third simultaneous open waited 35 s. The ALB drain cuts streams without the server's goodbye.

## Awkward

- **Two SG rules added by hand** (allowed on `patchy:spike=tier2` resources): `sgr-007af4eca5e58ab10` host ingress tcp/8080 from `tier2-spike-exec-bootstrap` (callbacks), `sgr-0ac3333c8ee26a5c6` exec-bootstrap egress tcp/8080 to `tier2-spike-host`. Left in place.
- **The host holds the disposable IAM user's keys in task-definition environment** to call `RunTask`/`StopTask`/`DescribeTasks`; the empty host task role would be the right place (needs `ecs:RunTask`, `ecs:StopTask`, `ecs:DescribeTasks`, `iam:PassRole` for the execution role). Spike shortcut; `deploy.sh` writes them into the registered task definition, which anyone with `ecs:DescribeTaskDefinition` can read.
- **The pool is in the host's memory.** A host redeploy orphaned its two exec tasks (the old image had no cleanup); the second host image stops its tasks on SIGTERM, and `destroy.sh` stops anything left by family. Production needs the binding table somewhere durable and a reaper.
- **The `workerd` npm bin is a Node shim.** Killing it leaves the real binary running and bound to its port; the supervisor spawns `@cloudflare/workerd-linux-64/bin/workerd` directly and respawns only after the old child's `exit` event.
- **`globalOutbound` is fixed at Worker load time**, so it cannot carry a per-invocation capability; the token rides in a loopback stub passed through `getEntrypoint(..., { props })` instead, which turned out cleaner (no token or invocation id ever crosses the isolate boundary as data the guest could alter).
- **The loader's code callback runs lazily**, so a missing bundle after a workerd restart surfaced as a 500 inside the first invoke, not a 409; the loader checks up front now and the host resends the bundle (5 KB) on `bundle_required` or a generation change.
- **The fetch guard in Node** (undici) times out response headers at 300 s, so the sealed-SG check (4 min 49 s) has to be read from `describe-tasks`; ECS itself gives no earlier signal than the stop.
- **Fargate cold start is 22-28 s** with a 140 MB layer already through the VPC endpoints; every measurement that touched a fresh task was dominated by it, and `describe-tasks` polling every 500 ms is the only way to learn a task's private IP.
- **Logs arrive 4-8 s late** and workerd's guest `console.log` lines carry no invocation context.
- **crane instead of docker** worked (2m16s for both images, exec layer 133 MB from `npm install`), but the tarball must be rooted at `app/` and `crane mutate` must set entrypoint, cmd and workdir separately; `crane config` is the only way to check.
- **Chromium under HTTP/1.1** blocks even the seventh page's navigation, not just its stream, so the Playwright check had to treat a navigation timeout as the result.
- The IAM user has `ecs:*` in us-east-1 but no `ecs:ExecuteCommand`, so nothing could be inspected inside a task except through the supervisor's own `/probe` and `/stats`.

## What is left running

Nothing from this lane: `destroy.sh` deleted service `tier2-spike-host` and stopped every `tier2-spike-exec` task; `aws ecs list-tasks` and `list-services` on `patchy-tier2-spike` are empty of these names. Task definitions `tier2-spike-exec:1-2` and `tier2-spike-host:1-2`, the images (`exec-20260925172715`, `host-20260925172715`, `host-20260925174736`, `host-20260925174900`), and the two SG rules remain.

## Round 2

Measured 2026-09-25 (second pass) on the same branch; astra's closure conditions from round 1, items numbered as in the brief. Same sizes as round 1 (host 0.5 vCPU / 1 GB, exec 0.5 vCPU / 1 GB), host deadline 5 s, exec watchdog now 6 s (so idle waits expire on the host first and the deadline path is what gets measured), RSS bound 512 MB per workerd process, `PROCESS_IDLE_MS` 60 s.

### 1. Process per patch version versus one process per company

`PROCESS_MODE=company` (round 1: one workerd, every patch version an isolate in it) against `PROCESS_MODE=patch` (one workerd per loaded company/patch@version, spawned on first invoke, reaped after 60 s idle with nothing in flight, restarted alone when it overruns). Same company, same task type, measured in sequence; B is `contacts.list` (one callback) fired every 50 ms (~20 req/s) from the laptop for the whole window, `/stats` polled every 250 ms; latencies are host-side `totalMs` (laptop wall time is about +110 ms).

**Same-task interference, `abuse.loop` in patch A for a 9 s window**

|                                                               | company mode                                                                           | patch mode                                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| B requests / committed / errors                               | 179 / 58 / **121** (`busy` 114, `watchdog_killed` 4, `handler_timeout` 3)              | 179 / 177 / **2** (`busy` 2)                                                                |
| B latency, committed only, p50 / p95 / p99 (ms)               | 14 / 23 / 74                                                                           | 17 / 73 / 105                                                                               |
| B latency before the kill, all outcomes, p50 / p95 / p99 (ms) | 110 / 725 / 5001 (mostly instant `busy`; the four that got a slot stalled to the kill) | 44 / 83 / 329                                                                               |
| `/stats` latency p50 / p99 (ms, laptop)                       | 112 / 329                                                                              | 112 / 385                                                                                   |
| kill                                                          | wall clock at 6118 ms, the one process, **8 invocations in flight lost**               | wall clock at 6153 ms, `acme/crm@v1` only, 1 in flight lost                                 |
| restart / recovery (first committed B after the kill)         | 27 ms / 32 ms                                                                          | 103 ms / 39 ms                                                                              |
| A's caller saw                                                | `handler_timeout` at 5001 ms                                                           | `handler_timeout` at 5005 ms                                                                |
| CPU (0.5 vCPU shared with a spinning process)                 | n/a, B never ran                                                                       | B **degraded, did not stall**: p50 17 -> 44 ms while the loop spun, p99 329 ms, no timeouts |

**Same-task interference, `abuse.alloc` x3 in patch A (6 s window)**

|                                            | company mode                                                    | patch mode                                                                          |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| B requests / committed / errors            | 120 / 115 / 5 (`busy` 3, `watchdog_killed` 2)                   | 119 / 119 / **0**                                                                   |
| B latency, committed, p50 / p95 / p99 (ms) | 14 / 158 / 253                                                  | 15 / 42 / 56                                                                        |
| peak aggregate RSS seen by `/stats` (MB)   | 638                                                             | 666                                                                                 |
| kill                                       | rss (571 MB > 512) at 1046 ms, restart 107 ms, 3 in flight lost | rss (522 MB > 512) at 1197 ms, `acme/crm@v1` only, restart 104 ms, 1 in flight lost |
| A's caller saw                             | `watchdog_killed:rss`                                           | `watchdog_killed:rss`                                                               |

**Spawn cost: first invoke of a not-yet-loaded version (v2..v20, n = 19)**

| ms                                             | company (isolate in the shared process) | patch (new workerd process + isolate) |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------- |
| first invoke exec hop p50 / p95 / max          | 8 / 10 / 10                             | 32 / 40 / 40                          |
| of which process spawn to healthy (supervisor) | (28, the one process at task start)     | 21 / 27 / 27                          |
| second invoke exec hop p50 / p95               | 4 / 6                                   | 4 / 7                                 |

**Memory: aggregate RSS (all workerd + supervisor) with N versions loaded, each one warm invoke**

| versions loaded | company: processes / workerd MB / supervisor MB / aggregate MB | patch: processes / workerd MB / supervisor MB / aggregate MB |
| --- | --- | --- | --- |
| 1 | 1 / 79 / 111 / 190 | 1 / 45 / 87 / 132 |
| 5 | 1 / 80 / 112 / 192 | 5 / 224 / 103 / 327 |
| 10 | 1 / 80 / 112 / 192 | 10 / 449 / 105 / 554 |
| 20 | 1 / 81 / 112 / 193 | 20 / 899 / 107 / **1006** |

About 0.15 MB per extra isolate in company mode against about 45 MB per process in patch mode; twenty loaded processes fill the 1 GB task. Idle reap verified on the task: 21 processes (v1..v20 + patch `other`) went to 1 after the 60 s window while `other` was kept alive by a ping every 20 s; all twenty `crm` processes reaped at 60.0-60.1 s idle; the next invoke of a reaped version respawned it in 40 ms (spawn 23 ms). In the scripted run the host's own 60 s idle timer had already released the whole task, which is why that check had to be repeated by hand.

**What the process-per-patch cut broke:** nothing in the capability or callback path. The loader, the props stub and the refusing outbound are per process and unchanged; the supervisor routes `/bind` and `/invoke` by worker name, each process gets its own localhost port and generation, and the host's bundle-resend logic (409 `bundle_required` or a generation change) already covered a reaped process. Two things to note: the per-process generation means the host's `task.generation` is now per name (the host resends the bundle on 409 either way, one extra hop after a reap), and a kill in patch mode loses only that process's in-flight invocations, so `watchdog_killed` stops being collateral for siblings.

### 2. Deadline cleanup

Deadline 5 s on the host (timer + transaction-scoped `statement_timeout` + `pg_cancel_backend` on expiry); exec watchdog moved to 6 s so idle waits expire on the host first. From the Fargate host, n = 1 per case unless stated.

| case                                                                      | caller's outcome                                             | rollback                            | total ms | callbacks done | late callback from the expired attempt          | what the guest saw                                                                             | open tx after | slot free (next invoke) | rows landed                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- | -------- | -------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------- | ----------------------- | --------------------------------- |
| (a) mid-callback: insert, `pg_sleep(8 s)`, insert                         | `handler_timeout`                                            | confirmed                           | 5020     | 2              | 403 `capability_refused` / `invocation_expired` | `statement_timeout` (`canceling statement due to statement timeout`)                           | 0             | yes, `committed`        | 0                                 |
| (a2) same, handler catches and inserts again                              | `handler_timeout`                                            | confirmed                           | 5020     | 2              | 403 `invocation_expired`                        | `statement_timeout`, then its retry insert refused `capability_refused` / `invocation_expired` | 0             | yes                     | 0                                 |
| (b) COMMIT delayed past the deadline (host waits 5.2 s before sending it) | `handler_timeout` ("deadline passed before COMMIT was sent") | confirmed                           | 5315     | 10             | 403 `invocation_expired`                        | nothing (handler had returned)                                                                 | 0             | yes                     | 0                                 |
| (b2) lost commit reply: COMMIT sent, socket destroyed 2 ms later, 5 runs  | `unknown_outcome` x5                                         | "unknown (COMMIT sent, reply lost)" | 75-137   | 10             | 403 `invocation_ended`                          | nothing                                                                                        | 0 in all 5    | yes                     | **5 of 5 runs landed all 5 rows** |

The caller's error names the difference: `handler_timeout` + `rollback: confirmed` (the host issued ROLLBACK and got it acknowledged) against `unknown_outcome` + `rollback: unknown`. A `COMMIT` whose reply is `ROLLBACK` (aborted transaction) is reported as `rolled_back`, not success (astra's point; implemented, not hit in these runs). Locally (110 ms from Neon) the 2 ms destroy always lost the reply; from Fargate (about 2 ms from Neon) the same injection sometimes let the reply through (item 3 saw 2 of 5 `unknown_outcome`, 3 `committed`), which is the point: the client-side signal does not decide it.

### 3. Mutation-key recovery

`mutation_keys(company, key, invocation_id, result)` written inside the mutation's transaction just before `COMMIT`; the host also holds an in-memory map of keys in flight.

| case                                                   | result                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) two concurrent submissions, one key                | one commit (5 rows inserted, not 10); both replies `committed` with the same invocation id and the same result; the second marked `deduplicated: concurrent`                                                                                     |
| (a2) the same key again later                          | `committed`, `deduplicated: from_table`, 3 ms, no execution                                                                                                                                                                                      |
| (b) lost commit reply then replay with the key, 5 runs | first call `unknown_outcome` (2 runs) or `committed` (3 runs, the reply arrived within 2 ms); every replay answered `committed` / `from_table` with the stored result; rows after replay = rows after first (5) in all 5 runs: never re-executed |
| (c) replay after the host was replaced                 | see item 4: `deduplicated: from_table` from the new host (epoch +1)                                                                                                                                                                              |

### 4. Ownership transitions

Pool state moved into `pool_tasks` (task, url, state, company, `owner_epoch`); a host takes `epoch` from `insert into hosts` on start, adopts the rows whose task is RUNNING and healthy, and claims each supervisor with `GET /epoch` carrying its epoch; every management request carries `x-owner-epoch` and the supervisor answers 412 `stale_epoch` to anything below the highest it has seen. The bench keeps 3 s `contacts.slow` invocations flowing for two bound companies while `update-service --force-new-deployment` replaces the host; each reply's `x-host-epoch` says which host answered.

**First run (epoch 4 -> 5) found a bug.** Adoption and fencing worked: the new host adopted 4 of 4 rows at 16:54:20 (`owner epoch 4 -> 5` logged by both bound supervisors), the old host got 22 `stale_owner` replies in 6-15 ms from the supervisors, and the invocation in flight at the handover committed. But 60 s later the **old host's idle sweep called `StopTask` on the two tasks it no longer owned** (its `lastUsed` never advanced once its requests were refused): `[pool] t1 stopped (idle) company=acme` at 16:55:20 and beta at 16:55:30, from epoch 4. ECS APIs sit outside the epoch fence, so "a database row alone does not provide fencing" was exactly right: beta's next invoke on the new host timed out against a dead task and `ecs list-tasks` (3) no longer matched the table (4). Fix: a host that receives one 412 marks itself superseded (no more starts, stops, binds; `/invoke` answers `stale_owner` without calling out), and `stopTask` reads the row's `owner_epoch` first and refuses to stop a task owned by a higher epoch.

**Second run (epoch 7 -> 8), fixed host:**

| check                                                        | result                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bound before                                                 | acme -> task `40a2`, beta -> `ddac`, two tasks starting                                                                                                                                                                                             |
| new host adopts                                              | 4 of 4 rows at 17:05:54 (`adopted from epoch 7; supervisor now at 8` for each), including the two that were still starting when the old host wrote them and had become ready                                                                        |
| old host after the claim                                     | 10 committed before, then **28 `stale_owner`**: the first at 38.4 s refused by the supervisor (`exec refused epoch 7: highest seen 8`), the rest answered by the superseded host itself; last at 106 s; SIGTERM at 17:07:44 with 0 invocations open |
| new host first reply                                         | 51-55 s after the deploy command; 19 committed, no errors                                                                                                                                                                                           |
| in-flight work at the handover                               | the 3 s invocation the old host had already handed to the supervisor completed `committed` (the fence is checked when the request arrives, not while it runs)                                                                                       |
| orphaned tasks                                               | none: `ecs list-tasks --family tier2-spike-exec` = 4 = the table, same four ids                                                                                                                                                                     |
| mutation key committed under epoch 7, replayed under epoch 8 | `committed`, `deduplicated: from_table`, rows unchanged (item 3c)                                                                                                                                                                                   |
| both companies after                                         | `committed` / `committed`                                                                                                                                                                                                                           |

Beta's task changed from `ddac` to the spare `43da` between the last sample and the final snapshot: the new host's own 60 s idle release fired during the `aws ecs wait services-stable` pause (a legitimate stop by the owner), and the first invoke afterwards bound the spare.

### 5. Authorisation boundary

Capabilities are minted per attempt; callbacks may name the company/patch they act for; the loader stamps every callback with the process generation the attempt started on; every supervisor management endpoint needs `x-exec-secret`.

| attempt                                                                                               | expected                                      | observed                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| callback naming company `beta` with acme/crm's live capability                                        | 403 `scope_mismatch`                          | 403 `scope_mismatch` (capability is for acme/crm)                         |
| callback naming patch `other` with acme/crm's capability                                              | 403 `scope_mismatch`                          | 403 `scope_mismatch`                                                      |
| `tables.insert` on a query-kind invocation                                                            | 403 `query_cannot_write`                      | 403 `query_cannot_write`                                                  |
| next callback on that query after the escalation attempt                                              | 409 `attempt_aborted`                         | 409 `attempt_aborted` (query_cannot_write)                                |
| callback carrying an older process generation                                                         | 403 `stale_generation`                        | 403 `stale_generation` (attempt started on generation 1, callback from 0) |
| callback after the invocation ended                                                                   | 403 `capability_refused`                      | 403 `capability_refused` (invocation_ended)                               |
| attempt 1's token after a `40001` re-invocation started attempt 2                                     | 403 `capability_refused` (attempt_superseded) | 403 `capability_refused` (attempt_superseded)                             |
| token of an invocation whose handler was cut off (`handler_timeout` at 5 s, process killed at 6 s)    | 403 `capability_refused`                      | 403 `capability_refused` (invocation_expired)                             |
| guest `fetch("http://127.0.0.1:8080/stats")` (supervisor)                                             | refused by loopback                           | 403 `refused` by the loader's Outbound loopback                           |
| guest `fetch("http://localhost:8080/healthz")`                                                        | refused by loopback                           | 403 `refused`                                                             |
| guest `fetch("http://127.0.0.1:8787/healthz")` (its own workerd)                                      | refused by loopback                           | 403 `refused`                                                             |
| management call to the supervisor without the shared secret (proxied by the host from inside the VPC) | 401                                           | 401 `unauthorized`                                                        |
| the same with the secret                                                                              | 200                                           | 200                                                                       |
| management call with an older owner epoch                                                             | 412                                           | 412 `stale_epoch` (item 4, 28 times)                                      |

Independent of guest outbound blocking: the supervisor's own listener refuses without the secret, and the only route from a guest is the loader's loopback, which refuses everything. The host's `/callback` is reachable through the ALB (it must be reachable from the exec subnet) and relies entirely on the capability; the host's `/admin/*` is open on the ALB in this spike and would need the same treatment.

### 6. Neon idle autosuspend, alone

Nothing else connected (cluster empty, both lanes' benches finished). Endpoint `current_state` read from the Neon API each minute; `suspend_timeout_seconds` is 0 (Neon's default, 5 minutes); Neon also sets `idle_in_transaction_session_timeout = 300000 ms`.

| connection held                                                                   | minute 1 | 2      | 3      | 4      | 5      | 6               | 7      | 8      | what happened to the connection                                                                                                                                                     |
| --------------------------------------------------------------------------------- | -------- | ------ | ------ | ------ | ------ | --------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| idle, no transaction (connected 16:23:41, 1922 ms cold connect)                   | active   | active | active | active | active | (probe crashed) |        |        | terminated by Neon at 16:29:0x, 5 min 20 s after connect: `57P01 terminating connection due to administrator command`; endpoint read `idle` at 16:30:04                             |
| idle in transaction (`BEGIN; select 1`, connected 16:30:06, 1238 ms cold connect) | active   | active | active | active | active | active          | active | active | session killed at 16:35:06, exactly 5:00 after `BEGIN`: `25P03 terminating connection due to idle-in-transaction timeout`; the compute still read `active` at 16:38:10 and 16:38:41 |

An idle open connection does **not** keep the compute active: Neon suspends at the 5-minute mark and drops it. An idle-in-transaction connection is killed by the session timeout at 5 minutes, and the compute stayed up at least 3.5 minutes after that (it was still `active` when the next measurement needed the database, so whether the kill itself reset the idle timer was not observed to its end). Neither is a keep-alive; the pool's periodic queries are what kept the compute up in lane B's confounded run.

### Verdict per item

| item                | held / did not hold / not proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 process per patch | **Held for availability**: with a process per patch version, a sibling patch kept committing at 17 ms p50 (44 ms while the loop spun) through a tight loop and through 600 MB of allocation, and only the offending process was killed; in one process per company the sibling lost 121 of 179 requests and 8 in-flight invocations died with the kill. **Did not hold for memory**: 45 MB per loaded process, so twenty loaded versions fill a 1 GB task (1006 MB aggregate) against 193 MB for twenty isolates in one process. The reaper returns the count to what is in use after 60 s; a residency budget (reject loading beyond N processes, or a bigger task) is the missing piece. **Not proven**: behaviour with two or more processes spinning at once on 0.5 vCPU. |
| 2 deadline cleanup  | **Held**: all three expiry points (mid-statement, before COMMIT, lost COMMIT reply) end with the capability revoked, late callbacks refused by name, the slot free, nothing left in `pg_stat_activity`, and the caller told `handler_timeout` + `rollback: confirmed` or `unknown_outcome` + `rollback: unknown`; the lost-reply case landed rows in 5 of 5 runs.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3 mutation keys     | **Held**: concurrent same-key submissions produce one commit and identical replies; replay after a lost reply and after a host replacement answers from the table without re-executing. **Not proven**: a replay arriving while the first submission is on a _different_ host (the in-flight map is per host; only the table is shared, so two hosts could execute the same key concurrently until the second `insert into mutation_keys` fails on the primary key at commit, which this host would report as `commit_error`, not as a dedup).                                                                                                                                                                                                                                |
| 4 ownership         | **Held after one fix**: the replacement host inherits bindings and spares from the table, claims the supervisors, and the old host's later requests are refused; in-flight work finished; ECS matches the table. **Did not hold on the first run**: the superseded host's idle sweep stopped adopted tasks through the ECS API, which the supervisor fence cannot see; fixed by marking the host superseded on the first 412 and by fencing `StopTask` on the row's epoch.                                                                                                                                                                                                                                                                                                    |
| 5 authorisation     | **Held**: 14 of 14 rows as expected. **Not proven**: the host's `/admin/*` and `/callback` are unauthenticated on the ALB in this spike (the capability is the only guard on `/callback`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6 Neon autosuspend  | **Held (answer is no)**: an idle connection does not keep the compute active (suspended and dropped at 5 min); an idle-in-transaction connection is killed at 5 min by Neon's session timeout; the compute was still active 3.5 min after that kill when the next measurement needed it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Awkward, round 2

- **The idle sweep bypassed the fence** (item 4): every out-of-band API the host calls (ECS `StopTask`, `RunTask`) needs its own check against the table; the supervisor fence only covers what goes through the supervisor.
- **The bench's own `/admin/reset` deleted the mutation key** meant for the host-replacement replay on the first run; the script now leaves it alone. Bench scripts that reset state need to say which state.
- **`build.sh` captured a shell's `EXEC_SECRET`**: the local harness exports `EXEC_SECRET=localsecret`, `build.sh` preserves whatever is in the environment into `infra/.tags`, so the deployed secret is that string. The mechanism (401 without it) is what was measured; the value is a spike artefact.
- **Releasing or draining the pool does not refill it** until the next bind (`release`/`drain` never call `ensure()`), so the first invoke after a mode switch paid a 25 s cold start; harmless for the numbers, wrong for production.
- **The exec watchdog moved to 6 s** so the host's 5 s deadline decides idle waits; a CPU loop therefore stalls its process for 6 s instead of 4.5 s before the kill. In patch mode that costs nothing to siblings; in company mode it lengthens the outage.
- **`/admin/stats` after the host released the company's task** returns "no task bound", which broke the scripted reap check; the memory measurement in patch mode at N = 1 therefore starts on a fresh task (45 MB) rather than the one the spawn test loaded (52 MB per process there).
- **Node's `fetch` 2 ms destroy window is too slow from Fargate to Neon** (about 2 ms RTT): the injected lost reply arrived in time in 3 of 5 runs of item 3 (0 of 5 in item 2 minutes earlier). The `unknown_outcome` result is timing-dependent by construction; lane B's TCP proxy is the deterministic way.
- The pool's `processMode` is host memory; a replacement host comes up with the task definition's default (`company`) while its adopted tasks may be patch-mode tasks. The supervisor reports its mode in every reply, so nothing broke, but the mode belongs in the table beside the task.
- Prettier from the repo's commit hook reformats the prototype's files on every commit, which broke three scripted edits in this round (matching on text that had been re-wrapped). Editing by line number worked.

### What is left running

Nothing: `destroy.sh` deleted service `tier2-spike-host` and stopped every `tier2-spike-exec` task; `list-tasks` and `list-services` on `patchy-tier2-spike` are empty of this lane's names. Task definitions `tier2-spike-exec:1-6` and `tier2-spike-host:1-7`, the images (`exec-20260925183317`, `host-20260925183317`, `host-20260925184314`, `host-20260925185813`, `host-20260925190142`), and the two round-1 SG rules remain. The Neon endpoint was left to its own autosuspend.
