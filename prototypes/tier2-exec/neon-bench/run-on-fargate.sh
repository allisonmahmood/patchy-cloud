#!/usr/bin/env bash
# PROTOTYPE for #311: run the neon-bench image once as a Fargate task in a public subnet and print its log.
# Neon credentials ride in the task definition's environment: a spike shortcut, never the production shape.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . "$HOME/.config/patchy-cloud/aws-spike.env"; set +a
neon="$HOME/.config/patchy-cloud/neon-spike.env"
val() { grep "^$1=" "$neon" | cut -d= -f2-; }
image=$(cat .image-ref)
family=tier2-spike-neon-bench
steps=${BENCH_STEPS:-settings,warm,cold,mutation,contention,conflict,cancel,lostcommit,provision,idle,restart}

env_json=$(node -e '
const [image, steps, url, key, project, endpoint, idle, coldN] = process.argv.slice(1);
const env = (name, value) => ({ name, value });
process.stdout.write(JSON.stringify([{
  name: "bench", image, essential: true,
  environment: [env("BENCH_LABEL", "fargate"), env("BENCH_STEPS", steps), env("DATABASE_URL", url), env("NEON_API_KEY", key),
    env("NEON_PROJECT_ID", project), env("NEON_ENDPOINT_ID", endpoint), env("BENCH_IDLE_MINUTES", idle), env("BENCH_COLD_N", coldN)],
  logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": process.env.SPIKE_LOG_GROUP, "awslogs-region": "us-east-1", "awslogs-stream-prefix": "neon-bench" } },
}]));
' "$image" "$steps" "$(val DATABASE_URL)" "$(val NEON_API_KEY)" "$(val NEON_PROJECT_ID)" "$(val NEON_ENDPOINT_ID)" "${BENCH_IDLE_MINUTES:-8}" "${BENCH_COLD_N:-5}")

td=$(aws ecs register-task-definition --family "$family" --requires-compatibilities FARGATE --network-mode awsvpc \
  --cpu 512 --memory 1024 --execution-role-arn "$SPIKE_TASK_EXECUTION_ROLE_ARN" \
  --runtime-platform cpuArchitecture=X86_64,operatingSystemFamily=LINUX \
  --container-definitions "$env_json" --query 'taskDefinition.taskDefinitionArn' --output text)
echo "task definition $td"

task=$(aws ecs run-task --cluster "$SPIKE_ECS_CLUSTER" --launch-type FARGATE --task-definition "$td" \
  --network-configuration "awsvpcConfiguration={subnets=[${SPIKE_PUBLIC_SUBNETS%%,*}],securityGroups=[$SPIKE_SG_HOST],assignPublicIp=ENABLED}" \
  --started-by neon-bench --query 'tasks[0].taskArn' --output text)
echo "task $task"
task_id=${task##*/}
echo "started $(date -u +%FT%TZ); waiting for the task to stop (the full run takes about 15 minutes)"
aws ecs wait tasks-running --cluster "$SPIKE_ECS_CLUSTER" --tasks "$task"
echo "running $(date -u +%FT%TZ)"
until aws ecs describe-tasks --cluster "$SPIKE_ECS_CLUSTER" --tasks "$task" --query 'tasks[0].lastStatus' --output text | grep -q STOPPED; do sleep 20; done
aws ecs describe-tasks --cluster "$SPIKE_ECS_CLUSTER" --tasks "$task" \
  --query 'tasks[0].{status:lastStatus,reason:stoppedReason,exit:containers[0].exitCode,created:createdAt,started:startedAt,stopped:stoppedAt}' --output json
out=${BENCH_OUT:-/tmp/wf311/bench-fargate-$task_id.md}
aws logs get-log-events --log-group-name "$SPIKE_LOG_GROUP" --log-stream-name "neon-bench/bench/$task_id" --start-from-head \
  --query 'events[].message' --output text | sed 's/\t/\n/g' > "$out" || true
echo "log written to $out"
