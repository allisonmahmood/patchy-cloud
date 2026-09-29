import { spawnSync } from "node:child_process";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

// This deployer deliberately has no account, region or project override.
const account = "614817375332";
const region = "us-east-1";
const project = "fancy-mode-72369071";
const targetAttributes = [
  { Key: "deregistration_delay.timeout_seconds", Value: "90" },
  { Key: "stickiness.enabled", Value: "true" },
  { Key: "stickiness.type", Value: "app_cookie" },
  { Key: "stickiness.app_cookie.cookie_name", Value: "patchy_stream_affinity" }
];
const albAttributes = [
  { Key: "routing.http2.enabled", Value: "true" },
  { Key: "idle_timeout.timeout_seconds", Value: "3600" }
];
const directory = path.resolve(".local/tier2-spike");
const stateFile = path.join(directory, "state.json");
const command = process.argv[2];
const image = process.argv[3];
if (!["status", "up", "down", "rollout", "seal", "promote", "drain"].includes(command)) {
  throw new Error(
    "Usage: node scripts/tier2-spike.mjs status|up <image.tar>|rollout <image.tar>|seal <image.tar>|promote|drain|down"
  );
}
const run = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) throw new Error(`${bin} ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
};
const load = (file) =>
  JSON.parse(
    run("bash", [
      "-c",
      'set -a; source "$1"; node -e "console.log(JSON.stringify(process.env))"',
      "spike",
      file
    ])
  );
const awsEnv = load(path.join(homedir(), ".config/patchy-cloud/aws-spike.env"));
const neon = load(path.join(homedir(), ".config/patchy-cloud/neon-spike.env"));
const aws = (service, operation, input = {}) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "patchy-spike-request-"));
  const file = path.join(temporary, "input.json");
  try {
    writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    return JSON.parse(
      run(
        "aws",
        [
          service,
          operation,
          "--region",
          region,
          "--output",
          "json",
          "--cli-input-json",
          `file://${file}`
        ],
        {
          env: { ...awsEnv, AWS_REGION: region, AWS_DEFAULT_REGION: region, AWS_PAGER: "" }
        }
      ) || "{}"
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};
const identity = aws("sts", "get-caller-identity");
if (
  identity.Account !== account ||
  identity.Arn !== `arn:aws:iam::${account}:user/patchy-tier2-spike-agent`
)
  throw new Error("Refusing a non-spike AWS identity.");
if (neon.NEON_PROJECT_ID !== project) throw new Error("Refusing a non-spike Neon project.");
if (!neon.NEON_API_KEY)
  throw new Error("NEON_API_KEY is required to verify the approved project before any mutation.");
const neonGet = async (resource) => {
  let response;
  try {
    response = await fetch(`https://console.neon.tech/api/v2/projects/${project}${resource}`, {
      headers: { Authorization: `Bearer ${neon.NEON_API_KEY}`, Accept: "application/json" },
      redirect: "error"
    });
  } catch {
    throw new Error(`Cannot verify the approved Neon project: GET ${resource || "/"} failed.`);
  }
  if (!response.ok)
    throw new Error(
      `Cannot verify the approved Neon project: GET ${resource || "/"} returned HTTP ${response.status}.`
    );
  try {
    return await response.json();
  } catch {
    throw new Error("Neon project verification returned invalid JSON.");
  }
};
const approvedProject = (await neonGet("")).project;
if (approvedProject?.id !== project || approvedProject.region_id !== `aws-${region}`)
  throw new Error("Neon API did not return the approved project in the approved region.");
