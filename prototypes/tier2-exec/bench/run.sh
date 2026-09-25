#!/usr/bin/env bash
# PROTOTYPE for #311: run every measurement against the deployed host through
# the ALB. Needs the AWS env sourced (for SPIKE_ALB_DNS). Raw output lands in
# bench/out/ (gitignored); the tables go into RESULTS.md by hand.
set -uo pipefail
cd "$(dirname "$0")"
: "${SPIKE_ALB_DNS:?source ~/.config/patchy-cloud/aws-spike.env first}"
mkdir -p out
run() { echo "===== $1"; node "$1" 2>&1 | grep -v 'NODE_TLS_REJECT\|trace-warnings'; }
run 01-coldstart.mjs
run 02-bind.mjs
run 03-simultaneous.mjs
run 04-warm.mjs
run 05-createMany.mjs
run 06-rollback.mjs
run 07-contention.mjs
run 07b-contention.mjs
run 08-memory.mjs
run 09-neighbour.mjs
run 11-capability.mjs
run 12b-h2-streams.mjs
# 10 includes the sealed-SG launch, which takes ECS about five minutes to fail;
# the host keeps polling after the client gives up, so read the task from ECS.
run 10-containment.mjs
echo "===== 12a: 5-minute SSE hold over HTTP/2"
curl -sk --http2 -N --max-time 330 "https://$SPIKE_ALB_DNS/stream?doc=hold5m" | grep -c 'event: tick'
echo "===== 12c: deployment drain: open a stream, then run infra/deploy.sh in another shell"
echo "===== 13: log ingestion lag over the last 200 events"
aws logs filter-log-events --log-group-name "${SPIKE_LOG_GROUP:-/patchy/tier2-spike}" --limit 200 --query 'events[].[timestamp,ingestionTime]' --output json | jq -c 'map(.[1]-.[0]) | sort | {n: length, p50: .[length/2|floor], p95: .[length*0.95|floor], max: .[-1]}'
