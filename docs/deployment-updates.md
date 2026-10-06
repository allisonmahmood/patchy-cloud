# Deployment updates

Run this in a dedicated worktree to see the update bell against a local Patchy instance:

```sh
pnpm dev
pnpm updates:sync --watch
```

Sign in as **Dev Machine**. The watcher reads the real Deploy Action history and writes confirmed deployments to this worktree's dev storage. It never deploys or writes production history. See [Operations](OPERATIONS.md#local-history-from-the-deploy-action) for its safeguards and note generation.

To seed sample updates without GitHub access, use a clean local instance:

```sh
pnpm updates:seed
pnpm updates:seed --simulate-deployment
```

The second command appends one local sample. The seeder refuses to add samples to Action-backed history. It only writes to this worktree's loopback dev instance.

Run the notification browser checks with:

```sh
pnpm exec playwright test -c playwright.tier1.config.ts --project=chromium updates.spec.ts
```

The tests cover unread updates in the bell, individual and bulk read state, pagination, cross-tab changes, unavailable storage, and fresh deployments arriving during a bulk read. Their deployment history is simulated in disposable local test instances.