let databaseUrl;
try {
  databaseUrl = new URL(neon.DATABASE_URL);
} catch {
  throw new Error("DATABASE_URL is not a valid PostgreSQL URL.");
}
if (
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
  (databaseUrl.port && databaseUrl.port !== "5432") ||
  databaseUrl.hash ||
  [...databaseUrl.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
)
  throw new Error(
    "DATABASE_URL must use the approved PostgreSQL endpoint without connection-routing overrides."
  );
const endpointHost = databaseUrl.hostname.replace(/-pooler(?=\.)/, "");
const endpoint = (await neonGet("/endpoints")).endpoints?.find(
  (entry) => entry.host === endpointHost
);
if (!endpoint?.branch_id || endpoint.region_id !== approvedProject.region_id)
  throw new Error("DATABASE_URL does not belong to an endpoint of the approved Neon project.");
const branchPath = `/branches/${encodeURIComponent(endpoint.branch_id)}`;
const storage = await neonGet(`${branchPath}/storage`);
let storageUrl;
let approvedStorageUrl;
try {
  storageUrl = new URL(neon.AWS_ENDPOINT_URL_S3);
  approvedStorageUrl = new URL(storage.s3_endpoint);
} catch {
  throw new Error(
    "Neon storage verification requires valid configured and API-provided S3 endpoints."
  );
}
if (
  !storage.enabled ||
  storageUrl.protocol !== "https:" ||
  storageUrl.username ||
  storageUrl.password ||
  storageUrl.search ||
  storageUrl.hash ||
  storageUrl.href !== approvedStorageUrl.href ||
  neon.AWS_REGION !== storage.region
)
  throw new Error(
    "S3 endpoint or region does not match storage on the approved Neon database branch."
  );
const buckets = (await neonGet(`${branchPath}/buckets`)).buckets;
if (!neon.NEON_BUCKET || !buckets?.some((bucket) => bucket.name === neon.NEON_BUCKET))
  throw new Error("NEON_BUCKET does not belong to storage on the approved Neon database branch.");
const cluster = awsEnv.SPIKE_ECS_CLUSTER;
const owned = (tags) =>
  tags?.some(
    (tag) => (tag.key ?? tag.Key) === "patchy:spike" && (tag.value ?? tag.Value) === "tier2"
  );
const repositoryPrefix = `${account}.dkr.ecr.${region}.amazonaws.com/`;
if (!awsEnv.SPIKE_ECR_URI?.startsWith(repositoryPrefix))
  throw new Error("Refusing an ECR repository outside the approved account and region.");
const repositoryName = awsEnv.SPIKE_ECR_URI.slice(repositoryPrefix.length);
const repository = aws("ecr", "describe-repositories", {
  registryId: account,
  repositoryNames: [repositoryName]
}).repositories?.[0];
if (
  repository?.repositoryUri !== awsEnv.SPIKE_ECR_URI ||
  repository.repositoryArn !== `arn:aws:ecr:${region}:${account}:repository/${repositoryName}` ||
  !owned(aws("ecr", "list-tags-for-resource", { resourceArn: repository.repositoryArn }).tags)
)
  throw new Error("Refusing an untagged or foreign ECR repository.");
const vpc = aws("ec2", "describe-vpcs", { VpcIds: [awsEnv.SPIKE_VPC_ID] }).Vpcs?.[0];
if (vpc?.VpcId !== awsEnv.SPIKE_VPC_ID || vpc.OwnerId !== account || !owned(vpc.Tags))
  throw new Error("Refusing an untagged or foreign VPC.");
const publicSubnets = awsEnv.SPIKE_PUBLIC_SUBNETS?.split(",").map((subnet) => subnet.trim());
const subnetIds = [...new Set([...(publicSubnets ?? []), awsEnv.SPIKE_PRIVATE_SUBNET])];
if (!publicSubnets?.length || subnetIds.some((subnet) => !/^subnet-[0-9a-f]+$/.test(subnet ?? "")))
  throw new Error("Missing or invalid spike subnet IDs.");
const subnets = aws("ec2", "describe-subnets", { SubnetIds: subnetIds }).Subnets ?? [];
if (
  subnets.length !== subnetIds.length ||
  subnets.some((subnet) => subnet.VpcId !== vpc.VpcId || subnet.OwnerId !== account)
)
  throw new Error("Refusing subnets outside the approved tagged VPC.");
if (
  awsEnv.SPIKE_TASK_EXECUTION_ROLE_ARN !==
    `arn:aws:iam::${account}:role/patchy-tier2-spike-task-execution` ||
  awsEnv.SPIKE_HOST_TASK_ROLE_ARN !== `arn:aws:iam::${account}:role/patchy-tier2-spike-host-task` ||
  awsEnv.SPIKE_LOG_GROUP !== "/patchy/tier2-spike"
)
  throw new Error("Refusing roles or a log group outside the approved spike stack.");
const groups = [awsEnv.SPIKE_SG_HOST, awsEnv.SPIKE_SG_EXEC_BOOTSTRAP, awsEnv.SPIKE_SG_EXEC_SEALED];
for (const group of aws("ec2", "describe-security-groups", { GroupIds: groups }).SecurityGroups) {
  if (!owned(group.Tags) || group.OwnerId !== account || group.VpcId !== vpc.VpcId)
    throw new Error("Refusing an untagged or foreign security group.");
}
const describedCluster = aws("ecs", "describe-clusters", { clusters: [cluster], include: ["TAGS"] })
  .clusters[0];
if (
  !owned(describedCluster?.tags) ||
  !describedCluster.clusterArn?.startsWith(`arn:aws:ecs:${region}:${account}:cluster/`)
)
  throw new Error("Refusing an untagged or foreign cluster.");
for (const resource of [awsEnv.SPIKE_ALB_ARN, awsEnv.SPIKE_TARGET_GROUP_ARN]) {
  if (
    !resource.startsWith(`arn:aws:elasticloadbalancing:${region}:${account}:`) ||
    !owned(aws("elbv2", "describe-tags", { ResourceArns: [resource] }).TagDescriptions[0]?.Tags)
  )
    throw new Error("Refusing an untagged or foreign load balancer resource.");
}
await mkdir(directory, { recursive: true, mode: 0o700 });
let state;
try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const save = () => writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
if (state && !state.imageTags) {
  state.imageTags = state.revisions.map(({ revision }) => revision);
  await save();
}
const tags = () => [
  { key: "patchy:spike", value: "tier2" },
  { key: "patchy:run", value: state.fleetId }
];
const tasks = () => aws("ecs", "list-tasks", { cluster }).taskArns;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const liveRunTasks = () => {
  const arns = [
    ...new Set(
      ["RUNNING", "STOPPED"].flatMap(
        (desiredStatus) => aws("ecs", "list-tasks", { cluster, desiredStatus }).taskArns ?? []
      )
    )
  ];
  const live = [];
  for (let offset = 0; offset < arns.length; offset += 100) {
    const reply = aws("ecs", "describe-tasks", {
      cluster,
      tasks: arns.slice(offset, offset + 100),
      include: ["TAGS"]
    });
    if (reply.failures?.length) throw new Error("Cannot verify the spike task inventory.");
    live.push(
      ...(reply.tasks ?? []).filter(
        (task) =>
          task.lastStatus !== "STOPPED" &&
          task.tags?.some(
            (tag) =>
              (tag.key === "patchy:run" || tag.key === "patchy:execution-fleet") &&
              tag.value === state.fleetId
          )
      )
    );
  }
  return live;
};
const oldExecutionTasks = (revision) =>
  liveRunTasks().filter(
    (task) =>
      task.tags?.some(
        (tag) => tag.key === "patchy:execution-fleet" && tag.value === state.fleetId
      ) &&
      !task.tags?.some((tag) => tag.key === "patchy:deployment-revision" && tag.value === revision)
  );
const requireOldHostsStopped = (revision) => {
  const old = state.hosts.filter((host) => host.revision !== revision);
  for (let offset = 0; offset < old.length; offset += 100) {
    const reply = aws("ecs", "describe-tasks", {
      cluster,
      tasks: old.slice(offset, offset + 100).map((host) => host.arn)
    });
    if (
      reply.failures?.some((failure) => failure.reason !== "MISSING") ||
      reply.tasks?.some((task) => task.lastStatus !== "STOPPED")
    )
      throw new Error("Old hosts are not stopped. Complete promote and drain before sealing.");
  }
  if (
    liveRunTasks().some((task) =>
      state.revisions.some(
        (entry) => entry.revision !== revision && entry.hostDefinition === task.taskDefinitionArn
      )
    )
  )
    throw new Error(
      "An old host or control task is still running. Complete its drain before sealing."
    );
};
async function waitTask(arn) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const task = aws("ecs", "describe-tasks", { cluster, tasks: [arn] }).tasks[0];
    if (task?.lastStatus === "STOPPED") throw new Error(`Task stopped: ${task.stoppedReason}`);
    const address = task?.attachments
      ?.flatMap((attachment) => attachment.details ?? [])
      .find((detail) => detail.name === "privateIPv4Address")?.value;
    if (task?.lastStatus === "RUNNING" && address) return { arn, address };
    await sleep(2000);
  }
  throw new Error("Fargate startup exceeded four minutes.");
}
const connection = async (url) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
};
if (command === "status") {
  console.log(
    JSON.stringify(
      {
        account,
        region,
        project,
        tasks: tasks(),
        state: state
          ? {
              database: state.database,
              imageTags: state.imageTags,
              hosts: state.hosts,
              tornDown: state.tornDown ?? false,
              revisions: state.revisions.map(
                ({ revision, kind, promotedAt, drainedAt, sealedAt }) => ({
                  revision,
                  kind,
                  promotedAt,
                  drainedAt,
                  sealedAt
                })
              )
            }
          : null
      },
      null,
      2
    )
  );
} else if (command === "promote" || command === "drain") {
  if (!state || state.tornDown) throw new Error("No active checkout-owned spike.");
  const latest = state.revisions.at(-1);
  if (!latest)
    throw new Error("No deployed revision. Use down to clean up the incomplete deployment.");
  if (command === "drain") {
    if (!latest.promotedAt)
      throw new Error("Promote the latest revision before draining old hosts.");
    const old = state.hosts.filter((host) => host.revision !== latest.revision);
    for (const host of old)
      aws("elbv2", "deregister-targets", {
        TargetGroupArn: awsEnv.SPIKE_TARGET_GROUP_ARN,
        Targets: [{ Id: host.address, Port: 8080 }]
      });
    // The ALB closes streams normally at EOF. Keep the host alive for the whole drain.
    await sleep(90_000);
    const oldTasks = liveRunTasks().filter((task) =>
      state.revisions.some(
        (entry) =>
          entry.revision !== latest.revision && entry.hostDefinition === task.taskDefinitionArn
      )
    );
    for (const task of oldTasks)
      aws("ecs", "stop-task", {
        cluster,
        task: task.taskArn,
        reason: "Issue 406 completed 90 second deployment drain"
      });
    if (oldTasks.length)
      run(
        "aws",
        [
          "ecs",
          "wait",
          "tasks-stopped",
          "--cluster",
          cluster,
          "--tasks",
          ...oldTasks.map((task) => task.taskArn),
          "--region",
          region
        ],
        { env: awsEnv }
      );
    requireOldHostsStopped(latest.revision);
    const deadline = Date.now() + 180_000;
    while (oldExecutionTasks(latest.revision).length) {
      if (Date.now() >= deadline)
        throw new Error(
          "Old execution tasks have not stopped; drain is incomplete. Inspect fleet logs, then rerun drain."
        );
      await sleep(2000);
    }
    latest.drainedAt = new Date().toISOString();
    if (latest.kind === "seal") latest.sealedAt = latest.drainedAt;
    await save();
    console.log(
      `Drained ${old.length} old hosts for 90 seconds; all old execution tasks stopped.${latest.sealedAt ? " Previous management secret retired." : ""}`
    );
  } else {
    const code = `
      import * as Effect from "effect/Effect";
      import * as Fetch from "effect/unstable/http/FetchHttpClient";
      import * as Fleet from "@patchy/execution/fleet";
      import * as Provider from "@patchy/execution/ecs-task-provider";
      import * as TaskProvider from "@patchy/execution/task-provider";
      import * as Sql from "@patchy/sql";
      import { OperatingLimits } from "@patchy/limits";
      import * as Wide from "@patchy/analytics/wide-events";
      await Effect.runPromise(Effect.gen(function* () {
        const provider = yield* Provider.make({ ...(yield* Provider.config),
          callbackUrls: ${JSON.stringify(state.hosts.map((host) => `http://${host.address}:8789/callback`))} });
        const fleet = yield* Fleet.make({ replicaId: "spike-deploy", deploymentRevision: ${JSON.stringify(latest.revision)}, automaticHousekeeping: false })
          .pipe(Effect.provideService(TaskProvider.TaskProvider, provider));
        yield* fleet.stageDeployment(${JSON.stringify(latest.revision)});
        while (!(yield* fleet.promoteDeployment(${JSON.stringify(latest.revision)}))) yield* Effect.sleep(1000);
        console.log("Fleet deployment promoted.");
      }).pipe(Effect.timeout("180 seconds"), Effect.scoped,
        Effect.provide(OperatingLimits.layer), Effect.provide(Sql.layer),
        Effect.provide(Wide.layerDev({json:true})), Effect.provide(Fetch.layer)));
    `;
    const reply = aws("ecs", "run-task", {
      cluster,
      taskDefinition: latest.hostDefinition,
      launchType: "FARGATE",
      count: 1,
      tags: tags(),
      overrides: {
        containerOverrides: [{ name: "host", command: ["node", "--input-type=module", "-e", code] }]
      },
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: publicSubnets,
          securityGroups: [awsEnv.SPIKE_SG_HOST],
          assignPublicIp: "ENABLED"
        }
      }
    });
    if (reply.failures?.length || reply.tasks?.length !== 1)
      throw new Error("Fleet control task failed to launch.");
    const arn = reply.tasks[0].taskArn;
    run(
      "aws",
      ["ecs", "wait", "tasks-stopped", "--cluster", cluster, "--tasks", arn, "--region", region],
      { env: awsEnv }
    );
    const task = aws("ecs", "describe-tasks", { cluster, tasks: [arn] }).tasks[0];
    if (task.containers[0].exitCode !== 0)
      throw new Error("Fleet promotion failed; inspect the control task's CloudWatch log.");
    latest.promotedAt = new Date().toISOString();
    await save();
    console.log(`Promoted ${latest.revision}. Old hosts remain until the explicit drain.`);
  }
} else if (command === "down") {
  if (!state) throw new Error("No checkout-owned spike state; refusing teardown.");
  for (const host of state.hosts)
    aws("elbv2", "deregister-targets", {
      TargetGroupArn: awsEnv.SPIKE_TARGET_GROUP_ARN,
      Targets: [{ Id: host.address, Port: 8080 }]
    });
  const stopOwned = (controllersOnly) => {
    const ownedTasks = liveRunTasks().filter(
      (task) =>
        !controllersOnly ||
        state.revisions.some((revision) => revision.hostDefinition === task.taskDefinitionArn)
    );
    for (const task of ownedTasks)
      aws("ecs", "stop-task", { cluster, task: task.taskArn, reason: "Issue 406 spike teardown" });
    if (ownedTasks.length)
      run(
        "aws",
        [
          "ecs",
          "wait",
          "tasks-stopped",
          "--cluster",
          cluster,
          "--tasks",
          ...ownedTasks.map((task) => task.taskArn),
          "--region",
          region
        ],
        { env: awsEnv }
      );
  };
  // Stop replenishing controllers before taking the final execution-task inventory.
  stopOwned(true);
  stopOwned(false);
  const remainingRules = new Set(
    aws("ec2", "describe-security-group-rules", {
      Filters: [{ Name: "group-id", Values: groups }]
    }).SecurityGroupRules.map((rule) => rule.SecurityGroupRuleId)
  );
  for (const rule of state.rules)
    if (remainingRules.has(rule.id))
      aws(
        "ec2",
        rule.direction === "ingress"
          ? "revoke-security-group-ingress"
          : "revoke-security-group-egress",
        { GroupId: rule.group, SecurityGroupRuleIds: [rule.id] }
      );
  aws("elbv2", "modify-target-group-attributes", {
    TargetGroupArn: awsEnv.SPIKE_TARGET_GROUP_ARN,
    Attributes: state.targetAttributes.filter(({ Key }) =>
      targetAttributes.some((attribute) => attribute.Key === Key)
    )
  });
  aws("elbv2", "modify-load-balancer-attributes", {
    LoadBalancerArn: awsEnv.SPIKE_ALB_ARN,
    Attributes: state.albAttributes.filter(({ Key }) =>
      albAttributes.some((attribute) => attribute.Key === Key)
    )
  });
  const db = await connection(neon.DATABASE_URL);
  try {
    if (!/^patchy_406_[0-9]+$/.test(state.database))
      throw new Error("Refusing foreign database teardown.");
    if ((await db.query("SELECT 1 FROM pg_database WHERE datname=$1", [state.database])).rowCount) {
      const url = new URL(neon.DATABASE_URL);
      url.pathname = `/${state.database}`;
      const platform = await connection(url.href);
      try {
        if ((await platform.query("SELECT to_regclass('patch_versions') AS found")).rows[0].found) {
          const versions = await platform.query(
            "SELECT object_key, server_object_key FROM patch_versions"
          );
          for (const row of versions.rows)
            for (const key of [row.object_key, row.server_object_key]) {
              if (key)
                run(
                  "aws",
                  [
                    "s3api",
                    "delete-object",
                    "--bucket",
                    neon.NEON_BUCKET,
                    "--key",
                    key,
                    "--endpoint-url",
                    neon.AWS_ENDPOINT_URL_S3,
                    "--region",
                    neon.AWS_REGION
                  ],
                  { env: neon }
                );
            }
        }
        if (
          (await platform.query("SELECT to_regclass('company_databases') AS found")).rows[0].found
        ) {
          const placements = await platform.query("SELECT database_name FROM company_databases");
          for (const { database_name: name } of placements.rows) {
            if (!/^patchy_company_[a-z0-9]+$/.test(name))
              throw new Error("Refusing an unexpected company database name.");
            await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          }
        }
      } finally {
        await platform.end();
      }
    }
    await db.query(`DROP DATABASE IF EXISTS "${state.database}" WITH (FORCE)`);
  } finally {
    await db.end();
  }
  for (const definition of state.definitions)
    aws("ecs", "deregister-task-definition", { taskDefinition: definition });
  for (let i = 0; i < state.definitions.length; i += 10) {
    const deleted = aws("ecs", "delete-task-definitions", {
      taskDefinitions: state.definitions.slice(i, i + 10)
    });
    if (deleted.failures?.length)
      throw new Error(`Task definition cleanup refused: ${JSON.stringify(deleted.failures)}`);
  }
  for (const imageTag of state.imageTags) {
    const deleted = aws("ecr", "batch-delete-image", { repositoryName, imageIds: [{ imageTag }] });
    if (deleted.failures?.some((failure) => failure.failureCode !== "ImageNotFound"))
      throw new Error("Image cleanup refused; keep the run state and rerun down.");
  }
  state.tornDown = true;
  await save();
  console.log(
    "Spike tasks stopped, run database removed, ALB and security-group settings restored. Base stack retained."
  );
} else {
  if (!image) throw new Error("Provide the daemonless image archive.");
  if (command === "up") {
    if (state && !state.tornDown) throw new Error("An active spike run exists in this checkout.");
    if (tasks().length || aws("ecs", "list-services", { cluster }).serviceArns.length)
      throw new Error("Expected the idle spike stack; refusing to displace existing work.");
    state = {
      fleetId: `spike406-${Date.now()}`,
      database: `patchy_406_${Date.now()}`,
      hosts: [],
      definitions: [],
      revisions: [],
      imageTags: [],
      rules: [],
      targetAttributes: aws("elbv2", "describe-target-group-attributes", {
        TargetGroupArn: awsEnv.SPIKE_TARGET_GROUP_ARN
      }).Attributes,
      albAttributes: aws("elbv2", "describe-load-balancer-attributes", {
        LoadBalancerArn: awsEnv.SPIKE_ALB_ARN
      }).Attributes,
      credentialKey: randomBytes(32).toString("base64")
    };
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    state.jwtKey = keys.publicKey.export({ type: "spki", format: "pem" });
    state.jwtPrivateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
    await save();
    const db = await connection(neon.DATABASE_URL);
    try {
      await db.query(`CREATE DATABASE "${state.database}" TEMPLATE template0`);
    } finally {
      await db.end();
    }
    for (const [group, direction, port, peer] of [
      [awsEnv.SPIKE_SG_EXEC_BOOTSTRAP, "ingress", 8788, awsEnv.SPIKE_SG_HOST],
      [awsEnv.SPIKE_SG_EXEC_SEALED, "ingress", 8788, awsEnv.SPIKE_SG_HOST],
      [awsEnv.SPIKE_SG_EXEC_BOOTSTRAP, "egress", 8789, awsEnv.SPIKE_SG_HOST],
      [awsEnv.SPIKE_SG_HOST, "ingress", 8789, awsEnv.SPIKE_SG_EXEC_BOOTSTRAP]
    ]) {
      const reply = aws("ec2", `authorize-security-group-${direction}`, {
        GroupId: group,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: port,
            ToPort: port,
            UserIdGroupPairs: [{ GroupId: peer, Description: "issue 406 private execution" }]
          }
        ]
      });
      for (const rule of reply.SecurityGroupRules ?? [])
        state.rules.push({ group, direction, id: rule.SecurityGroupRuleId });
      await save();
    }
    aws("elbv2", "modify-target-group-attributes", {
      TargetGroupArn: awsEnv.SPIKE_TARGET_GROUP_ARN,
      Attributes: targetAttributes
    });
    aws("elbv2", "modify-load-balancer-attributes", {
      LoadBalancerArn: awsEnv.SPIKE_ALB_ARN,
      Attributes: albAttributes
    });
  } else if (!state || state.tornDown)
    throw new Error("Rollout or seal needs an active checkout-owned spike.");
  const revision = `spike406-${Date.now()}`;
  const latest = state.revisions.at(-1);
  if (command === "seal") {
    if (!latest?.drainedAt || !latest.secret)
      throw new Error("Seal requires a deployed revision with promote and drain completed.");
    requireOldHostsStopped(latest.revision);
    if (oldExecutionTasks(latest.revision).length)
      throw new Error(
        "Old execution tasks are still running. Complete the previous rollout drain before sealing."
      );
  }
  const previous = command === "seal" ? undefined : latest;
  const deploymentSecret = command === "seal" ? latest.secret : randomBytes(32).toString("hex");
  state.imageTags.push(revision);
  await save();
  const dockerConfig = path.join(directory, "registry");
  await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
  const registryEnv = { ...process.env, DOCKER_CONFIG: dockerConfig };
  const password = run("aws", ["ecr", "get-login-password", "--region", region], { env: awsEnv });
  try {
    run(
      "crane",
      ["auth", "login", awsEnv.SPIKE_ECR_URI.split("/")[0], "-u", "AWS", "--password-stdin"],
      { env: registryEnv, input: password }
    );
    run("crane", ["push", path.resolve(image), `${awsEnv.SPIKE_ECR_URI}:${revision}`], {
      env: registryEnv
    });
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
  const digest = aws("ecr", "describe-images", {
    repositoryName,
    imageIds: [{ imageTag: revision }]
  }).imageDetails[0].imageDigest;
  const imageRef = `${awsEnv.SPIKE_ECR_URI}@${digest}`;
  const definition = (family, container, role) =>
    aws("ecs", "register-task-definition", {
      family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "512",
      memory: "2048",
      executionRoleArn: awsEnv.SPIKE_TASK_EXECUTION_ROLE_ARN,
      ...(role ? { taskRoleArn: role } : {}),
      runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
      tags: tags(),
      containerDefinitions: [
        {
          ...container,
          essential: true,
          image: imageRef,
          stopTimeout: 120,
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": awsEnv.SPIKE_LOG_GROUP,
              "awslogs-region": region,
              "awslogs-stream-prefix": revision
            }
          }
        }
      ]
    }).taskDefinition.taskDefinitionArn;
  // Root is supervisor-only. Children drop uid/gid and receive an empty environment.
  const execDefinition = definition("patchy-tier2-spike-406-exec", {
    name: "exec",
    user: "0",
    command: ["node", "dist/exec.js"],
    linuxParameters: {
      capabilities: {
        drop: [
          "NET_RAW",
          "NET_BIND_SERVICE",
          "SYS_CHROOT",
          "MKNOD",
          "SETFCAP",
          "SETPCAP",
          "AUDIT_WRITE",
          "FSETID"
        ]
      }
    },
    portMappings: [{ containerPort: 8788, protocol: "tcp" }]
  });
  state.definitions.push(execDefinition);
  await save();
  const dbUrl = new URL(neon.DATABASE_URL);
  dbUrl.pathname = `/${state.database}`;
  // The native driver has no channel_binding URL option. This disposable deploy
  // uses certificate and hostname verification instead.
  dbUrl.searchParams.delete("channel_binding");
  dbUrl.searchParams.set("sslmode", "verify-full");
  const companyUrl = new URL(dbUrl);
  companyUrl.pathname = new URL(neon.DATABASE_URL).pathname;
  const hostEnv = {
    NODE_ENV: "production",
    PORT: "8080",
    DATABASE_URL: dbUrl.href,
    PATCHY_COMPANY_DB_ADMIN_URL: companyUrl.href,
    PATCHY_COMPANY_DB_URL: companyUrl.href,
    PATCHY_CREDENTIAL_KEYS: `spike:${state.credentialKey}`,
    PATCHY_PUBLIC_BASE_URL: `https://${awsEnv.SPIKE_ALB_DNS}`,
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.patchy.invalid$").toString("base64").replace(/=+$/, "")}`,
    CLERK_SECRET_KEY: "sk_test_spike",
    CLERK_JWT_KEY: state.jwtKey,
    EXECUTION_PROVIDER: "ecs",
    ECS_REGION: region,
    ECS_CLUSTER: cluster,
    EXECUTION_FLEET_ID: state.fleetId,
    ECS_EXEC_SUBNET_IDS: JSON.stringify([awsEnv.SPIKE_PRIVATE_SUBNET]),
    ECS_EXEC_BOOTSTRAP_SECURITY_GROUP_ID: awsEnv.SPIKE_SG_EXEC_BOOTSTRAP,
    ECS_EXEC_TASK_DEFINITION: execDefinition,
    EXECUTION_DEPLOYMENT_REVISION: revision,
    PATCHY_DEPLOYMENT_REVISION: revision,
    EXECUTION_MANAGEMENT_SECRET: deploymentSecret,
    EXECUTION_CALLBACK_URLS: "[]",
    EXECUTION_CALLBACK_PORT: "8789",
    EXECUTION_CALLBACK_HOST: "auto",
    EXECUTION_CALLBACK_PRIVATE_INTERFACE: "true",
    PATCHY_S3_BUCKET: neon.NEON_BUCKET,
    PATCHY_S3_ENDPOINT: neon.AWS_ENDPOINT_URL_S3,
    PATCHY_S3_REGION: neon.AWS_REGION,
    PATCHY_S3_ACCESS_KEY_ID: neon.AWS_ACCESS_KEY_ID,
    PATCHY_S3_SECRET_ACCESS_KEY: neon.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: awsEnv.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: awsEnv.AWS_SECRET_ACCESS_KEY,
    PATCHY_LIMITS_JSON: JSON.stringify({
      "execution.fleet.budget": 8,
      "execution.housekeeping.interval": 1000,
      "execution.company.idle": 10000
    }),
    ...(previous
      ? {
          ECS_EXEC_PREVIOUS_TASK_DEFINITION: previous.execDefinition,
          EXECUTION_PREVIOUS_DEPLOYMENT_REVISION: previous.revision,
          EXECUTION_MANAGEMENT_PREVIOUS_SECRET: previous.secret
        }
      : {})
  };
  const hostDefinition = definition(
    "patchy-tier2-spike-406-host",
    {
      name: "host",
      user: "1000",
      command: ["node", "dist/start.js"],
      environment: Object.entries(hostEnv).map(([name, value]) => ({ name, value })),
      portMappings: [
        { containerPort: 8080, protocol: "tcp" },
        { containerPort: 8789, protocol: "tcp" }
      ]
    },
    awsEnv.SPIKE_HOST_TASK_ROLE_ARN
  );
  state.definitions.push(hostDefinition);
  state.revisions.push({
    revision,
    kind: command === "up" ? "initial" : command,
    secret: deploymentSecret,
    execDefinition,
    hostDefinition,
    imageRef
  });
  await save();
  const reply = aws("ecs", "run-task", {
    cluster,
    taskDefinition: hostDefinition,
    launchType: "FARGATE",
    count: 2,
    tags: tags(),
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: publicSubnets,
        securityGroups: [awsEnv.SPIKE_SG_HOST],
        assignPublicIp: "ENABLED"
      }
    }
  });
  if (reply.failures?.length)
    throw new Error(`Host launch refused: ${JSON.stringify(reply.failures)}`);
  for (const task of reply.tasks) {
    const host = { ...(await waitTask(task.taskArn)), revision };
    state.hosts.push(host);
    await save();
    aws("elbv2", "register-targets", {
      TargetGroupArn: awsEnv.SPIKE_TARGET_GROUP_ARN,
      Targets: [{ Id: host.address, Port: 8080 }]
    });
  }
  run(
    "aws",
    [
      "elbv2",
      "wait",
      "target-in-service",
      "--target-group-arn",
      awsEnv.SPIKE_TARGET_GROUP_ARN,
      "--targets",
      ...state.hosts
        .filter((host) => host.revision === revision)
        .map((host) => `Id=${host.address},Port=8080`),
      "--region",
      region
    ],
    { env: awsEnv }
  );
  console.log(
    JSON.stringify(
      {
        revision,
        origin: hostEnv.PATCHY_PUBLIC_BASE_URL,
        hosts: state.hosts,
        database: state.database
      },
      null,
      2
    )
  );
}
