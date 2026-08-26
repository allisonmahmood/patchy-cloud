# Patchy Cloud Development

## Local Mode Without Postgres

The default local mode uses filesystem-backed metadata and filesystem-backed HTML storage:

```sh
pnpm install
PATCHY_BOOTSTRAP_API_TOKEN=dev-token pnpm --filter @patchy/server dev
```

In another shell:

```sh
pnpm --filter @patchy/cli build
# Enter the local bootstrap token at the hidden prompt.
PATCHY_STATE_DIR=.local/cli node packages/cli/dist/index.js auth set --api-url http://localhost:3000
PATCHY_STATE_DIR=.local/cli node packages/cli/dist/index.js upload examples/plan.html
```

Once the package is linked, the same commands are available as `patchy auth set` and `patchy upload`.

The server stores local state under `.local/` unless configured otherwise.

## Postgres Mode

Set `PATCHY_DB_DRIVER=postgres` and `DATABASE_URL` when a Postgres instance is available:

```sh
PATCHY_DB_DRIVER=postgres \
DATABASE_URL=... \
PATCHY_BOOTSTRAP_API_TOKEN=... \
pnpm db:migrate
```

Do not commit real database URLs or generated tokens.

## Azure Blob Storage

If you use Azure Blob storage, these are the variables:

```env
PATCHY_STORAGE_DRIVER=azure-blob
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=
```

The server uses managed identity when `AZURE_STORAGE_CONNECTION_STRING` is absent.
Connection-string auth remains available for local Azure testing and deployments that do not use Azure managed identity.
