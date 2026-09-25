<!-- PROTOTYPE for #311 -->

# Tier 2 execution-service spike (ECS Fargate + workerd + Neon)

Throwaway prototype for [#311](https://github.com/allisonmahmood/patchy-cloud/issues/311): does the self-hosted execution service hold up in practice? A handler bundle runs in a credential-free Fargate task inside open-source workerd's Worker Loader; a stub of Patchy's runtime host mints a per-invocation capability, brokers table callbacks into one SERIALIZABLE transaction per mutation on Neon, and runs the wake path's pool of pre-started unbound tasks. Measured numbers and the awkward list are in [RESULTS.md](RESULTS.md).

Not production code: no tests, no Effect, no error handling beyond what makes it run. It lives outside the pnpm workspace on purpose.

## Try it

Each step is one command. `neon-bench/` belongs to the other lane and is not touched here.

```sh
set -a; . ~/.config/patchy-cloud/aws-spike.env; set +a          # AWS keys + every SPIKE_* id
export DATABASE_URL=$(grep '^DATABASE_URL=' ~/.config/patchy-cloud/neon-spike.env | cut -d= -f2- | tr -d "'\"")
cd prototypes/tier2-exec
npm install              # esbuild for the handler bundle, playwright for the ingress check
./infra/build.sh         # bundle handlers, npm install exec/ and host/, push two images with crane (no docker)
./infra/deploy.sh        # register task definitions, run the host service behind the ALB, wait for healthy
./bench/run.sh           # every measurement through the ALB; raw output in bench/out/
./infra/destroy.sh       # stop the service and every exec task this lane started
```

Local loop without ECS (two supervisors, host in local mode):

```sh
node handlers/build.mjs && mkdir -p host/bundles && cp handlers/dist/* host/bundles/
(cd exec && PORT=8081 WORKERD_PORT=8787 node supervisor.ts &) ; (cd exec && PORT=8082 WORKERD_PORT=8788 node supervisor.ts &)
(cd host && EXEC_URLS=http://127.0.0.1:8081,http://127.0.0.1:8082 node server.ts &)
HOST=http://127.0.0.1:8080 node bench/04-warm.mjs
```

## What is where

| Directory   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handlers/` | A patch repo's `server/` as an agent would write it against the #296 contract: `contacts`, `abuse`, `probe` modules on a tiny `t` stub (`patchy.ts`). `build.mjs` bundles them with esbuild into one ESM guest module per version (`dist/v1.js`, `dist/v2.js`) plus a `manifest.json` of `module.handler -> kind`.                                                                                                                                                                     |
| `exec/`     | The execution container: `node:24-slim` + `supervisor.ts` (port 8080, proxies to workerd on localhost, reads RSS from `/proc`, kills and restarts workerd on a wall-clock overrun or an RSS bound) + `config.capnp` + `loader.js` (the loader Worker with the `workerLoader` binding: one dynamic Worker per company/patch/version, `globalOutbound` bound to a refusing loopback, callbacks over a loopback RPC stub in `ctx.props` that carries the invocation id, never the token). |
| `host/`     | Stub of Patchy's runtime host: `server.ts` (`/invoke`, `/callback`, `/stream`, `/healthz`, `/admin/*`), `db.ts` (`pg` pool to Neon, schema, table ops), `pool.ts` (the wake path: N pre-started unbound Fargate tasks, bind on first open, stop on idle).                                                                                                                                                                                                                              |
| `infra/`    | `build.sh` (crane), `deploy.sh` (task definitions + the host service), `destroy.sh`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bench/`    | One script per measurement, `lib.mjs` for the ALB client and percentiles, `run.sh` to run them all.                                                                                                                                                                                                                                                                                                                                                                                    |

## How an invocation flows

1. `POST /invoke` with `x-viewer` and `as` (`viewer`, `patch`, `viewer-via-patch`). The host checks the four-slot per-company cap (`busy`), acquires the company's bound exec task (binding one from the pool on first open), writes the `invocations` row, and mints a capability for attempt 1.
2. The host posts `{ name, bundle-if-not-loaded, invocationId, capability, hostUrl, handler, args, budgetMs }` to the task's supervisor, which starts the watchdog timer and forwards to workerd.
3. The loader Worker gets the cached dynamic Worker for `company/patch@version` (loading it from the bundle the first time) and calls its default entrypoint with `props: { invocationId, callbacks }`, where `callbacks` is `ctx.exports.Callbacks({ props: { invocationId } })`.
4. Guest `ctx.tables.*` calls go over that stub; the loopback looks up the capability by invocation id and posts to the host's `/callback` with `Authorization: Bearer <capability>`. A mutation's first callback opens `BEGIN ISOLATION LEVEL SERIALIZABLE` with a transaction-scoped `statement_timeout`; later callbacks join it; each operation writes its principal to `operations`.
5. On return the host commits (or rolls back on a handler error / failed callback), retries the whole handler up to three attempts on `40001`, and ends the capability so a replay is refused.
