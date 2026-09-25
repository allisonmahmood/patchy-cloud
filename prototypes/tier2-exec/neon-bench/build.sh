#!/usr/bin/env bash
# PROTOTYPE for #311: build the neon-bench image with crane (no docker daemon) and push it to the spike's ECR repo.
# Prints the image reference; run-on-fargate.sh reads it from .image-ref.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . "$HOME/.config/patchy-cloud/aws-spike.env"; set +a
export PATH="$HOME/go/bin:$PATH"
tag="neon-bench-$(git rev-parse --short HEAD 2>/dev/null || date +%s)-$(date +%H%M%S)"
ref="$SPIKE_ECR_URI:$tag"
registry="${SPIKE_ECR_URI%%/*}"
aws ecr get-login-password --region us-east-1 | crane auth login "$registry" -u AWS --password-stdin
npm install --omit=dev --no-audit --no-fund >/dev/null
rm -rf .build && mkdir -p .build/app
cp bench.ts package.json .build/app/
cp -r node_modules .build/app/
tar -C .build -cf .build/app.tar app
crane append --platform linux/amd64 -b public.ecr.aws/docker/library/node:24-slim -f .build/app.tar -t "$ref"
crane mutate --entrypoint node --cmd bench.ts --workdir /app "$ref" -t "$ref"
crane config "$ref" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("entrypoint", c.config.Entrypoint, "cmd", c.config.Cmd, "workdir", c.config.WorkingDir, "arch", c.architecture)'
echo "$ref" > .image-ref
echo "built $ref"
