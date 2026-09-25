#!/usr/bin/env bash
# PROTOTYPE for #311: register the exec and host task definitions and run the
# host as one ECS service behind the ALB. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SPIKE_ECS_CLUSTER:?source ~/.config/patchy-cloud/aws-spike.env first}"
: "${DATABASE_URL:?export DATABASE_URL from ~/.config/patchy-cloud/neon-spike.env (grep it; do not source the whole file)}"
. infra/.tags
POOL_SIZE=${POOL_SIZE:-2}
IDLE_MS=${IDLE_MS:-60000}

logs() { printf '{"logDriver":"awslogs","options":{"awslogs-group":"%s","awslogs-region":"us-east-1","awslogs-stream-prefix":"%s"}}' "$SPIKE_LOG_GROUP" "$1"; }

# Exec task: no task role at all, bootstrap SG, private subnet (chosen at RunTask).
EXEC_TD=$(aws ecs register-task-definition --family tier2-spike-exec --network-mode awsvpc --requires-compatibilities FARGATE \
  --cpu 512 --memory 1024 --execution-role-arn "$SPIKE_TASK_EXECUTION_ROLE_ARN" \
  --container-definitions "[{\"name\":\"exec\",\"image\":\"$SPIKE_ECR_URI:$EXEC_TAG\",\"essential\":true,\"portMappings\":[{\"containerPort\":8080}],\"environment\":[{\"name\":\"RSS_LIMIT_MB\",\"value\":\"512\"}],\"logConfiguration\":$(logs exec)}]" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "exec task def: $EXEC_TD"

# Host task: public subnet + public IP (reaches Neon without NAT), behind the ALB.
# The disposable user's keys ride in task env so the host can RunTask: spike shortcut.
env_json() { printf '{"name":"%s","value":"%s"}' "$1" "$2"; }
HOST_ENV="[$(env_json DATABASE_URL "$DATABASE_URL"),$(env_json AWS_ACCESS_KEY_ID "$AWS_ACCESS_KEY_ID"),$(env_json AWS_SECRET_ACCESS_KEY "$AWS_SECRET_ACCESS_KEY"),$(env_json AWS_REGION us-east-1),$(env_json SPIKE_ECS_CLUSTER "$SPIKE_ECS_CLUSTER"),$(env_json SPIKE_PRIVATE_SUBNET "$SPIKE_PRIVATE_SUBNET"),$(env_json SPIKE_SG_EXEC_BOOTSTRAP "$SPIKE_SG_EXEC_BOOTSTRAP"),$(env_json SPIKE_SG_EXEC_SEALED "$SPIKE_SG_EXEC_SEALED"),$(env_json EXEC_TASK_DEF "$EXEC_TD"),$(env_json POOL_SIZE "$POOL_SIZE"),$(env_json IDLE_MS "$IDLE_MS")]"
HOST_TD=$(aws ecs register-task-definition --family tier2-spike-host --network-mode awsvpc --requires-compatibilities FARGATE \
  --cpu 512 --memory 1024 --execution-role-arn "$SPIKE_TASK_EXECUTION_ROLE_ARN" --task-role-arn "$SPIKE_HOST_TASK_ROLE_ARN" \
  --container-definitions "[{\"name\":\"host\",\"image\":\"$SPIKE_ECR_URI:$HOST_TAG\",\"essential\":true,\"portMappings\":[{\"containerPort\":8080}],\"stopTimeout\":30,\"environment\":$HOST_ENV,\"logConfiguration\":$(logs host)}]" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "host task def: $HOST_TD"

SUBNETS=$(echo "$SPIKE_PUBLIC_SUBNETS" | tr ',' ' ')
NET="awsvpcConfiguration={subnets=[$(echo "$SPIKE_PUBLIC_SUBNETS" | sed 's/,/,/g')],securityGroups=[$SPIKE_SG_HOST],assignPublicIp=ENABLED}"
STATUS=$(aws ecs describe-services --cluster "$SPIKE_ECS_CLUSTER" --services tier2-spike-host --query 'services[0].status' --output text 2>/dev/null || echo NONE)
if [ "$STATUS" = "ACTIVE" ]; then
  aws ecs update-service --cluster "$SPIKE_ECS_CLUSTER" --service tier2-spike-host --task-definition "$HOST_TD" --desired-count 1 --query 'service.deployments[0].id' --output text
else
  aws ecs create-service --cluster "$SPIKE_ECS_CLUSTER" --service-name tier2-spike-host --task-definition "$HOST_TD" --desired-count 1 --launch-type FARGATE \
    --network-configuration "$NET" --load-balancers "targetGroupArn=$SPIKE_TARGET_GROUP_ARN,containerName=host,containerPort=8080" \
    --health-check-grace-period-seconds 60 --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200" \
    --query 'service.serviceArn' --output text
fi
echo "waiting for the service to stabilise..."
aws ecs wait services-stable --cluster "$SPIKE_ECS_CLUSTER" --services tier2-spike-host
echo "host: https://$SPIKE_ALB_DNS (self-signed; curl -k)"
curl -sk "https://$SPIKE_ALB_DNS/healthz"; echo
