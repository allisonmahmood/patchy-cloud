#!/usr/bin/env bash
# PROTOTYPE for #563: a fresh agent working on an existing tool after a new look revision.
# Copies a finished run, applies <look> through refresh (as dev start or refresh would pick up
# a new revision), then hands the copy to a fresh agent.
# Usage: PATCHY_DEV_ENV=<environment folder> revise.sh <new run> <from run> <look> <TASK file>
set -uo pipefail
run=$1; from=$2; look=$3; task=$4
E=${PATCHY_DEV_ENV:?Set PATCHY_DEV_ENV to the environment folder pnpm dev up printed}
W=$(cd "$(dirname "$0")/.." && pwd)
L=/tmp/look-563/logs; mkdir -p $L
export PATH=$E/bin:$PATH PATCHY_STATE_DIR=$E/cli-state PATCHY_PROTOTYPE_LOOK=$W/looks/$look
dir=/tmp/look-563/ws/$run
rm -rf "$dir" && cp -a /tmp/look-563/ws/$from "$dir" && rm -f "$dir/REPORT.md"
cd "$dir"
pnpm --silent patchy refresh --json > $L/$run.refresh.json 2>&1 || { echo "refresh failed" >> $L/$run.err; exit 1; }
date -Is > $L/$run.start
timeout 3600 claude -p "$(cat $W/runs/$task)" --model claude-opus-5-5 --output-format stream-json --verbose \
  --setting-sources project --strict-mcp-config --permission-mode acceptEdits --add-dir /tmp \
  --allowedTools 'Bash(patchy:*)' 'Bash(pnpm:*)' 'Bash(node:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(grep:*)' 'Bash(find:*)' 'Bash(mkdir:*)' 'Bash(jq:*)' 'Bash(sed -n:*)' 'Bash(wc:*)' 'Bash(playwright:*)' \
  < /dev/null > $L/$run.ndjson 2> $L/$run.err
echo "exit $?" >> $L/$run.err
date -Is > $L/$run.end
