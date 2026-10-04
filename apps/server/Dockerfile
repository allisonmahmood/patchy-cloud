FROM node:24-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS builder

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /repo

RUN corepack enable

# Workspace prepare scripts and dependency patches are needed during install.
COPY . .
RUN pnpm install --frozen-lockfile

ARG SOURCE_DATE_EPOCH=0
ARG REVISION=unknown
ARG VERSION=0.0.0

RUN SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" REVISION="$REVISION" VERSION="$VERSION" \
  node scripts/build-server-image.mjs --stage /image-rootfs

FROM node:24-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS runner

ARG VERSION=0.0.0
ARG REVISION=unknown
ARG SOURCE_DATE_EPOCH=0

LABEL org.opencontainers.image.source="https://github.com/allisonmahmood/patchy-cloud" \
  org.opencontainers.image.licenses="UNLICENSED" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.revision="$REVISION" \
  io.patchy.source-date-epoch="$SOURCE_DATE_EPOCH"

ENV NODE_ENV=production
ENV PORT=3000
ENV PATCHY_STORAGE_DIR=/data/patches

WORKDIR /app

COPY --from=builder /image-rootfs/app/ ./
COPY --from=builder --chown=node:node /image-rootfs/data/ /data/

VOLUME ["/data"]

USER node

EXPOSE 3000

# Exec tasks override the command with ["node", "dist/exec.js"]; one-off fleet
# operations, such as a deploy's promote, with ["node", "dist/fleet.js", ...].
CMD ["node", "dist/start.js"]
