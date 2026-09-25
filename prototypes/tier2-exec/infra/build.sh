#!/usr/bin/env bash
# PROTOTYPE for #311: build the exec and host images with crane (no docker),
# push them to ECR tagged exec-<ts> and host-<ts>, and record the tags.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=$HOME/go/bin:$PATH
: "${SPIKE_ECR_URI:?source ~/.config/patchy-cloud/aws-spike.env first}"
TAG=${TAG:-$(date +%Y%m%d%H%M%S)}
BASE=public.ecr.aws/docker/library/node:24-slim
REGISTRY=${SPIKE_ECR_URI%%/*}

aws ecr get-login-password --region us-east-1 | crane auth login "$REGISTRY" -u AWS --password-stdin

node handlers/build.mjs
rm -rf host/bundles && mkdir host/bundles && cp handlers/dist/* host/bundles/
(cd exec && npm install --omit=dev --no-audit --no-fund)
(cd host && npm install --omit=dev --no-audit --no-fund)

build() { # <name> <dir> <cmd>
  local name=$1 dir=$2 cmd=$3
  local ref="$SPIKE_ECR_URI:$name-$TAG"
  tar -C "$dir" --transform 's,^\./,app/,' --exclude=./package-lock.json -cf "infra/$name.tar" .
  crane append --platform linux/amd64 -b "$BASE" -f "infra/$name.tar" -t "$ref"
  crane mutate --entrypoint node --cmd "$cmd" --workdir /app --exposed-ports 8080 "$ref" -t "$ref"
  echo "pushed $ref ($(du -h "infra/$name.tar" | cut -f1) layer)"
}
[ "${ONLY:-}" = host ] || build exec exec supervisor.ts
[ "${ONLY:-}" = exec ] || build host host server.ts

[ -f infra/.tags ] && . infra/.tags
[ "${ONLY:-}" = host ] || EXEC_TAG=exec-$TAG
[ "${ONLY:-}" = exec ] || HOST_TAG=host-$TAG
printf 'EXEC_TAG=%s\nHOST_TAG=%s\n' "$EXEC_TAG" "$HOST_TAG" > infra/.tags
[ -n "${EXEC_SECRET:-}" ] && printf 'EXEC_SECRET=%s\n' "$EXEC_SECRET" >> infra/.tags
cat infra/.tags
