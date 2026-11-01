# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:/root/.cargo/bin:$PATH CI=true
RUN corepack enable \
 && curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown \
 && cargo install wasm-pack --locked
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @jumper/kicad-core run build:web \
 && pnpm --filter @jumper/web build

FROM caddy:2-alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv
EXPOSE 80
