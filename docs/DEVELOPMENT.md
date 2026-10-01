# Patchy Cloud Development

## T3 Code

The root `t3.json` defaults new threads to isolated worktrees and offers five
actions. In T3 Code's project actions menu, import each action from **From
t3.json** once. Imported actions are saved copies; later changes to `t3.json`
do not update them automatically.

**Setup** runs `pnpm install --frozen-lockfile` when T3 creates a worktree and
holds the agent until installation exits. **Start dev**, **Stop dev** and
**Restart dev** control that worktree's local instance. **Check** runs lint,
typecheck and offline tests in sequence, stopping at the first failure.

Dev startup stays manual and requires the [Clerk development keys](#clerk-keys).
Open the URL printed by the runner; each worktree gets its own port. Closing an
action's terminal does not stop the dev instance, so use **Stop dev** when done.

## The local instance: `pnpm dev`

Use Node 22.22.0+ and the pnpm version in `package.json`, with dependencies installed
by `pnpm install`. Embedded Postgres is included; no separately managed database
is needed for this loop.

### The execution engine

`pnpm install` installs exact `workerd` `1.20260924.1` with its install script
disabled. No global workerd installation is used: `packages/execution` resolves
and verifies the platform package, then launches its binary directly so killing
the child cannot leave a runtime behind a Node launcher.

`pnpm exec vitest run packages/execution/src` exercises the loader Worker against
stub callback hosts and checks the server runtime promise on the actual binary.
Each harness scope owns its loopback port, process and temporary configuration.
Inspection grants no callback service or company binding and kills and reaps
non-terminating initializers under a load deadline. Publication uses a throwaway
process. Dev keeps the credential-free process warm while each request owns an
uncached Worker whose code and background tasks are disposed after inspection.
The loaded Worker has `globalOutbound: null`, so network refusal does not depend
on static import detection. Inspection and engine regressions execute the
`cloudflare:sockets` lexer bypass against real TCP, fetch and WebSocket targets,
assert zero guest connections, and verify trusted callback RPC still works.

The engine, inspection, supervisor and local executor are available independently.
`@patchy/execution/local` owns the production loader and watchdog without a fleet
pool. A killed generation requires a fresh host bind, never an invocation replay.
It refuses construction when `NODE_ENV` or its explicit environment is production.
The existing `pnpm dev` instance composes this executor into Runtime, so an
eligible `server.call` executes through the private callback gateway rather than
returning `InvocationUnavailable`. It publishes and serves both tier 2 artifacts.
The patch-repo `patchy dev` uses this same engine and callback gateway over local
PGlite and fixtures, without platform invocation rows. `InvocationLocal.test.ts`
exercises the hosted composition; `devExecution.test.ts` covers the patch-repo one.
Nested queries and mutations use the parent's exact binding and have separate invocation rows.
Resource-free queries use a fenced invocation
resource with an empty watermark and zero database-held time, without provisioning
a company database. Data-bearing queries retain one read-only repeatable-read
snapshot. The primitive snapshot tests use real Postgres for concurrent writes,
live unsharing and deadline cancellation; PGlite does not prove production contention.
`Invocation.test.ts` injects a non-returning executor to verify disconnected-client
deadlines, inherited child budgets and unresolved-resource destruction. Fleet
hosting can be exercised with the local task provider below. These checks prove
local execution and settlement, not Fargate containment.

Mutations use one host-owned SERIALIZABLE transaction and up to three
whole-handler attempts within the original five-second deadline. They return
only after committing the result and mutation key. Unknown mutation outcomes
offer an explicit client `retry()` with the original key and arguments.
The real-Postgres mutation tests cover concurrent writes, rollback, cross-host
key races, dropped callers in all three handler kinds, and nested mutation
database time. PGlite can exercise transaction rollback but not those
multi-session contention and cancellation guarantees.

`pnpm exec vitest run apps/server/src/DevelopmentExecution.test.ts` exercises
eligible query, mutation and action calls through the same `Server.layer`
selected by `pnpm dev`, including nested callbacks, committed-key replay,
company isolation and production refusal.
It publishes and executes stored tier 2 artifacts, and verifies production
publication refusal.
For a callback-free mutation on a fresh company, the host provisions the key
store before execution. The replay check must begin with no company database;
pre-provisioning a table would miss that first-call path.

Tier 2 queries subscribe through the same document stream as tier 1. Run
`pnpm exec playwright test -c playwright.tier1.config.ts --project=chromium server-subscriptions.spec.ts`
for two signed-in viewers on published workerd artifacts: mutation sync, reconnect
and hidden-tab catch-up, unshare/reshare recovery including first-run refusals,
and isolated permanent failures. Old documents retain their loaded handlers
after a publish; a new document sees the new handler set.
The fixture owns disposable Postgres and offline browser sessions, not live Clerk
or a daily-driver instance.

The same browser suite exercises tier 2 authorised file handles, frame-local
images and the shell's trusted download action. It covers stale replacements,
another viewer, URL cleanup and narrow download-card layout. The Primitives
file contracts cover live unsharing, replacement-before-access refusal order,
durable signing keys and metadata-page byte limits on PostgreSQL and PGlite.

`SubscriptionsSettlement.test.ts` exercises real invocation ownership with delayed
executor and snapshot cancellation. A timeout or disconnected document must not
release its re-run slot before cleanup settles or destroys the retained resources.
`QuerySubscriptions.test.ts` exercises forged resume vectors: undeclared resource
keys never reach revision reads, while declared keys still support equal-vector
resume and failed-first-access recovery.

`pnpm test:packed-preact-e2e` checks a clean installed SDK with Vite dependency
optimisation enabled and its single-file production artifact. Signals, hooks,
compat components and `useQuery` must update together, retain data through a
refusal, and keep a permanent query error for later mounted consumers.

To run only the execution task from this checkout:

```sh
node --import tsx --conditions=development apps/server/src/exec.ts
```

The server image includes the same entrypoint as `node dist/exec.js`; its default
command remains the host (`node dist/start.js`).

It requires `EXECUTION_MANAGEMENT_SECRET`, `EXECUTION_CALLBACK_URLS` as a JSON
array of trusted host callback URLs, `EXECUTION_DEPLOYMENT_REVISION` and
`EXECUTION_TASK_ID`. `EXECUTION_MANAGEMENT_PREVIOUS_SECRET` is optional during
rollout. The listener defaults to `127.0.0.1:8788`; set
`EXECUTION_MANAGEMENT_PORT=0` for an isolated smoke run and use its printed URL.
For deployment, `EXECUTION_MANAGEMENT_HOST` may name an RFC1918 or ULA interface
only with `EXECUTION_MANAGEMENT_PRIVATE_INTERFACE=true`; restrict it to the host
security group. Wildcard and public addresses are refused. No database, storage,
Clerk configuration or running dev instance is needed.

The supervisor reads execution operating limits from `PATCHY_LIMITS_JSON`.
It enforces `execution.probe.interval`, `execution.process.rss`,
`execution.process.idle`, `execution.residency.processes` and
`execution.residency.bytes`; its report configuration hash covers these values.
The probe interval must be less than the six-second stall contract.
Defaults are 12 resident processes, 1.5 GiB aggregate RSS, a 512 MiB per-process
kill, 60 seconds idle and a 250 ms probe. The units are binary: one GiB is
2^30 bytes and one MiB is 2^20 bytes. An unfinished initializer also expires at
`execution.process.idle`, even when health probes succeed. Its bind refusal and
process-report end cause are `load_failed`. The six-second stall and one-second
post-deadline termination grace are release contracts. Linux uses `/proc` and
macOS uses `ps` for metering; other platforms refuse supervised execution.
Unexpected sampling failures kill only the affected resident with report end
cause `metering_failed`; other residents remain supervised. Distinct child uids
require a privileged supervisor. Scope shutdown kills and reaps children and
removes their temporary configuration.

The local adapter runs its supervisor in the host process. Its aggregate RSS
ceiling counts only supervised workerd children, not PGlite, Vite, fixtures or
other host allocations. Dedicated fleet execution tasks include their host RSS.
The workerd process count, aggregate and per-process ceilings, and watchdog still
apply locally.

The private management wire is documented in `docs/API.md`. The host must persist
process reports before acknowledging them through `stats`. The supervisor has
no database and reports interrupted attempt identities without classifying commits.

### Exercising the fleet offline

An isolated host can opt into `EXECUTION_PROVIDER=local-fleet` with `NODE_ENV=test`
or `development`. The default dev executor remains no-pool; production refuses
the local task provider. Do not use a daily-driver instance for fleet checks.

This path runs the same controller as the ECS provider, over the
platform database. Local hosts on one Linux machine share a durable task directory;
`flock` serializes launches, and detached task owners retain readiness, final process
reports and observed stop times independently of the host that launched them.
Each task still has a separate supervisor process. Children receive only local
management identity, a generated deployment secret and trusted callback URLs, not
the host's database, storage or login environment.

Set these for every local-fleet host:

- `EXECUTION_LOCAL_DIRECTORY`: the same private directory for hosts sharing one
  platform database. Use a different directory for a different database.
- `EXECUTION_CALLBACK_URLS`: a JSON array containing every host's trusted private
  callback URL, such as `["http://127.0.0.1:41001/callback","http://127.0.0.1:41002/callback"]`.
- `EXECUTION_CALLBACK_PORT`: that host's stable callback port, such as `41001`.
  Its URL must appear in the common allowlist. Keep the port stable across restarts.

Closing a host or provider scope does not stop shared tasks. Controller release
and drain operations stop them. Disposable tests own a
`LocalTaskProvider.resource({ callbackUrls })` scope or explicitly call
`LocalTaskProvider.cleanup(directory)` before removing their directory.
Hosts must share the local filesystem and process/network namespace. This provider
does not support cross-machine discovery; that belongs to the ECS provider.

The controller claims spare tasks, fences stopping bindings, drains retained
invocations and reconciles provider stop times. Its housekeeping lease is shared
by host replicas. `PATCHY_LIMITS_JSON` configures the registry's fleet budget,
spare floor, housekeeping interval and lease. `PATCHY_REPLICA` identifies the host
and `PATCHY_DEPLOYMENT_REVISION` identifies the deployment; neither is a binding
epoch or process generation.

Registering a new host revision does not switch the fleet. The first deployment
warms and promotes automatically. Later rollouts call `stageDeployment(revision)`,
let housekeeping prepare spares, then call `promoteDeployment(revision)`.
Promotion returns false until the required warm capacity exists. Existing companies
move to ready replacement tasks incrementally, retaining admitted work on the old
binding. Rollback stages and promotes the earlier revision through the same operations.
No direct row edits are needed.

The housekeeping lease renews during provider work, and a failing task does not
block unrelated reconciliation or replenishment. A lost activity database session
is replaced and its live locks restored, including for documents making no requests.
An omitted ECS task or a `MISSING` response is not proof that the task stopped.
The controller retains its durable allocation and budget until the provider
confirms a stop. Cold-start sizing uses `ready_at - requested_at`, so placement
and image-pull time count toward the spare target.

`packages/execution/src/Fleet.test.ts` covers controller transitions over Postgres.
Its lease and housekeeping cases use `TestClock` with an explicit renewal barrier:
the real SQL renewal must return and the next timer must be armed before time
advances again. A committed row alone does not prove that the renewal fiber has
resumed. These tests do not use wall-clock sleeps to race database I/O.
`LocalTaskProvider.test.ts` executes real workerd and verifies final process reports
survive task stop. The fleet case in `DevelopmentExecution.test.ts` opens a real
document stream through `starting` and `ready`, then exercises nested callbacks
and committed mutation-key replay. The ECS provider uses the same controller.

### Deploying only the tier 2 spike

`scripts/tier2-spike.mjs` reads its allowlist only from the existing private
files below. It does not accept account, caller, region or project overrides
from command-line arguments or the ambient environment.

| Private file                            | Required identity fields                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.config/patchy-cloud/aws-spike.env`  | `AWS_ACCOUNT_ID` is the approved account; `SPIKE_IAM_USER` is the approved IAM user name, not an ARN. Together they specify the exact expected caller ARN, `arn:aws:iam::<account>:user/<user>`. |
| `~/.config/patchy-cloud/neon-spike.env` | `NEON_PROJECT_ID` is the approved disposable project.                                                                                                                                            |

Keep these files private and outside git. The AWS file also supplies the
deployer's credentials and spike resource IDs; the Neon file supplies database,
API and storage credentials. Missing or malformed identity fields fail closed.
The script requires the exact STS account and caller, fixes AWS to `us-east-1`,
and checks AWS resource ownership and tags before mutation. It resolves the
configured project's database endpoint, branch storage endpoint and bucket
through the Neon API, checking the project ID and `aws-us-east-1` region.
It never uses the production Azure group. The initial stack must have no
running tasks or services.

Build on Linux x64 with Node 24.20.0, pnpm 11.5.2, GNU tar and crane v0.22.1:

```sh
pnpm install --frozen-lockfile
node scripts/build-server-image.mjs --output .local/server-image.tar --tag patchy-server:spike
node scripts/tier2-spike.mjs status
node scripts/tier2-spike.mjs up .local/server-image.tar
```

The image pins the Node base digest and normalizes archive metadata.
`.github/workflows/server-image.yml` builds it twice and compares the archives.
The default command is `node dist/start.js`, as user `node`; exec tasks override
it with `node dist/exec.js`. Only the supervisor runs as root, retaining the
capabilities needed to chown temporary files, switch child uid/gid, sample and
kill children. Workerd children have distinct unprivileged uids and empty
environments. Neither image assembly nor CI publishes or deploys to production.
Exec task definitions must declare a root supervisor user explicitly, such as
`user: "0"`. The ECS provider rejects a missing user or a non-root user rather
than relying on the image's default user.

The spike starts two hosts behind the existing ALB and registers an exec task
definition at 512 CPU units and 2048 MiB. There is no exec service or desired
count. The controller launches tagged tasks in the private subnet, with no
public IP, task role, environment file or secret reference. The task-execution
role only lets Fargate pull the image and ship logs. The bootstrap security
group stays attached, permitting the ECR/log endpoints, S3 image layers and
the hosts' private callback port. The sealed comparison group still cannot
pull an image; it is not attached after startup.

Host port 8080 is the ALB target. Exec management port 8788 accepts only the
host security group; host callback port 8789 accepts only exec. Neither private
listener is an ALB route. `EXECUTION_MANAGEMENT_HOST=auto` and
`EXECUTION_CALLBACK_HOST=auto` resolve exactly one private task IPv4 address;
they require the corresponding `*_PRIVATE_INTERFACE=true` opt-in.

The deploy snapshots ALB and security-group settings in mode-0600
`.local/tier2-spike/state.json`. It enables HTTP/2, the 90-second deregistration
delay, and application-cookie stickiness on `patchy_stream_affinity`. Keep the
server-issued cookie: subscription control POSTs must reach the replica holding
the document stream. The spike certificate is self-signed; only acceptance
clients against this ALB may ignore its certificate error.

Hosts and the disposable promotion task use only the existing
`patchy-tier2-spike-host-task` role named by `SPIKE_HOST_TASK_ROLE_ARN` in the
private AWS file. The script requires its exact ARN in the approved account.
The AWS SDK obtains temporary credentials from the ECS task credential endpoint.
The deployer's `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and session tokens
are never added to host task definitions; there is no fallback to IAM user
credentials. Neon storage credentials use the separate `PATCHY_S3_*` settings
and are not part of the AWS credential chain. Exec tasks have no task role.

An operator authorized to manage the existing host role must inspect its trust
and permission policies before deployment and add missing fleet permissions.
Do not assume the disposable deployer can inspect or change IAM policies.
The deployer does not create roles or manage policies. Its local preflight
rejects a different host role, credential overrides and environment files before
host registration, and checks a stored host definition before promotion.
This does not prove the role has the required IAM permissions. If the role
still has no fleet policy, provision that policy before running `up`; do not
forward user keys to work around an authorization failure.
The [role-only acceptance on #406](https://github.com/allisonmahmood/patchy-cloud/issues/406#issuecomment-5920910104)
verified temporary credentials from this role, warm-spare launch, idle task stop,
promotion and secret retirement without static AWS keys on hosts. The initial
`ecs:ListTasks` denial was resolved by an operator granting the policy below;
the deployer made no IAM policy changes.

The provider needs the following host-role permissions. Substitute the approved
account and cluster name from the private AWS file. `<cluster-arn>` is the full
ARN of `SPIKE_ECS_CLUSTER`; `<task-arns>` means
`arn:aws:ecs:us-east-1:<account>:task/<cluster-name>/*`.

| IAM action                   | Resource and restriction                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecs:DescribeTaskDefinition` | `*`. AWS does not support resource-level permissions for this action.                                                                                                     |
| `ecs:ListTasks`              | `*`, with `ArnEquals` on `ecs:cluster` set to `<cluster-arn>`. The provider lists running and stopped Fargate tasks without a container-instance target.                  |
| `ecs:DescribeTasks`          | `<task-arns>`, with the approved `ecs:cluster` condition. The provider requests task tags with each description.                                                          |
| `ecs:RunTask`                | `arn:aws:ecs:us-east-1:<account>:task-definition/patchy-tier2-spike-406-exec:*`, with the approved `ecs:cluster` condition. Do not grant the host task-definition family. |
| `ecs:StopTask`               | `<task-arns>`, with the approved `ecs:cluster` and `aws:ResourceTag/patchy:role=exec` conditions.                                                                         |
| `ecs:TagResource`            | `<task-arns>`, with `ecs:CreateAction=RunTask`. This authorizes tags at task creation, not arbitrary later tag changes.                                                   |
| `iam:PassRole`               | Only `SPIKE_TASK_EXECUTION_ROLE_ARN`, the existing `patchy-tier2-spike-task-execution` role, with `iam:PassedToService=ecs-tasks.amazonaws.com`.                          |

Restrict ECS actions to `us-east-1` with `aws:RequestedRegion`. The provider
adds `patchy:execution-fleet`, `patchy:execution-task`,
`patchy:deployment-revision` and `patchy:role=exec` tags, and propagates the
exec task definition's tags. `RunTask` can require the role tag on the request.
The `StopTask` policy can also require `patchy:execution-fleet` to match the
active run's `fleetId` in the private state journal.
Do not apply resource-tag conditions to the unscoped describe permission or
to inventory listing. The host role does not need ECR, CloudWatch Logs, EC2,
task-definition registration, role management or `sts:AssumeRole` permissions.
Image pulls and log delivery remain permissions of the task-execution role.

The host role trust policy must allow `sts:AssumeRole` for
`ecs-tasks.amazonaws.com`, restricted by `aws:SourceAccount` to the approved
account and `aws:SourceArn` to `arn:aws:ecs:us-east-1:<account>:*`.
AWS does not support narrowing this trust condition to a specific cluster.
The deployer separately needs `iam:PassRole` for both existing roles when
registering and starting hosts; the host role itself may pass only the
task-execution role. See AWS's [ECS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerservice.html),
[tag-on-create permissions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/supported-iam-actions-tagging.html)
and [task role trust guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html).

The spike creates a separate platform database and a fresh signing key for
fixture sessions; it does not create Clerk users or use a production session.
Its native database connections use `sslmode=verify-full`; the supplied
`channel_binding` URL parameter is not supported by the native driver.
The script leaves the source credential files unchanged.
The acceptance profile sets `execution.company.idle` to 10000 ms,
`execution.housekeeping.interval` to 1000 ms and `execution.fleet.budget` to
eight; the production registry defaults are unchanged.

For a rollout, build the next image, then run:

```sh
node scripts/tier2-spike.mjs rollout .local/server-image.tar
node scripts/tier2-spike.mjs promote
node scripts/tier2-spike.mjs drain
node scripts/tier2-spike.mjs seal .local/server-image.tar
node scripts/tier2-spike.mjs promote
node scripts/tier2-spike.mjs drain
node scripts/tier2-spike.mjs down
```

`rollout` rotates the deployment secret and retains the previous revision,
definition and secret. It leaves both host revisions registered.
`promote` runs controller operations in a disposable host-role task, not direct
database edits. The staged revision's hosts own replenishment; older hosts
yield the housekeeping lease while continuing admitted requests. Promotion waits
for warm spares. `drain` deregisters old hosts, waits the full 90 seconds, then
signals them and waits for the old tasks to stop. `seal` starts a new revision
using the same current secret but no previous-secret configuration. Promoting
and draining that revision replaces the overlap hosts and execs, removing the
old credential's authority without a mutable management endpoint. Rotation is
not complete until this second drain finishes.

EOF, stream reconnect/resync and explicit mutation-key `retry()` are the recovery
protocol. `down` stops run-owned tasks, removes run databases, published objects,
task definitions and image tags, and restores the snapshotted network settings.
It stops controllers before inventorying exec tasks so they cannot replenish
during teardown. Keep the private state until teardown succeeds.

For a non-spike ECS deployment, select `EXECUTION_PROVIDER=ecs` and configure
`ECS_CLUSTER`, `ECS_REGION`, `EXECUTION_FLEET_ID`, JSON `ECS_EXEC_SUBNET_IDS`,
`ECS_EXEC_BOOTSTRAP_SECURITY_GROUP_ID`, and the exact revisioned
`ECS_EXEC_TASK_DEFINITION` ARN. Set `EXECUTION_DEPLOYMENT_REVISION` equal to
`PATCHY_DEPLOYMENT_REVISION`, `EXECUTION_MANAGEMENT_SECRET`, callback port/host
settings, and JSON `EXECUTION_CALLBACK_URLS`. The host adds its own listener to
that list; the deduplicated result must satisfy the private wire's 64-URL bound.
During rollout also supply `ECS_EXEC_PREVIOUS_TASK_DEFINITION`,
`EXECUTION_PREVIOUS_DEPLOYMENT_REVISION` and
`EXECUTION_MANAGEMENT_PREVIOUS_SECRET` together. Both definitions use one family.
After old hosts drain, deploy a sealing revision with the same current secret
and all three previous-revision settings removed; promote it and drain the
overlap revision before declaring the old secret retired.
The fleet id stays constant across releases; task ids and binding epochs do not.

### Starting the local instance

`pnpm dev` runs a complete Patchy Cloud for the worktree you are in: embedded
Postgres, migrations, a seeded dev company with a user-owned machine token, the
packed `patchy` release, and the server. The package build runs before startup so
`GET /api/release` always describes downloadable bytes; failures appear under
`[package]` in `dev.log`. The offline test global setup builds that same artifact
once before its workers start. Package bundles resolve workspace dependencies
from source, so a clean checkout needs no preceding typecheck or package builds.
Before the first start, load the [Clerk development keys](#clerk-keys).
Browser sign-in needs a real user in that Clerk application and network access
to Clerk; the seeded machine token alone does not sign a browser in.
The runner returns as soon as `/healthz` answers and prints where everything is:

```sh
pnpm install
pnpm dev
```

```
Patchy Cloud dev instance for /home/you/patchy-cloud
  API       http://127.0.0.1:29276  (PATCHY_API_TOKEN=patchy-dev-token)
  Postgres  postgresql://postgres:postgres@127.0.0.1:29277/patchy
  State     /home/you/patchy-cloud/.local/dev  (env, plan.json, dev.log)
  Pids      supervisor 80419, server 80457, postgres 80443
```

Starting is idempotent: a second `pnpm dev` finds the running instance and
prints the same plan. The processes outlive the shell that started them, so an
agent can start once and keep using the instance across turns.
A live supervisor with an unhealthy server refuses a concurrent start: retry
while it starts or tears down, or use `pnpm dev stop` before starting again.

For the first publish as yourself:

1. Open the printed API URL's `/join` page in your browser and click **Sign in**.
   With [`PATCHY_DEV_CLERK_USER_ID`](#seed) set before startup, you land in
   **Patchy Dev** as its admin. Without it, create or join a company when prompted.
2. Keep `PATCHY_API_TOKEN` unset and run `pnpm patchy login`. In a human terminal
   it waits while you open its URL in that signed-in browser, check the code,
   company and email, name the machine and confirm. An agent uses the
   [nonblocking JSON handoff](#device-login-through-the-cli) instead.
3. After login succeeds, verify that `whoami` names your chosen machine, user
   and company before publishing. **Dev Machine** identifies the seed, not a
   completed personal login:

   ```sh
   pnpm patchy whoami
   pnpm patchy publish examples/plan.html
   ```

4. Open the returned URL in the same signed-in browser. The new patch belongs
   to the logged-in user and is shared with their company by default.

`pnpm patchy` runs the CLI from source. Inside the worktree it finds the runner's
env file by itself. Every command selects a key in this order:
`PATCHY_API_TOKEN`, a stored credential for this instance, then the dev seed.
You can publish as **Dev Machine** immediately without a login, but only a
browser user in **Patchy Dev** can open that company patch.
The [logout recipe](#device-login-through-the-cli) removes the saved credential,
so the seed applies again.

A repo's `patchy.json.instance` remains authoritative: the discovered dev env
cannot override it. `instance_mismatch` names both targets and refuses before
HTTP. Correct the effective override for that repo; keep its instance and patch
id intact. For a local experiment, initialize a separate repo against this
worktree's instance instead of rebinding an existing patch.

For isolated login or logout checks, set `PATCHY_STATE_DIR` before every CLI
command in that check, for example `export PATCHY_STATE_DIR="$PWD/.local/cli-check"`.
The default is shared `~/.patchy`, with credentials, pending logins and patch
caches keyed by instance; it is not inside `.local/dev/`. Isolation leaves
existing developer state untouched and is useful when an old cache format
would otherwise refuse a publish. Keep the same state directory through login,
completion, publishing and logout, then revoke the test key before removing it.

For anything else that needs the URL, token or database (`curl`, `psql`),
source the env file: `set -a; . .local/dev/env; set +a`.
Do this in a separate shell when checking login: exporting the seed as
`PATCHY_API_TOKEN` makes it override the login. Logout cannot remove or revoke
that environment token and warns about it.

### Subcommands

| Command                     | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm dev`                  | Start (or confirm) this worktree's instance and print the plan.                                  |
| `pnpm dev --dry-run --json` | Print the plan this worktree would run with, as JSON; touches nothing.                           |
| `pnpm dev status`           | Which of the recorded processes are alive and whether `/healthz` answers; exit 1 unless healthy. |
| `pnpm dev stop`             | SIGTERM the recorded supervisor; Postgres and the server go with it. State stays.                |
| `pnpm dev logs`             | Print `dev.log`.                                                                                 |
| `pnpm dev reset`            | Stop, wipe `.local/dev/`, and start a fresh seeded instance.                                     |

A start or `reset` bundles the shell broker first. A broker that does not
compile fails it on stderr before anything is recorded, stopped or wiped.
`stop`, `status`, `logs`, `--dry-run` and confirming a healthy instance never
build it.

`reset` is also the answer when the migration ledger changes shape under an
instance you already have, including the rewritten `0003_patches_baseline` and
pre-merge instances that ran the old `0007_runtime_baseline` instead of
`0006_runtime_baseline`. It deletes the database and published HTML; use it only
for disposable dev data, never to repair a live migration ledger.

Existing local instances created before the primitive-description change in #249
also need `pnpm dev reset`. That change rewrites company-inventory initialization
DDL in place: `patchy.tables` and `patchy.stores` now require a `description`
column. Restarting does not add those columns to an existing company database;
inventory reads and writes fail until the disposable dev databases are recreated.
The reset deletes local published HTML, rows and file objects. Do not run it
against data you need to keep.

The `0008_patches_lifecycle` migration includes `last_changed_action` for precise
portal stale-action notices. An existing disposable dev database created before
the #255 change needs `pnpm dev reset`; restarting does not reapply a migration.
This deletes local data, not a production migration path.

`--json` also works on `status`, `reset` and a plain start. The server is not
watched; after a code change, `pnpm dev stop && pnpm dev`.

### Per worktree

Every command is scoped to the git worktree containing the current directory.
Ports come from a hash of the worktree path (an even port in 20000–39998 for
the server, the next one for Postgres; the runner scans upward if the pair is
taken), so two worktrees run side by side and `stop` in one never touches the
other.

State lives in `<worktree>/.local/dev/` (gitignored):

- `plan.json` — the resolved plan, including the pids once running. `status`
  and `stop` act only on what is recorded here.
- `env` — `PATCHY_API_URL`, `PATCHY_API_TOKEN`, `DATABASE_URL`, `PATCHY_COMPANY_DB_ADMIN_URL`, `PATCHY_COMPANY_DB_URL`.
- `dev.env` — the worktree's generated `PATCHY_CREDENTIAL_KEYS`, created privately and retained across restarts; distinct from the shared Clerk settings file.
- `dev.log` — every line from every process, each prefixed `[dev]`,
  `[postgres]` or `[server]`.
- `postgres/` — the cluster's data directory; `storage/` — published HTML.

### Clerk keys

The server's application settings are closed: exported Clerk keys, database
URLs and storage settings in your shell do not reach it. Its Clerk development
keys, `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, come from one dotenv file
per developer, shared by every worktree and never in the repo:
`$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env` by default).
`dev.log` names which settings it loaded, never their values.
With an installed Clerk CLI authenticated to the **patchy-cloud** development
application, pull its keys into that file:

```sh
clerk env pull --app app_3ImZuFeZJb8038U0oFds84rupA2 --file "${XDG_CONFIG_HOME:-$HOME/.config}/patchy-cloud/dev.env"
```

Alternatively, copy the development application's publishable and secret keys
from its Clerk dashboard into the same file as `KEY=value` entries. Keep the
file private and keep secret values out of terminal output, chat and git.
Use development keys, not the dedicated CI application's keys.

Both Clerk keys are required at server startup. The runner supplies
`DATABASE_URL`, `PATCHY_COMPANY_DB_ADMIN_URL`, `PATCHY_COMPANY_DB_URL` and
`PATCHY_PUBLIC_BASE_URL` from its worktree plan; values for them in `dev.env`
are ignored. Both company-database URLs use the embedded Postgres superuser.

`CLERK_JWT_KEY` optionally supplies Clerk's PEM public key to avoid the JWKS
fetch during session-token verification. In `dev.env`, enclose the complete
multiline PEM in double quotes. Normal local sign-in needs no override; it
does not make browser sign-in, invitations or sign-out offline. For supported
key formats and boot-time validation, see
[`packages/auth/src/Session.ts`](../packages/auth/src/Session.ts).

`CLERK_AUTHORIZED_PARTIES` optionally restricts tokens to one origin. Leave it
unset locally: a port-specific origin makes worktrees evict each other's
sessions. The runner forwards these two optional Clerk settings, but no other
settings from `dev.env` reach the server.

### Connection credential keyring

The server requires `PATCHY_CREDENTIAL_KEYS`: comma-separated
`<kid>:<base64-encoded 32 bytes>` entries. The first key encrypts new credentials;
retained keys decrypt rows bearing their key id. Keep old keys until no encrypted
row uses them. Reading a row never re-encrypts it; changing the active key alone
does not rewrite existing credentials.

The dev runner creates a random key once in `.local/dev/dev.env` with mode `0600`.
Restarts reuse that file, so saved connections stay decryptable. It does not
modify the shared developer configuration or print key values. A dev reset removes
both the database and this keyring. For a hand-started server, supply the keyring
securely through its environment, never through an agent transcript.

Connection management is browser-only at `/company/connections`: admins connect,
test, rotate, retarget, refresh schema, disconnect, reconnect, edit descriptions
and delete undeclared connections; members read metadata. The normal production
connector refuses local/private addresses even in a local instance. Offline tests
exercise discovery against disposable Postgres through the source seam rather
than weakening that restriction. Declared Postgres connections admit `list`, `get`,
`getMany` and `query` through the runtime. Patch-development fixtures use the
integration's PGlite binding, not the normal network connector: one local database
per connection under `.patchy/dev/`, initialized from `fixtures/postgres-<handle>.sql`.
The file is required; its header describes native columns and synthetic views.
`patchy dev` composes this binding with the real primitive handlers and production
shell, without Clerk, the keyring or a runtime log store.

### A patch repo against this worktree

The cloud instance (`pnpm dev`) and a patch's local runtime (`patchy dev`) are
different processes. The cloud supplies release bytes, identity and metadata;
the patch runtime executes only local rows/files and invented fixtures.
For a disposable seeded check, initialize beneath this checkout so the CLI finds
this worktree's `.local/dev/env`. Isolate the CLI's personal state first:

```sh
export PATCHY_STATE_DIR="$PWD/.local/patch-cli"
pnpm patchy init .local/my-patch --purpose "Describe the tool being checked" --json
cd .local/my-patch
pnpm typecheck
pnpm patchy dev --json
```

Installation already ran in `init`. Open the returned `url`: it is the production
shell and broker at a loopback origin, authenticated as `/api/me`'s machine user
without a browser sign-in. For tiers 1 and 2, open `colleagueUrl` in a second tab:
it has a distinct origin and a fixed non-admin viewer in the same company. Writes
and subscriptions share local data across both mounts. Use `--tier 2` at init to
exercise queries, mutations and actions through generated server calls.
Insert and list through the generated client; exercise
`files.<store>.put` and `url(name)` when files are declared. Postgres and shared-table
declarations need invented inserts in `fixtures/postgres-<handle>.sql` and
`fixtures/shared-<alias>.sql`. Missing files fail before declaration regeneration;
dev generation leaves fixture files untouched.
Shared stores use `fixtures/shared-<alias>/`, with a README naming the source
store. Add invented files under their runtime names, including nested paths.
Dev infers content types from extensions, ignoring case: `svg`, `png`, `jpg`,
`jpeg`, `gif`, `webp`, `pdf`, `txt`, `csv`, `json` and `html`. Other extensions or
no extension use `application/octet-stream`; bytes are not inspected or changed.
Refresh creates only missing fixture directories. Dev reloads their bytes at
each start, including removals; edit fixtures and restart to change a source.
Removing the last file also changes the store's revision, so a reconnected query
subscription replaces its old listing with the empty result.
Local fixtures do not simulate source sharing or authority changes.
Never seed these files by querying a company's live rows or bytes.
Tier 2 handlers use those same fixtures through `ctx.shared` and `ctx.connections`.

`patchy dev` runs the same handler engine and callback path as production.
It does not reproduce production's scheduling, limits or containment. A handler
that spins forever times out, and a health check restarts the dev engine, which
can interrupt other calls in flight. Fixed contract limits still apply; production
operating capacity does not. PGlite is not evidence for hosted `busy` or
`write_conflict` behavior. `HandlerTls.test.ts` separately exercises a real
verify-full Postgres connection with a non-superuser through the handler callback
path; it rejects a wrong hostname and an untrusted certificate authority.

`pnpm patchy dev` twice reports one healthy daemon without reauthenticating or
checking a newer release. An alive but unhealthy daemon refuses another start;
read `dev logs`, then use `dev stop`. Vite build-watch swaps complete page artifacts;
`src/` edits reload the shell at its current route. `server/` edits atomically
rebind bundle bytes and descriptors without a browser reload. New modules are
discovered live and log a notice to refresh types. Calls and nested calls already
in flight finish on their old binding. Subscriptions rerun on the new binding,
discard crossing results and end permanently on removed handlers or incompatible
arguments. Failed builds leave the last good page or binding serving.
There is no Vite dev server or HMR escape from the production sandbox.
Config and fixture edits need `dev stop` then `dev`. `dev status`, `stop`, `logs` and `reset` take
`--json`; `--foreground` streams logs in text mode, and Ctrl-C stops only a session
it started. Joining an existing session leaves it running on interruption.
Each call in `dev.log` identifies viewer, handler, outcome and milliseconds, with
`ctx.log` output and local-only failure message/stack. A session started with
`--json` records full wide events and invocation JSON; `dev logs --json` retains
`{ ok, log, text }`. No runtime database log rows are written.
Reset stops and wipes disposable local state and requires a separate start;
it does not change published resources. State is scoped to this repo and instance
under `.patchy/dev/`. The next start fetches and materialises the full published
inventory from the server before the current manifest is applied. Omitted columns
and indexes stay provisioned, including unique constraints, so reset does not make
a formerly rejected write succeed.

Patch repos with local dev data created before #249 also need
`pnpm patchy dev reset`, then `pnpm patchy dev`, to recreate their PGlite inventory
with the required table and file-store description columns.

For a runtime source change, stop the patch session and run the source CLI from
inside the patch repo, substituting this checkout's absolute path for `cloud`:

```sh
cloud=/absolute/path/to/this/checkout
node --import "$cloud/node_modules/tsx/dist/loader.mjs" --conditions=development \
  "$cloud/packages/patchy/src/index.ts" dev --foreground
```

This exercises the worktree's runtime with the repo's installed Vite and browser
client, not `apps/server` inside the patch daemon. Restart the cloud instance for
metadata/server changes. To verify the packed release after a package change,
restart the cloud and initialize a fresh disposable repo with a fresh pnpm
store **and metadata cache**. A new repo alone can reuse an old tarball cached by
its unchanged local release URL. From the cloud checkout, for example:

```sh
cache=$(mktemp -d)
pnpm_config_store_dir="$cache/store" pnpm_config_cache_dir="$cache/cache" \
  pnpm patchy init .local/packed-check --purpose "Verify the current packed release" --json
```

Use a new destination and cache directory for each packed check, then follow the
laid-down instructions without reinstalling. This is only a worktree-development
precaution: deployed release URLs are immutable. Keep the cloud's printed API URL
authoritative; ports may change on restart.

New dev starts resolve the credential and check the exact pin, executing CLI and
installed runtime release before authenticating `/api/me`. They then fetch any
published inventory, check required fixtures and regenerate declarations. A release
change or logout never invalidates an existing healthy session. After publishing
to this local instance, non-additive config changes must fail at dev start with the
real provisioner's message; compatible additions preserve local rows. Before first
publish every schema change recreates disposable data. Stop patch sessions with
`pnpm patchy dev stop` before stopping the cloud instance.

Issue #202 adds exact operation outcome codes to the unmerged
`0006_runtime_baseline`; no new migration ID is introduced. Disposable development
databases created before this baseline change must be recreated with `pnpm dev reset`.
Do not use a reset or baseline rewrite to upgrade a live database.

### Seed

The shared `@patchy/auth/seed` entry exports `DEV_SEED` and `applyDevSeed`.
It creates company **Patchy Dev** (`cmp_dev`, handle `patchy-dev`), its admin
**Patchy Dev** (`usr_dev`, Clerk id `user_dev`, email `dev@patchy.local`), and
the admin's machine **Dev Machine** (`tok_dev`, token `patchy-dev-token`).
Only the token's hash is stored. Reapplying restores the dev user's admin role
and active state, clears the seeded machine token's revocation, and resets its
90-day lifetime and last-use timestamp. Machine tokens also stop working after
30 idle days.

This shared seed creates identity rows only, not example patches or connections.
A fresh instance's portal therefore shows **No patches yet**. The optional
`pnpm seed:dev` command publishes the accepted HTML fixtures as live, company-shared
tier 0 patches with empty descriptions. It creates no retired, deleted or
deactivated-owner examples. Use the CLI or portal to make those states when
checking them; restarting reapplies the identity seed, not patch lifecycle moves.
Published patches stay live until someone retires or deletes them. Retirement
keeps them indefinitely; only deletion starts the 30-day recovery window.

The dev seed and vitest template then run `Patches.backfillNames`: patches without
a current name entry receive names derived from their titles in creation order,
with suffixes on collision. Already named patches keep their names; deleted
patches do not reclaim names. Fresh baselines start empty and publish assigns
names transactionally.

Set `PATCHY_DEV_CLERK_USER_ID=user_...` in the same developer `dev.env` to bind
the seeded admin to your Clerk development user; find that user's id in the
same application's Clerk user record. Set it before the first sign-in if you
want that user to be the seeded admin. After changing it, run
`pnpm dev stop && pnpm dev`; an idempotent start of a healthy instance does not
reseed. Unset or empty keeps `user_dev`. Offline tests and packed CLI e2e use
the default; the live browser tier binds its isolated seed to its own
run-namespaced Clerk user. The override changes only the seed, not the server's
environment. It does not move an already-enrolled user between companies;
use a fresh disposable dev database when changing that setup.

Open `/join` at the instance's API URL to sign in:

- Signed out, it answers 401 with a **Sign in** link to Clerk's Account Portal.
- With your `PATCHY_DEV_CLERK_USER_ID` bound to the seed, signing in lands on
  `/company` for **Patchy Dev** as its admin.
- Without the override, your real Clerk user lands on create-or-join. The page
  names your email and offers every live invitation for it, or a form to
  create a company with an editable handle. Creating makes you the admin;
  joining or creating lands on `/company`.
- **Not you? Sign out** on `/join` revokes the session, clears Clerk's cookies
  and returns to `/login`; the next `/join` is the signed-out door. A deactivated
  user sees a 403 page with **Sign out**, not a sign-in loop.

A validated `return` path sends a person who has a company back to that page.
Without one, `/join` leads to `/company`; `/login`'s sign-in link leads to `/machines`.

### Device login through the CLI

Sign in and join a company in the browser first, as in the first-publish recipe.
With `PATCHY_DEV_CLERK_USER_ID` bound as above, confirmation logs the machine in
to **Patchy Dev**; otherwise it logs in to the company you created or joined.
Keep `PATCHY_API_TOKEN` unset so the login, not an exported seed, drives commands:

```sh
pnpm patchy login --json
```

An agent shows the person the returned `verificationUrl` and `userCode`,
never opens a browser, then runs `next` through the source CLI:

```sh
pnpm patchy login --complete <userCode>
pnpm patchy whoami
```

The person opens the URL in their own browser, checks the code, company and
email, names the machine and confirms. Confirmation alone creates no key;
the CLI's successful poll saves it without printing it.
The receipt names the company and machine, and `whoami` names that machine and
the user, company and role. The user-owned token lasts 90 days or 30 idle days,
unless revoked sooner on **Your machines**.

`pnpm patchy login --complete --wait 0` polls once and answers `pending` at
exit 0 if confirmation has not happened. Completion normally waits up to a
minute, including in-flight responses; an unanswered request at the deadline
is exit 3, with the local login record kept for the same completion command.
Reuse `next` after a pending answer. An agent rerun of `login` polls a pending
code once and reports its status rather than another handoff. At a real terminal,
with the agent variables unset and no `--json`, `pnpm patchy login` prints the
handoff and waits in one command.

```sh
pnpm patchy logout
pnpm patchy whoami
```

Logout forgets the stored key and pending login before attempting revocation,
and remains exit 0 if the courtesy call cannot reach the instance. Inside this
worktree it prints the seeded-key line and `whoami` returns to **Dev Machine**.
Outside a worktree, with no environment key, `whoami` after logout is exit 1,
`Run: patchy login`. `/machines` lists live publishing keys and can revoke
one or all; **Sign out** there ends only the browser session, clears Clerk
cookies and returns to `/login`.

An unconfirmed login returns `pending`; polling too quickly returns `slow_down`.
Codes last ten minutes. Expired and denied answers are 410 and consume the
login, as does a successful poll. Starting is limited to five requests per
source address per minute by default
(`PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE` on the server); confirm-page
lookups have a separate per-user limit.

Device-login JSON and confirmation forms are limited to 4096 bytes. A declared
oversized body returns 413; exceeding the limit while streaming closes the
connection before parsing or changing a login.

Confirm and Deny return their informational outcome page directly with HTTP 200
and `Cache-Control: private, no-store`. A later GET reads the current code:
pending shows the form, an answered code returns 410 already used, and a code
consumed by the terminal's poll returns 404 unknown.

### Reading a published patch

New publishes default to company scope, including the seeded admin's patches;
republishing without `--share` preserves their scope. The response includes `name`,
`address` and `scope`; `publicUrl` equals `address`, not a promise of anonymous access.
For a company patch, a cookie-free `curl -i <address>` answers **401** with the same HTML door as `/login`, one
**Sign in** link, `x-patchy-sign-in-url`, and `Cache-Control: private, no-store`;
it has neither `Location` nor `WWW-Authenticate`. A machine token does not open
the page. Only the current version of a public patch is public; older versions
stay behind the company door, with **401** and `private, no-store` without a session.
If you previously published this file as a different user (for example as the
seed before creating your own company), its cached patch is still owned by
that user. Use `pnpm patchy publish examples/plan.html --new` to create your own
patch. After `pnpm dev reset`, `--new` also replaces a cache entry whose patch
no longer exists; a cached update otherwise fails without silently creating one.

The address is `/<company>/<name>`, for example `/patchy-dev/plan` for the seed's
first `plan.html`. Without `--name`, file publishing derives a valid name and
suffixes collisions; republishing preserves it. Use `--name quarterly-plan` to
rename explicitly. The old name returns 308 until another patch claims it;
retire and delete reserve its names until reclamation. A company handle alone and the removed `/d/*` routes
answer 404. `/~content/<patchId>/<versionId>` is an internal content URL with the
same door and caching, not the link to hand a reader.

Open a patch published by your logged-in user in the same browser, or bind the
seed to your Clerk user before publishing as **Dev Machine**. Click **Sign in**
if needed and return to the patch. Reload after 70 seconds: the company
shell's Clerk client keeps the session fresh, so it should reopen without
another sign-in. A person without a company is sent to `/join?return=…` first;
a deactivated user gets 403. A signed-in user of a different company and a
missing patch get identical private, uncached 404 responses.

Exercise sharing and the current-version boundary through the CLI, not by editing rows:

```sh
pnpm patchy publish examples/plan.html --share public --json
# Fetch the returned address and address/~v/<versionNumber> with cookie-free curl -i: 200.
# Keep this version URL for the history check.
pnpm patchy publish examples/plan.html --json
# Scope stays public. Fetch address and the NEW address/~v/<versionNumber>: 200.
# Fetch the previous version URL: 401, Cache-Control: private, no-store.
pnpm patchy share examples/plan.html company --json
# Fetch latest, current-version and previous-version URLs: 401, private, no-store.
pnpm patchy share examples/plan.html public --json
# Latest and current-version URLs serve publicly again; the previous version still answers 401.
pnpm patchy share --patch <patchId> company --json
# The id form takes the same patch back inside without publishing another version.
```

The file form uses its cached patch; `--patch` selects an id instead, exactly one
target. Only the owner may change sharing. Publish and share JSON report `scope`,
and text output announces who can open the link. While public, only the current
version answers **200** at both `/<company>/<name>` and `/<company>/<name>/~v/<current n>` with
`Cache-Control: public, max-age=60`, no `Set-Cookie`, and the unchanged script-free tier 0
public CSP. Older versions stay behind the company door even after sharing public
again. After the company transition, all version URLs and the latest URL answer
cookie-free requests with **401** and `Cache-Control: private, no-store`.
A previously public copy may remain fresh in a cache for up to 60 seconds after
a scope or current-version change; downloaded copies cannot be recalled. Fetch
only the current version of a public patch directly by URL; use the user's
signed-in browser for company pages and older versions of public patches.
The company shell permits only the configured Clerk Frontend API host and
Patchy's external session initializer; the published document's sandbox is unchanged.

### Portal and patch lifecycle

Sign in as a member of the publishing company and open `/` for the index, then
`/patches/<name>` for a card. The card is separate from the served patch at
`/<company>/<name>`. Owners and admins see Manage; other members see facts only.
Use **Show retired and deleted** to include off patches. Admins can reassign a
patch to an active company member; they must become its owner before publishing.

For an owned patch, exercise `pnpm patchy retire --patch <id> --json`, then open
its address in the same browser. Expect the retired notice, actor and card link,
not its bundle. A signed-out request still gets the login door. Restore with
`pnpm patchy restore --patch <id> --json`; the address serves again.
Use `pnpm patchy delete --patch <id> --yes --json` to check the deleted notice
and returned `purgeAt`. Restore before that deadline; retired patches have no
deadline. These actions keep versions and resources until deletion reclamation.

Use a source with a shared table or store and a published consumer to check refusal and
recovery. Retire or delete from live must list that consumer and exit 2 with
`has_dependants`; ask before adding `--force`. Its shared reads then fail with
`access_denied` until the source is restored. Restoring a consumer whose current
sources are off similarly requires acknowledgement of `sources_off`.

After two publishes, `pnpm patchy rollback 1 --patch <id> --json` must serve v1
without changing the data, cumulative schema, sharing or description. Edit the
description on the card or with `describe "<text>" --patch <id>` outside the repo,
then run `pnpm patchy refresh --json` in the repo. Check the notice and the pulled
text and sync stamp in `patchy.json`.

### Company management

The company page lists users, roles, active/deactivated state and pending
invites. Admins invite, revoke, resend, change roles, deactivate and reactivate;
members read the same page without management actions. Both roles can **Sign out**
there. The last active admin cannot be demoted or deactivated.

Deactivate and Reactivate link to portal pick pages. Choose whether to leave
the user's patches alone, retire selected or all live patches, or restore
selected or all retired patches. Confirm the recomputed dependant or off-source
warnings. The user's access change and selected patch moves commit together.
Deactivation alone leaves patches serving with an **owner deactivated** mark;
reactivation needs fresh machine tokens, and deleted patches stay deleted.

**Inviting on a dev instance sends real email through your Clerk development
application.** Patchy keeps the invitation even if Clerk cannot send it; the
page reports the failure and offers resend. Resend also recovers when the previous
Clerk invitation was already revoked, including after a lost revoke response.
Offline tests use recording and failing `InviteMail` layers instead. Deactivation revokes all the
user's machine tokens; reactivation restores browser access, not old keys.

### Test tiers

`pnpm test` stays offline and needs no Clerk account or development keys.
Every package with a `test` script carries its own `vitest.config.ts` that
re-exports the shared config from `test/`; Vitest does not look up a parent
directory's config, so a package without one runs its suite with no Postgres
setup and no fetch guard, silently.
Repo publish and cold-start PGlite integration scenarios can opt into a 30-second
test deadline, matching the existing multi-process tests. This bounds the whole
scenario on CI; it does not change production query or runtime timeouts.
`pnpm test:packed-cli-e2e` installs the packed CLI offline with an empty npm cache
and install scripts disabled, then exercises it against its own server and
headless Chromium. Install the browser first with
`pnpm exec playwright install --with-deps chromium`. Patch-repo initialization
installs its toolchain with a fresh pnpm store and metadata cache; that step needs
registry access, unlike `pnpm test`.

`pnpm test:postgres-concurrency` runs the SDK's cross-package concurrency block
over a clone of the migrated, seeded real-Postgres template. The
`*.postgres.test.ts` marker excludes it from ordinary package discovery; its
dedicated config discovers every `**/src/**/*.postgres.test.ts` file and refuses
an empty suite. It must never use PGlite: multiple real backend sessions
establish the locking invariants.
The block covers competing first publishes, whole-publish serialization and
cumulative inventory, rollback versus publish, old-bundle writes during additive
DDL, unique batches, same-name file writes, and patch-row lost-update prevention.
Lifecycle races cover a publish against retire, reassignment against publish,
and the deletion sweep against restore. They check the refused or committed
result and retained rows and resources, not SQL text. The existing package suites
retain their focused primitive concurrency cases.

`pnpm test:all` runs package tests through Turbo, the real-Postgres concurrency
block and the packed e2e, but not the live Clerk or content-store tiers. It attempts all three even
if an earlier suite fails and exits nonzero if any suite fails. CI runs offline
Vitest on Node 22.22.0 and 24. `cli-smoke` and `postgres-concurrency` are unconditional
Node 22.22.0 checks on pull requests and pushes to `main`, including forks and Dependabot;
neither needs Clerk secrets. Browser, Postgres, server, installation or suite
startup failures fail their job rather than skipping it.
The packed e2e runs inside `cli-smoke`, not a separate check.
`main` must require the `postgres-concurrency` and `cli-smoke` checks.

The runner, the vitest template and the packed CLI e2e apply the shared dev seed.
`Testing.layer()` clones the seeded template; package fixtures add rows on
top. SQL's migrator tests alone use its empty-database layer.
The `apps/server` test helper creates its temporary storage directory when the
server layer is built and removes it recursively when the layer's scope closes.

Session tests use `@patchy/auth/testing`: fake Clerk keys under `.invalid`, an
RSA fixture and a loopback-only fetch guard. The packed CLI e2e starts its
server with the same fake keys and PEM, never a real Clerk account. Its viewer
checks cover the default company's cookie-free 401 with `private, no-store`,
an explicit `--share public` publish's 200 with `public, max-age=60`, no
`Set-Cookie` and the locked CSP, and `share … company` returning it to the 401 door.
It also drives the login handoff through confirmation with an offline-signed
session, completion, saved-login precedence, logout and seed fallback.
The tier 1 flow initializes a source repo with the packed CLI, defines notes
and shared orders tables, starts `patchy dev`, inserts through the generated
client in the real headless shell, stops dev and publishes. It checks the
anonymous 401 door, a seeded-session bundle under the tier 1 CSP, and a hosted
row round-trip through `POST /api/runtime/call`. Dev rows stay local: the hosted
round-trip inserts its own row rather than treating publish as a data migration.
A second publish adds an optional column and checks the provisioning report.
The CLI initializes and publishes a second tier 1 repo that declares the source's
orders table and reads it through its generated browser client. The flow checks
`list`, `list <source>` and `list <source> orders`, the seeded session's portal
root and card, and retirement refused with the dependant before `--force`.
The retired address shows its notice and shared reads fail; restore brings both
back. `rollback 1` serves v1 while preserving the hosted row and additive column.
An external `describe` edit pulls into `patchy.json` with its notice and sync
stamp on the next `refresh`. Each CLI step checks its JSON result and exit code.
Discovery seeds two table-bearing patches through that disposable server's publish
API, one owned by the seed user and one by a colleague. The installed CLI runs
`list`, `list <patch>` and `list <patch> <table>` in text and JSON from outside a
patch repo. It checks descriptions and ownership, name and address resolution,
canonical ids in shared-table hints and reads, and column types, optional fields,
defaults, references, indexes and schema revisions. These checks use the saved
login and invented definitions, never a developer's instance or company data.
The packed flow also reads the stored version's tier, release and server-stamped
wire version. File mode synthesises a tier 0 manifest with empty `tables`, `files`
and `uses`. The API admits tier 0, 1 and 2 manifests with tables, stores, shared-table declarations and resolved Postgres declarations in dev and test instances. Scripted HTML is stored raw and served in the sandbox. Tier 2 additionally stores one closed server module; descriptor disagreement, load failure or load timeout is `invalid_manifest`. Production refuses tier 2 until fleet execution lands. Tier 0 keeps `PATCHY_MAX_HTML_BYTES` (512 KiB); tiers 1 and 2 use `PATCHY_MAX_BUNDLE_BYTES` (10 MiB) per artifact.

`GET /api/release` is public. A new CLI publish checks its executing version
against that release. File attempts live in the isolated `PATCHY_STATE_DIR`;
repo attempts live in the repo's `.patchy/publish/`. Keep them when retrying an
unknown outcome: removing one loses its publish key. After the target guard,
recovery authenticates the original owning user and resends the saved payload
before release, file or build checks. Token rotation is safe; an account switch
is refused before sending saved content. Authentication, throttling and quota
failures retain the attempt.

An atomic directory rename selects one fully written, key-addressed attempt.
Concurrent callers recover the winner. Success clears only that key after local
result application; a definitive refusal clears only that key, so a stale response
cannot remove a newer attempt. A killed process leaves the selected attempt
recoverable. Repo result application preserves the stored instance and applies
only the patch id, including after moving the repo.
[ADR-0004](adr/ADR-0004-cli-contract-for-agents.md) owns the selection protocol
and definitive-refusal list.

The dev runner imports only the separate seed entry, so it never
installs the loopback-only fetch guard. The production-domain Clerk handshake is a separate live
verification, not part of these offline checks.

The stream acceptance suite runs against a disposable Postgres, offline-signed
browser sessions, the built server and a local TLS HTTP/2 ingress:

```sh
pnpm exec playwright test test/browser-tier1/stream.spec.ts test/browser-tier1/subscriptions*.spec.ts --config=playwright.tier1.config.ts --project=chromium
```

It requires `openssl` for a temporary self-signed certificate, not production
credentials or a live ingress. Chromium's network protocol report must show
`h2` for all seven simultaneous document streams; a publish must reach all
seven before they close. The suite also checks editing through publish,
rollback, dismissal, missed retirement, token refresh versus a signed-out session,
an ingress cut and host restart. The subscription scenario uses two viewers:
one writes while the other's `useQuery` screen updates without reload, then
checks retained data and the reconnecting pill through an interrupted stream.
Recoverable source refusals retain data and their query error without a reconnect
pill or document-wide replacement loop; routine session refresh does not invent a
query error. A second real host exercises cross-host writes and terminated LISTEN
connections. A notification barrier in the disposable platform database blocks
`pg_notify` after a real API write commits its row and revision. The test kills
that publishing host with SIGKILL and keeps NOTIFY blocked until the surviving
host's subscriber recovers through durable reconciliation. Browser TLS trust is
relaxed only for this disposable certificate.
The local patch runtime mounts the same subscription stream over its real owned
tables and declared fixtures, with a fixed local viewer. Config and fixture edits
still require restart; code builds retain the existing whole-shell reload loop.
For a multi-replica ingress, route `/api/runtime/stream` and
`/api/runtime/subscriptions` to the same target using `patchy_stream_affinity`
application-cookie stickiness; see ADR-0010 for the ALB attributes. Round-robin
subscription POSTs cannot operate a process-local stream registry. No load
balancer or production configuration is needed for the single-host local loop.
The `async-exit-hook` dependency patch preserves failure exit codes when embedded
Postgres shuts down; without it, a failed Vitest suite can exit successfully.

#### Live content store

The opt-in contract suite uses the existing private `patchy-content` bucket on
the Neon spike project. Unlike the server, this test tier reads the spike file's
settings and maps them to the [server's dedicated S3 settings](#neon-object-storage):

| Live-suite setting      | Server setting                |
| ----------------------- | ----------------------------- |
| `NEON_BUCKET`           | `PATCHY_S3_BUCKET`            |
| `AWS_ENDPOINT_URL_S3`   | `PATCHY_S3_ENDPOINT`          |
| `AWS_REGION`            | `PATCHY_S3_REGION`            |
| `AWS_ACCESS_KEY_ID`     | `PATCHY_S3_ACCESS_KEY_ID`     |
| `AWS_SECRET_ACCESS_KEY` | `PATCHY_S3_SECRET_ACCESS_KEY` |

Keep the credentials in a private file outside the checkout, then run from the
repository root:

```sh
node --env-file=$HOME/.config/patchy-cloud/neon-spike.env node_modules/vitest/vitest.mjs run --config vitest.content-store-live.config.ts
```

With those five live-suite settings already exported, `pnpm test:content-store:live`
runs the same suite. That script does not load an env file. A file containing
only `PATCHY_S3_*` settings configures the server, not this live test tier.

Each run uses a unique object-key prefix and cleans up its own objects. It does
not create or delete the bucket or touch objects outside that prefix. The suite
is never part of `pnpm test` or `pnpm test:all`. Ordinary local development uses
the filesystem; the offline storage contract runs against both the filesystem
and an isolated loopback HTTP fixture backed by a Map. The fixture implements only
PutObject, GetObject, DeleteObject, and paginated ListObjectsV2, including missing
keys and XML escaping. Both the contract and fault-injection tests use the real
S3 client over HTTP. The fixture does not verify signatures or emulate other S3
features; the live Neon suite verifies provider compatibility.

#### Live Clerk: `pnpm test:clerk`

Install Chromium and its system dependencies once, then run both tiers:

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:clerk
```

Runs the Backend-API tier (`vitest.clerk.config.ts`), then the browser tier
(`playwright.clerk.config.ts`), serially against your **patchy-cloud**
development application, not your running dev server. Vitest reuses the
isolated, migrated Postgres template. Playwright starts a separate migrated
Postgres and checkout server, binds the dev seed's admin to this run's browser
Clerk user, and publishes a company patch with the seeded machine token.
Neither tier touches `.local/dev/` or your development seed.
When neither Clerk key is in the environment, the command reads both from
the [developer `dev.env`](#clerk-keys), using the same loader as `pnpm dev`.
An explicit or partial pair never falls back to that file; both keys must be
nonempty. GitHub Actions never reads the developer file. Running either
live config directly requires both environment keys and fails before setup
if either is absent.

Each run prints its `CLERK_TEST_RUN_ID` (a UUID locally, run id plus attempt
in CI). It creates `ci-<run id>+clerk_test@example.com` through Clerk's
Backend API, creates a session and JWT, and sends the session cookie through
the real `RequireSession` on `/company`. No `CLERK_JWT_KEY` is provided to
the layer, even if set in your shell: verification uses Clerk's JWKS.
The in-memory Vitest tier defaults `CLERK_AUTHORIZED_PARTIES` to its request
origin, `http://127.0.0.1:3000`; a Backend-API token's absent/null `azp` is accepted.

The invitation test creates, lists, revokes and re-invites
`ci-<run id>-invite+clerk_test@example.com` through live `InviteMail`.
**These requests send real invitation mail** (`notify: true`); the
`example.com` bounce is expected, not a delivery assertion.

The browser specs use Chromium, real Account Portal sign-in behind a Clerk
Testing Token, and the `424242` test email code:

- **`login-door`** opens the company patch signed out and checks its 401 door.
  The seeded browser user signs in through the Account Portal and returns
  through Clerk's handshake to the rendered patch and company shell. Reloading
  after the session token expires keeps the user signed in. The workflow adds
  the actual token-expiry wait to its timeout rather than assuming a fixed
  token lifetime (CI's overall job timeout still applies). A second user,
  in a separate browser context, signs in, creates a company through
  create-or-join, and gets the same 404 for the seeded company's patch as for
  a missing patch.
- **`patchy-login`** reuses the seeded user's signed-in browser to confirm the
  packed CLI's `patchy login --json` handoff with a machine name. Completion
  reports `logged_in`, `whoami` names the machine, and revoking that machine
  on `/machines` makes the next `whoami` return 401.

Playwright uses one worker, no retries, and a shared worker sign-in for the
seeded user: only two serial sign-ins for a full run, including the outsider.
The browser users are `ci-<run id>-browser+clerk_test@example.com` and
`ci-<run id>-outsider+clerk_test@example.com`. Browser requests go through
the page rather than `context.request`, which withholds Secure cookies on
the loopback HTTP origin. The isolated browser server always reserves its
own ephemeral loopback port, holding it until spawn instead of using an
ambient `PATCHY_PUBLIC_BASE_URL`. It restricts `CLERK_AUTHORIZED_PARTIES` to
that origin and uses live Clerk verification, not an ambient `CLERK_JWT_KEY`.

Select a workflow with a visible browser:

```sh
pnpm test:clerk --browser login-door --headed
pnpm test:clerk --browser patchy-login --headed
```

`--browser` skips Vitest and forwards the remaining arguments to Playwright.
Without it, both tiers run serially and the first nonzero exit status is retained.
Vitest teardown and the runner's final cleanup delete all three exact
run-namespaced user addresses (ending their sessions), check zero users remain,
and revoke pending invitations for the exact invitation email. The runner
also sweeps on normal test failure and after SIGINT/SIGTERM. Revoked invitation
records remain in Clerk. CI installs Chromium and its system dependencies,
runs both tiers, and repeats the idempotent sweep in an `always()` step,
including when the test step fails or is cancelled. No sweep touches another
run's addresses. If a local process is forcibly killed before teardown,
repeat the printed run id:

```sh
CLERK_TEST_RUN_ID=<printed-run-id> pnpm test:clerk --cleanup
```

The dedicated CI application is **patchy-cloud-ci**, Frontend API
`super-whale-1225.clerk.accounts.dev`. Its keys live only in repository
secrets `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY`, never in `dev.env`
or the repository. The `clerk-live` job runs on pushes to `main` and
same-repository PRs except Dependabot; forks and Dependabot skip it and run
the offline tier. An eligible run with a missing secret fails, never skips.
Both configs and the cleanup runner reject CI publishable keys unless they
identify exactly `super-whale-1225.clerk.accounts.dev`, before any Clerk request.
Marking `clerk-live` required in branch protection is a maintainer step;
a skipped job satisfies a required check.

### How it works

`scripts/dev/` is the Effect 4 runner. `start` writes `plan.json` and spawns a
detached supervisor under `node --import tsx`; the supervisor owns one Effect
scope holding Postgres and the server, so either exiting — or `stop`'s
SIGTERM — tears the other down. Migrations run through Effect's Migrator in
`packages/sql`: Companies owns `0001_companies_baseline`, Auth owns
`0002_auth_baseline`, and Patches owns `0003_patches_baseline`. Companies also
owns `0004_invites_expiry`, which adds and backfills invitation expiry.
Company database owns `0005_company_database_baseline`; Runtime owns
`0006_runtime_baseline`; Integrations owns `0007_integrations_baseline`.
Patches adds `0008_patches_lifecycle`, with lifecycle and actor stamps, descriptions
and visit counts. Limits adds `0009_limits_overrides`, with company overrides,
configuration revisions and attributed change history. Patches adds
`0010_patches_lifecycle_revision`, the durable counter for source publishes,
sharing and lifecycle changes. Runtime adds `0011_runtime_invocations`, with
invocation and query-rollup records, callback invocation/principal attribution
and explicit unknown operation outcomes. `0012_runtime_mutation_commit_proof`
keeps committed mutation evidence independent of the original host's settlement
timing and metering. Published seed patches stay live until retired or deleted;
only deletion starts their 30-day recovery window. Token and invitation expiry
remain separate.
Allocate migration ids monotonically in landing order:
Effect's Migrator applies only ids above the ledger's highest applied id, so a
later migration cannot fill a lower-numbered gap. The three migrator spreads are `apps/server/src/Server.ts`,
`scripts/dev/src/supervisor.ts` and `test/postgres.ts`; server tests clone the
template without passing migrations. Packed and live browser servers migrate
through the server's existing spread rather than maintaining another one.

The supervisor sets `NODE_ENV=development` in the server's closed environment.
Development and test instances select local invocation execution automatically;
production refuses tier 2 admission until the fleet executor is available. The
private callback listener binds loopback, and company-local executors close
with the server scope. Retained server bytes enter through Runtime's existing
`ServerBundles` port, implemented by Patches' content store. The version's stored
hash and byte count are checked before execution. Published versions retain
their own server artifacts across new publishes and rollbacks.

Company databases are created lazily, not in the seed or template.
`@patchy/company-database/testing` layers use the embedded cluster's provisioning
login and drop their company databases after closing the scoped pools. The
company-database suites exercise concurrency on real Postgres and shared
inventory behavior over a directory-backed PGlite layer. PGlite's one connection
does not establish multi-session locking correctness; its local state is
recreatable, with fsync off and normalized `int8`/`DATE` codecs.

Runtime admission tests use `HttpApiTest` with offline signed browser sessions;
the server's socket test publishes real versions and checks historical and live
sharing. `/api/runtime/call` admits `me`, the seven `tables.*` operations, the
three `shared.*` reads, `files.list`/`files.delete`, and `postgres.list`/`postgres.get`/
`postgres.getMany`/`postgres.query`; file bytes use separate routes.
A company version needs a browser session, never the dev machine token; a current
public version returns null for `me` and refuses owned-table, shared-table, file and Postgres access.
Required headers and request shapes are in [API.md](API.md#runtime).
The runtime log baseline is applied by all three migration entrypoints above.
Postgres connection reads use one statement runner over native `pg` or a killable
PGlite worker transport. Exercise discovery-to-fixture parity and verify that a
timed-out call destroys its backend while the next call succeeds. The statement,
service, row, byte and pool limits are spec constants, not environment settings.

Repo-mode `patchy publish` builds and sends table manifests to `POST /api/publish`
at tiers 0 and 1. Tier 1 uses the same shell broker locally and when hosted.
The owner reads cumulative metadata through `GET /api/patches/:patchId/inventory`.
For table changes, exercise the Primitives contract suites over both Postgres
and PGlite, and the real-Postgres publish/unique-index races. Ordinary table
operations lease an existing company database; only resource-introducing
publishes call `ensureReady`. No new platform migration belongs to Primitives.

Explicit readiness also upgrades metadata in already-ready company databases
(including recorded ref targets); it preserves their inventory and does not
retain a query-pool reservation. Normal leases never bootstrap or upgrade.

The offline tier 1 acceptance suite runs with
`pnpm exec playwright test -c playwright.tier1.config.ts`. It owns an isolated
server and Postgres, fake Clerk keys and signed session cookies; it does not use
the daily-driver instance or live Clerk. Chromium and Firefox run serially.
Install the matching Playwright Chromium and Firefox builds first. Native
`window.print()` checks use isolated headed browsers, virtual PDF printers and
`pdftotext`; they require a display (X11 for Chromium), never a physical printer.
The resulting PDFs must contain both the first and last of 2,000 rows.
The shell broker is bundled from the API schemas before builds and tests;
`@patchy/serving/shell` has no auth/platform imports so a local runtime can reuse it.

## Running the server by hand

The runner is the normal path. The server can still be started directly
against a Postgres you point it at:

Unlike `pnpm dev`, a hand-started server reads the environment you give it, not
the developer `dev.env`. Export `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` and
`PATCHY_CREDENTIAL_KEYS` securely first, then supply a disposable Postgres URL
and the browser-facing origin:

```sh
DATABASE_URL=postgres://... PATCHY_PUBLIC_BASE_URL=http://localhost:3000 \
  PATCHY_COMPANY_DB_ADMIN_URL=postgres://... PATCHY_COMPANY_DB_URL=postgres://... \
  PATCHY_STORAGE_DIR=.local/manual-storage pnpm --filter @patchy/server dev
```

All seven variables are required: `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`,
`CLERK_SECRET_KEY`, `PATCHY_PUBLIC_BASE_URL`, `PATCHY_COMPANY_DB_ADMIN_URL`,
`PATCHY_COMPANY_DB_URL` and `PATCHY_CREDENTIAL_KEYS`. None has a default; startup
refuses a missing variable and names it. `PATCHY_PUBLIC_BASE_URL` must be an
HTTP(S) origin, without credentials, a path, query or fragment, and must match
the URL used in the browser; it is Clerk's single origin authority.
`PORT` defaults to 3000; set it and the public origin together if changing ports.
The optional Clerk settings have the same rules as [above](#clerk-keys).

The company admin URL targets a maintenance database with a provisioning login
allowed to `CREATE DATABASE` and assign the data role as owner. The data URL is a
template: its database path is replaced by the company's placement. Production
uses separate logins; the embedded superuser is only for disposable local runs.
`PATCHY_COMPANY_DB_MAX_BACKENDS` defaults to 200 retained company-pool slots per
process. Budget this across replicas, plus ordinary platform connections, two
independent placement connections, one admin connection, and temporary provisioning
data connections, against the server limit. Each company's pool defaults to four
connections, with per-company overrides through `OperatingLimits.setOverride`.
At saturation, up to 32 acquisitions wait at most one second within their caller's
deadline; overflow or expiry returns `busy` with retry and limit metadata.
The Runtime company token bucket separately defaults to 100 calls/second with a
burst of 200, including company-scoped calls that use no company connection.
Public `me` calls do not spend company tokens. Both counts are per host replica.
Patch-local dev does not simulate these operating limits. The
[company database ADR](adr/ADR-0009-one-postgres-database-per-company.md) owns the
pool and lock contract; ordinary index creation can block writers.

### Neon company databases

Use direct Neon URLs and `sslmode=verify-full`. The native Effect driver does not
support libpq's `channel_binding` URL parameter; a copied Neon URL containing it
is rejected at startup. Configure a supported verified-TLS URL explicitly rather
than relying on the application to silently discard connection settings.

Provision roles as an operator. After each data-role `CREATE ROLE`, run
`GRANT patchy_data TO patchy_admin WITH SET TRUE, INHERIT FALSE`, substituting
the `PATCHY_COMPANY_DB_URL` data login and `PATCHY_COMPANY_DB_ADMIN_URL` provisioning
login. These roles are shared across placements, not created per company.
`createrole_self_grant = 'set'` on the
creating admin is an alternative. The data login must remain unprivileged.
Company creation uses `template0`, not `template1`: background workers connected
to `template1` can block copying that database while the placement transaction is
open. Patchy initializes its own inventory in the pristine database.

To reclaim a disposable company database after its pools close, use one reserved
maintenance connection: `SET ROLE patchy_data`, `DROP DATABASE <company_database>`,
then `RESET ROLE`, outside a transaction. Never infer the database name from a
company handle; use its placement. Normal patch reclamation drops namespaces,
not whole company databases.

Cancellation uses the driver's protocol request because Neon's proxy pid is not
a server backend id. Idle disconnects remove pooled connections; the next work
acquires a fresh one without replaying an interrupted mutation. Disable suspend
on production compute; do not change the spike or production settings as part of
local tests.

### Initial credentials

Startup migrates but creates no credential. For normal use, sign in at `/join`,
create or join a company, then run `pnpm patchy login --api-url <origin>` and
publish with that same `--api-url`. The flag deliberately bypasses worktree
discovery, including its development seed.
For a seeded disposable database instead, apply `applyDevSeed(DATABASE_URL)`
from `@patchy/auth/seed` after migration, optionally passing your Clerk user id
as its second argument; use the development token through `PATCHY_API_TOKEN`.
The seed is for development only.

`pnpm seed:dev` publishes the accepted HTML fixture corpus. Both `PATCHY_API_URL`
and `PATCHY_API_TOKEN` are required; neither has a default.

### Runtime wide events

The server emits one JSON line for each runtime call or file-byte request,
including refusals and failures. No key is needed for stdout. `pnpm dev` captures
these lines with the other server output; `pnpm dev logs` displays them.

For PostHog delivery when running the server by hand, set
`PATCHY_POSTHOG_API_KEY` securely. `PATCHY_POSTHOG_HOST` defaults to
`https://us.i.posthog.com` and accepts an HTTP(S) collector URL for local checks.
Business events and wide events share one client and one shutdown flush, bounded
to three seconds. The worktree runner does not forward these optional settings.

Set `PATCHY_REPLICA` and `PATCHY_DEPLOYMENT_REVISION` in a deployment to identify
its host and running build. Without them, the server generates a replica id at
startup and uses revision `development`. The event's top-level `deploymentRevision`
identifies that build; `limits[].configRevision.deploymentRevision` is instead the
automatically computed operating-limit fingerprint described in [Limits](limits.md).
Each limit measurement also carries the company's `overrideRevision`.
Request records include known operation names, outcome, refusal code and limit id
when present, duration, trace linkage and trusted attribution. Tier 1 operations
have no patch-authored handler, so `handler` and `kind` are omitted.
Records omit request bodies, filenames, SQL and credentials.
Every event has `sampleProbability: 1`; delivery is best effort, not metering.

The patch repo's local runtime uses the same record with compact stdout output.
`@patchy/analytics/wide-events` exposes `formatDev(event, { json: true })` and
`layerDev({ json: true })` for full records. Structured `dev.log` retrieval belongs
to the tier 2 dev-loop ticket; the existing CLI log response is unchanged.

## Postgres

`DATABASE_URL` is required: Postgres is the relational store. The server migrates
the database on startup, before it listens; the packed-CLI e2e starts an
embedded Postgres of its own under its temp root. Object bytes use the separate
content store below.

Do not commit real database URLs or generated tokens.

## Neon Object Storage

When `PATCHY_S3_BUCKET` is set, the server uses Neon Object Storage through its
S3-compatible API. Otherwise it stores bytes under `PATCHY_STORAGE_DIR` on the
local filesystem. Local development and offline tests keep the filesystem
layer; the worktree runner does not forward ambient storage settings.

Configure all five dedicated settings for a server deployment. The
[live contract suite](#live-content-store) uses the spike names listed above.

| Setting                       | Value                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `PATCHY_S3_BUCKET`            | The name of an existing private bucket.                   |
| `PATCHY_S3_ENDPOINT`          | The S3 endpoint for the Neon branch that owns the bucket. |
| `PATCHY_S3_REGION`            | The signing region supplied by Neon.                      |
| `PATCHY_S3_ACCESS_KEY_ID`     | The Neon Object Storage access key id.                    |
| `PATCHY_S3_SECRET_ACCESS_KEY` | The corresponding Neon Object Storage secret access key.  |

The layer reads these settings through Effect Config and uses path-style S3
requests. The endpoint scopes the bucket to its Neon branch: the same bucket
name at a different branch endpoint is a different store. Supply the branch
endpoint itself, not an object URL. Provision the private bucket separately;
startup neither creates it nor changes its access policy.

These are Neon Object Storage credentials, separate from AWS host credentials.
The layer does not use the AWS default credential chain, instance roles or
ambient `AWS_*` settings. Keep credentials outside git and out of logs.
With `PATCHY_S3_BUCKET` set, incomplete S3 configuration fails startup instead of
falling back to disk or waiting for the first publish.
