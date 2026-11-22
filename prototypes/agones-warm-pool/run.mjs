// Throwaway phase A experiment: real Agones controllers, synthetic company work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const context = "colima-patchy-k8s-prototype";
const namespace = "patchy-agones-prototype";
const kubectl = process.env.KUBECTL ?? "kubectl";
const command = process.argv[2];
const k = (args, input) =>
  execFileSync(kubectl, ["--context", context, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  }).trim();
const json = (args) => JSON.parse(k([...args, "-o", "json"]));
const apply = (resource) => k(["apply", "-f", "-"], JSON.stringify(resource));
const log = (event, detail) => console.log(JSON.stringify({ event, ...detail }));
const wait = async (name, check) => {
  for (const until = Date.now() + 180_000; Date.now() < until;) {
    const result = check();
    if (result) return result;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for ${name}`);
};
const servers = () => json(["-n", namespace, "get", "gameservers"]).items;
const call = (pod, path, method) =>
  JSON.parse(
    k([
      "-n",
      namespace,
      "exec",
      pod,
      "-c",
      "worker",
      "--",
      "node",
      "--input-type=module",
      "-e",
      `const r=await fetch(${JSON.stringify(`http://127.0.0.1:8081${path}`)}, {method:${JSON.stringify(method)}}); if(!r.ok)throw new Error(await r.text()); console.log(await r.text());`
    ])
  );

// Never use the current context implicitly, and never provision cloud resources.
k(["get", "nodes", "-o", "name"]);
if (command === "install") {
  apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: "agones-system" } });
  k([
    "apply",
    "--server-side",
    "--force-conflicts",
    "--field-manager=patchy-agones-prototype",
    "-f",
    "https://raw.githubusercontent.com/googleforgames/agones/v1.62.0/install/yaml/install.yaml"
  ]);
  // Single-node local sizing; allocator/ping services are not used by this slice.
  for (const [name, replicas] of [
    ["agones-controller", 1],
    ["agones-extensions", 1],
    ["agones-allocator", 0],
    ["agones-ping", 0]
  ]) {
    k(["-n", "agones-system", "scale", `deployment/${name}`, `--replicas=${replicas}`]);
    if (replicas > 0) {
      k([
        "-n",
        "agones-system",
        "patch",
        `deployment/${name}`,
        "--type=strategic",
        "-p",
        JSON.stringify({
          spec: {
            template: {
              spec: {
                containers: [
                  {
                    name,
                    env: [{ name: "LOG_SIZE_LIMIT_MB", value: "20" }],
                    resources: {
                      requests: { "ephemeral-storage": "128Mi" },
                      limits: { "ephemeral-storage": "256Mi" }
                    }
                  }
                ]
              }
            }
          }
        })
      ]);
    }
  }
  k([
    "-n",
    "agones-system",
    "wait",
    "--for=condition=Available",
    "deployment",
    "--all",
    "--timeout=180s"
  ]);
  log("installed", { agones: "1.62.0", context });
} else if (command === "run" || command === "growth-idle") {
  const growthIdle = command === "growth-idle";
  // Re-running requires an explicit clean: do not silently destroy prior evidence.
  k(["create", "namespace", namespace]);
  apply({ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "agones-sdk", namespace } });
  apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: "agones-sdk", namespace },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "agones-sdk" },
    subjects: [{ kind: "ServiceAccount", name: "agones-sdk", namespace }]
  });
  apply({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "worker", namespace },
    data: { "worker.mjs": await readFile(new URL("worker.mjs", import.meta.url), "utf8") }
  });
  apply({
    apiVersion: "agones.dev/v1",
    kind: "Fleet",
    metadata: { name: "companies", namespace },
    spec: {
      replicas: 1,
      template: {
        spec: {
          ports: [],
          template: {
            spec: {
              containers: [
                {
                  name: "worker",
                  image: "node:24.20.0-bookworm-slim",
                  command: ["node", "/prototype/worker.mjs"],
                  env: [{ name: "IDLE_AFTER_MS", value: growthIdle ? "10000" : "0" }],
                  resources: { requests: { cpu: "50m", memory: "64Mi" } },
                  volumeMounts: [{ name: "worker", mountPath: "/prototype", readOnly: true }]
                }
              ],
              volumes: [{ name: "worker", configMap: { name: "worker" } }]
            }
          }
        }
      }
    }
  });
  apply({
    apiVersion: "autoscaling.agones.dev/v1",
    kind: "FleetAutoscaler",
    metadata: { name: "ready-buffer", namespace },
    spec: {
      fleetName: "companies",
      policy: { type: "Buffer", buffer: { bufferSize: 1, minReplicas: 1, maxReplicas: 4 } },
      sync: { type: "FixedInterval", fixedInterval: { seconds: 2 } }
    }
  });
  const allocate = async (company) => {
    const spare = await wait("one ready environment", () =>
      servers().find((server) => server.status.state === "Ready")
    );
    log("ready", { name: spare.metadata.name });
    const allocation = JSON.parse(
      k(
        ["create", "-f", "-", "-o", "json"],
        JSON.stringify({
          apiVersion: "allocation.agones.dev/v1",
          kind: "GameServerAllocation",
          metadata: { namespace },
          spec: {
            selectors: [{ matchLabels: { "agones.dev/fleet": "companies" } }],
            metadata: { labels: { "prototype-company": company } }
          }
        })
      )
    );
    assert.equal(allocation.status.state, "Allocated");
    assert.equal(allocation.status.gameServerName, spare.metadata.name);
    const identity = await wait("allocation metadata at the worker", () => {
      const observed = call(spare.metadata.name, "/identity", "GET");
      return observed.company === company && observed.state === "Allocated" && observed;
    });
    assert.equal(identity.company, company);
    assert.equal(identity.state, "Allocated");
    log("allocated", identity);
    return spare.metadata.name;
  };
  const first = await allocate("company-a");
  if (growthIdle) {
    const second = await allocate("company-b");
    const third = await allocate("company-c");
    assert.equal(new Set([first, second, third]).size, 3);
    const pool = (allocatedCount) => {
      const current = servers();
      const pods = json(["-n", namespace, "get", "pods"]).items;
      const ready = current.filter((server) => server.status.state === "Ready").length;
      const allocated = current.filter((server) => server.status.state === "Allocated").length;
      return (
        ready === 1 &&
        allocated === allocatedCount &&
        current.length === allocatedCount + 1 &&
        pods.length === allocatedCount + 1 &&
        pods.every((pod) => !pod.metadata.deletionTimestamp) && {
          ready,
          allocated,
          total: current.length,
          pods: pods.length
        }
      );
    };
    log("grown", await wait("three allocated plus one ready", () => pool(3)));
    for (const pod of [first, second, third]) call(pod, "/activity", "POST");
    log("activity", { companies: ["company-a", "company-b", "company-c"], idleAfterMs: 10000 });
    const partial = await wait("idle A and B removed while C stays active", () => {
      call(third, "/activity", "POST");
      const current = servers();
      if (current.some((server) => [first, second].includes(server.metadata.name))) return false;
      assert(
        current.some(
          (server) => server.metadata.name === third && server.status.state === "Allocated"
        )
      );
      return pool(1);
    });
    log("partly_idle", { ...partial, activeCompany: "company-c", released: [first, second] });
    log("activity_stopped", { company: "company-c" });
    log(
      "idle_floor",
      await wait("all idle allocations removed and one spare remains", () => pool(0))
    );
    log("pass", {
      applicationOwns: ["idle detection", "SDK shutdown request"],
      controllerOwns: ["allocation", "replenishment", "capacity growth", "capacity shrink"]
    });
  } else {
    const replacement = await wait("automatic spare replenishment", () =>
      servers().find((server) => server.status.state === "Ready")
    );
    assert.notEqual(replacement.metadata.name, first);
    log("replenished", { ready: replacement.metadata.name, allocated: first });
    call(first, "/shutdown", "POST");
    await wait(
      "allocated environment removed",
      () => !servers().some((server) => server.metadata.name === first)
    );
    await wait(
      "allocated Pod removed",
      () => !json(["-n", namespace, "get", "pods"]).items.some((pod) => pod.metadata.name === first)
    );
    log("shutdown", { removed: first });
    log("pass", { controllerOwns: ["ready pool", "allocation", "replenishment", "shutdown"] });
  }
} else if (command === "clean") {
  k(["delete", "namespace", namespace, "--ignore-not-found", "--wait=true"]);
  log("cleaned", { namespace });
} else {
  throw new Error("Usage: node prototypes/agones-warm-pool/run.mjs install|run|growth-idle|clean");
}
