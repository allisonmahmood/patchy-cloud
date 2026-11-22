# Agones warm-pool experiment

**Throwaway prototype; not intended to merge.** First slice of phase A in
[PRD #1506](https://github.com/allisonmahmood/patchy-cloud/issues/1506), tracked by
[#1507](https://github.com/allisonmahmood/patchy-cloud/issues/1507).

Question: can Agones own a synthetic ready pool, company allocation, spare
replenishment and shutdown without Patchy's fleet controller?

## Run

Requires Node 22+, kubectl and Colima. Start a dedicated local cluster; the runner
always names its context and never changes your active context:

```sh
colima start patchy-k8s-prototype --cpu 4 --memory 6 --disk 25 --kubernetes --activate=false
node prototypes/agones-warm-pool/run.mjs install
node prototypes/agones-warm-pool/run.mjs run
```

`install` installs pinned Agones 1.62.0 into this disposable cluster, including
cluster-wide CRDs, roles and admission webhooks. It requires network access to
GitHub and container registries. Server-side apply avoids the annotation-size
limit of client-side apply on Agones's large CRDs. Installation takes ownership
of the pinned manifest fields and sizes controller/extension deployments to one
replica each, with unused allocator/ping deployments at zero. This is deliberately
local sizing, not a production installation. Controller logs are limited to 20 MB with 128 MiB storage
requests instead of the upstream manifest's roughly 10 GiB per controller.
`KUBECTL` can name a kubectl binary outside PATH. The synthetic worker uses Node 24.20.0.

The run creates only the `patchy-agones-prototype` namespace, a namespace-scoped
SDK service-account binding, a ConfigMap with a small synthetic worker, a Fleet,
a FleetAutoscaler and one allocation. The worker
uses Agones's SDK sidecar to become ready, report health and request shutdown.
There is no image build, production code, database, AWS call or real workerd.

Successful output has five JSON events: `ready`, `allocated`, `replenished`,
`shutdown`, and `pass`. Allocation attaches the company label;
the worker reads it back through the SDK. The runner waits for a different ready
server and observes both the allocated GameServer and Pod disappearing after SDK
shutdown. It never deletes the allocated Pod to manufacture that result.

## Inspect and clean

```sh
kubectl --context colima-patchy-k8s-prototype -n patchy-agones-prototype get fleet,gameservers,fleetautoscaler,pods
node prototypes/agones-warm-pool/run.mjs clean
colima stop patchy-k8s-prototype
```

`clean` removes only the experiment namespace, retaining installed controllers.
Run it before another attempt. Stopping the profile releases local CPU/memory;
`colima delete patchy-k8s-prototype` removes the entire dedicated cluster and its
disk when no longer wanted. Neither command touches other profiles.

## What this establishes

Agones, not custom replenishment code, owns the pool and allocation transitions.
The runner is a scenario driver; the worker is only a lifecycle SDK client.

It does not establish company security, ambiguous-allocation retry safety,
crash recovery, image rollouts, idle policy, scale benchmarks, EKS/Fargate
compatibility or cost savings. It covers only the first slice of phase A;
Knative and the real execution engine remain later work.

References: [Fleet](https://agones.dev/site/docs/reference/fleet/),
[allocation](https://agones.dev/site/docs/reference/gameserverallocation/),
[FleetAutoscaler](https://agones.dev/site/docs/reference/fleetautoscaler/),
[SDK](https://agones.dev/site/docs/guides/client-sdks/).
