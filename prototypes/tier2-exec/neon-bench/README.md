<!-- PROTOTYPE for #311 -->

# neon-bench: Neon Postgres measured from an ECS Fargate task

Lane B of the tier 2 execution-service spike (#311). One script, plain `pg`, no Effect, that runs the four Neon measurements the Neon research (#354) asked for and prints a Markdown results block. The numbers that count come from a one-off Fargate task in `us-east-1`; the same script runs from a laptop for development. Results, labelled local vs Fargate, are in [RESULTS.md](./RESULTS.md).

What it measures, in order:

1. Round trip warm (n=50; DNS, TCP, SSLRequest, TLS, auth and query separated) and cold (suspend the endpoint through the Neon API, then time the first connection, n=5).
2. A ten-callback SERIALIZABLE mutation (n=100; total and per-statement p50/p95/p99), four-slot and two-slot contention on one counter row for 30 s with retry on `40001`, a deterministic `40001` with the retry to the correct total, the five-second cancellation race (`SET LOCAL statement_timeout` vs pg's `CancelRequest`), and a lost commit reply (a local TCP proxy forwards `COMMIT` and drops the reply; also `stream.destroy()` in the same tick).
3. A forced compute restart mid-mutation through the Neon API. Runs once and last: it drops every connection on the compute, including the other lane's.
4. The ADR-0009 provisioning path under `neon_superuser`: `CREATE ROLE`, `CREATE DATABASE … OWNER`, `SET ROLE`, DDL as the company role, login as it, revoke, drop.

Plus server settings (`max_connections`, `neon.*`), and whether one idle connection keeps the compute from suspending.

Everything runs in a scratch database `neon_bench` that the script creates and drops; the provisioning step creates and drops `company_x`/`company_y`. Nothing touches the `patchy` database beyond `CREATE`/`DROP DATABASE` from it.

## Try it

```sh
cd prototypes/tier2-exec/neon-bench
npm install
./run-local.sh                       # all steps from this machine, labelled "local", ~20 min
BENCH_STEPS=warm,mutation ./run-local.sh   # a subset; restart is the one to leave out unless you mean it
./build.sh                           # crane: node:24-slim + this directory, pushed to the spike's ECR repo
./run-on-fargate.sh                  # registers tier2-spike-neon-bench, runs one task in a public subnet, writes the log to /tmp/wf311/
```

Both runners read `~/.config/patchy-cloud/neon-spike.env` with `grep`, because its `DATABASE_URL` carries an unquoted `&` and cannot be sourced; `build.sh` and `run-on-fargate.sh` also source `~/.config/patchy-cloud/aws-spike.env`. Knobs: `BENCH_STEPS` (comma list of `settings,warm,cold,mutation,contention,conflict,cancel,lostcommit,provision,idle,restart`), `BENCH_COLD_N` (suspend cycles, default 5), `BENCH_IDLE_MINUTES` (idle watch, default 8).

Spike shortcuts, not the production shape: the Neon credentials ride in the task definition's environment; the task runs in a public subnet with a public IP and the host security group so it reaches Neon without a NAT.
