#!/usr/bin/env bash
# PROTOTYPE for #311: run the Neon bench from this machine (numbers labelled "local").
# The neon env file's DATABASE_URL has an unquoted '&', so it is read with grep, not sourced.
set -euo pipefail
f=${NEON_ENV_FILE:-$HOME/.config/patchy-cloud/neon-spike.env}
for k in DATABASE_URL NEON_API_KEY NEON_PROJECT_ID NEON_ENDPOINT_ID; do
  export "$k=$(grep "^$k=" "$f" | cut -d= -f2-)"
done
export BENCH_LABEL=${BENCH_LABEL:-local}
cd "$(dirname "$0")"
exec node --experimental-strip-types bench.ts "$@"
