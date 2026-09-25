#!/usr/bin/env bash
# PROTOTYPE for #311: stop everything this lane started. Task definitions stay
# registered; images stay in ECR; the SG rules stay (recorded in RESULTS.md).
set -uo pipefail
: "${SPIKE_ECS_CLUSTER:?source ~/.config/patchy-cloud/aws-spike.env first}"
aws ecs update-service --cluster "$SPIKE_ECS_CLUSTER" --service tier2-spike-host --desired-count 0 >/dev/null 2>&1
aws ecs delete-service --cluster "$SPIKE_ECS_CLUSTER" --service tier2-spike-host --force >/dev/null 2>&1 && echo "service tier2-spike-host deleted"
for arn in $(aws ecs list-tasks --cluster "$SPIKE_ECS_CLUSTER" --query 'taskArns[]' --output text); do
  fam=$(aws ecs describe-tasks --cluster "$SPIKE_ECS_CLUSTER" --tasks "$arn" --query 'tasks[0].group' --output text)
  case "$fam" in *tier2-spike-exec*|*tier2-spike-host*) aws ecs stop-task --cluster "$SPIKE_ECS_CLUSTER" --task "$arn" --reason "destroy.sh" >/dev/null && echo "stopped $fam $arn";; esac
done
sleep 5
echo "remaining tasks:"; aws ecs list-tasks --cluster "$SPIKE_ECS_CLUSTER" --output text
echo "remaining services:"; aws ecs list-services --cluster "$SPIKE_ECS_CLUSTER" --output text
