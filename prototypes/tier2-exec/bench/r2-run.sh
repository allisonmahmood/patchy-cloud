#!/usr/bin/env bash
# PROTOTYPE for #311 round 2: run the round-2 measurements against the deployed
# host. Item 6 (Neon autosuspend) runs separately and alone.
set -uo pipefail
cd "$(dirname "$0")"
: "${SPIKE_ALB_DNS:?source ~/.config/patchy-cloud/aws-spike.env first}"
run() { echo "===== $1"; node "$1" 2>&1 | grep -v 'NODE_TLS_REJECT\|trace-warnings'; }
run r2-02-deadline.mjs
run r2-03-keys.mjs
run r2-05-authz.mjs
./r2-01.sh
run r2-04-ownership.mjs   # forces a new deployment of the host service
