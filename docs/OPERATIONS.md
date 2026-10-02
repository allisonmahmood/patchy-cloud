# Operating Patchy Cloud

Running the server outside `pnpm dev`: its configuration, the stores, the
execution service and fleet, and the tier 2 spike deploy. The local loop is in
[Development](DEVELOPMENT.md). Production infrastructure and the first deploy,
[#415](https://github.com/allisonmahmood/patchy-cloud/issues/415) and
[#416](https://github.com/allisonmahmood/patchy-cloud/issues/416), are not built.

## Running the server by hand

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
The optional Clerk settings follow [Development: Clerk keys](DEVELOPMENT.md#clerk-keys).

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

### Wide events

The server writes one JSON line to stdout for every request, including refusals
and failures: an event with `type: "request"`. Runtime calls and file-byte
requests record their own, described below. Every other request names its
matched route template in `route`, such as `/api/patches/:patchRef` or
`/:company/:name/*`, never the URL or query string. An unmatched request carries
its fallback's pattern, `/*` or `/api/*`. A request the API guard answers itself
is recorded under `/api/*`; its 429 carries the refusing `limitId`.

`method` and `status` are what the client sent and received. A 2xx or 3xx is
`success`; a 4xx is `refused`, with the `code` from its body when it has one; a
5xx or a defect is `failure`; a dropped connection is `interrupted`. `viewerId`
and `companyId` name the signed-in user, or the user a machine token belongs to;
the token itself is never recorded. Routes about one patch add `patchId` and a
`versionId`: the version a page served, a publish created or a rollback made
current, and otherwise the patch's current version.
`requestBytes` is the declared length, and `responseBytes` is the body sent.
Health probes (`/healthz`) emit nothing.

No key is needed for stdout. `pnpm dev` captures these lines with the other
server output; `pnpm dev logs` displays them.

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
Runtime request records include known operation names, outcome, refusal code and
limit id when present, duration, trace linkage and trusted attribution. Tier 1
operations have no patch-authored handler, so `handler` and `kind` are omitted.
Records omit tokens, cookies, session values, device and invite codes, request and
response bodies, filenames, SQL, credentials, source addresses and URLs.
Every event has `sampleProbability: 1`; delivery is best effort, not metering.

#### Finding a request in CloudWatch

In a deployment, these lines land in the host service's log group. CloudWatch Logs
Insights discovers their JSON fields. Filter on `type`, `route`, `viewerId`,
`outcome`, `code` and the time range; `deploymentRevision` names the build that
served each request. When someone reports a failed publish:

```
fields @timestamp, status, outcome, code, patchId, versionId, durationMs, deploymentRevision, traceId
| filter type = "request" and route = "/api/publish" and viewerId = "usr_…"
| sort @timestamp desc
| limit 20
```

Then filter on its `traceId` to see the events nested under that request.

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
[live contract suite](#the-live-content-store-suite) uses the spike names listed above.

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

### The live content store suite

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
is never part of `pnpm test` or `pnpm verify`. Ordinary local development uses
the filesystem; the offline storage contract runs against both the filesystem
and an isolated loopback HTTP fixture backed by a Map. The fixture implements only
PutObject, GetObject, DeleteObject, and paginated ListObjectsV2, including missing
keys and XML escaping. Both the contract and fault-injection tests use the real
S3 client over HTTP. The fixture does not verify signatures or emulate other S3
features; the live Neon suite verifies provider compatibility.

## The execution service

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
require a privileged supervisor. Each resident scope kills and reaps its child
before removing the temporary configuration directory. Clean stops, watchdog
kills, child crashes and supervisor shutdown all close that scope.

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

### ECS provider configuration

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

## Deploying only the tier 2 spike

The ECS provider, reproducible host/exec image and guarded spike deploy script
are built, and role-only Fargate acceptance passed on
[#406](https://github.com/allisonmahmood/patchy-cloud/issues/406). This spike is not production
infrastructure [#415](https://github.com/allisonmahmood/patchy-cloud/issues/415)
or the first deploy [#416](https://github.com/allisonmahmood/patchy-cloud/issues/416);
both remain unbuilt.

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

Build on Linux x64 with Node 24.20.0, pnpm 11.28.3, GNU tar and crane v0.22.1:

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
