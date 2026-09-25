#!/usr/bin/env bash
# PROTOTYPE for #311 round 2: run item 1 in both process modes. Switching mode
# releases the company and drains the pool so fresh tasks start in the new mode.
set -uo pipefail
cd "$(dirname "$0")"
H="https://$SPIKE_ALB_DNS"
for mode in company patch; do
  curl -sk -XPOST "$H/admin/mode?mode=$mode" >/dev/null
  curl -sk -XPOST "$H/admin/release?company=acme" >/dev/null
  curl -sk -XPOST "$H/admin/drain" >/dev/null
  echo "===== mode $mode: waiting for the pool to refill"
  sleep 40
  node r2-01-process-mode.mjs "$mode" 2>&1 | grep -v 'NODE_TLS\|trace-warnings'
done
