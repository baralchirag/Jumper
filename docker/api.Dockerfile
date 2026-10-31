# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:/root/.cargo/bin:$PATH CI=true
RUN corepack enable \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown \
 && cargo install wasm-pack --locked
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @pcbhub/kicad-core run build:node \
 && pnpm --filter @pcbhub/api build \
 && pnpm --filter @pcbhub/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist \
 && mkdir -p /out/node_modules/@pcbhub/kicad-core \
 && cp -r packages/kicad-core/package.json packages/kicad-core/pkg-node /out/node_modules/@pcbhub/kicad-core/ \
 && cp -r packages/db/drizzle /out/drizzle

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 1001 -m pcbhub && mkdir -p /data/repos && chown pcbhub /data/repos
WORKDIR /app
COPY --from=build --chown=pcbhub /out /app
USER pcbhub
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
