# syntax=docker/dockerfile:1
# The worker runs inside the official KiCad image: kicad-cli plus the
# standard symbol/footprint/3D libraries needed for exports.
ARG KICAD_VERSION=9.0
FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:/root/.cargo/bin:$PATH CI=true
RUN corepack enable \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown \
 && cargo install wasm-pack --locked
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @pcbhub/kicad-core run build:node \
 && pnpm --filter @pcbhub/worker build \
 && pnpm --filter @pcbhub/worker deploy --prod --legacy /out \
 && cp -r apps/worker/dist /out/dist \
 && mkdir -p /out/node_modules/@pcbhub/kicad-core \
 && cp -r packages/kicad-core/package.json packages/kicad-core/pkg-node /out/node_modules/@pcbhub/kicad-core/

FROM kicad/kicad:${KICAD_VERSION}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git tini \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
# kicad user (uid 1000) ships with the base image; never run tools as root.
USER kicad
ENV NODE_ENV=production HOME=/home/kicad QT_QPA_PLATFORM=offscreen KICAD_CLI=kicad-cli
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
