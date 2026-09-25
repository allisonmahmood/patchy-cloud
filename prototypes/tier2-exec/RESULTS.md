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
