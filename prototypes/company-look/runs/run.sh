#!/usr/bin/env bash
# PROTOTYPE for #563: one fresh-agent run.
# Usage: PATCHY_DEV_ENV=<environment folder from `pnpm dev up`> run.sh <run> <look|none> <TASK file> <purpose>
# Repos go under /tmp/look-563/ws: a folder under $HOME would load ~/.claude/CLAUDE.md as an
# ancestor CLAUDE.md, and the agent would no longer be fresh.
set -uo pipefail
run=$1; look=$2; task=$3; purpose=$4
E=${PATCHY_DEV_ENV:?Set PATCHY_DEV_ENV to the environment folder pnpm dev up printed}
W=$(cd "$(dirname "$0")/.." && pwd)
L=/tmp/look-563/logs; mkdir -p $L /tmp/look-563/ws
export PATH=$E/bin:$PATH PATCHY_STATE_DIR=$E/cli-state
if [ "$look" != none ]; then export PATCHY_PROTOTYPE_LOOK=$W/looks/$look; else unset PATCHY_PROTOTYPE_LOOK; fi
dir=/tmp/look-563/ws/$run
patchy init "$dir" --purpose "$purpose" --tier 1 --json > $L/$run.init.json 2>&1 || { echo "init failed" >> $L/$run.err; exit 1; }
cd "$dir"
date -Is > $L/$run.start
timeout 3600 claude -p "$(cat $W/runs/$task)" --model claude-opus-5-5 --output-format stream-json --verbose \
  --setting-sources project --strict-mcp-config --permission-mode acceptEdits --add-dir /tmp \
  --allowedTools 'Bash(patchy:*)' 'Bash(pnpm:*)' 'Bash(node:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(head:*)' 'Bash(tail:*)' 'Bash(grep:*)' 'Bash(find:*)' 'Bash(mkdir:*)' 'Bash(jq:*)' 'Bash(sed -n:*)' 'Bash(wc:*)' 'Bash(playwright:*)' \
  < /dev/null > $L/$run.ndjson 2> $L/$run.err
echo "exit $?" >> $L/$run.err
date -Is > $L/$run.end
