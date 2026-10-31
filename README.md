# PCBHub

GitHub-style collaboration for KiCad hardware projects: git hosting, semantic
schematic/PCB diffs, in-browser viewers that look like KiCad, pull requests with
visual review, and automated ERC/DRC/BOM checks.

See [plan.md](plan.md) for the product brief and [TECH_PLAN.md](TECH_PLAN.md) for the full technical plan.

## What's in the box

| Area | Implementation |
|---|---|
| Git hosting | Bare repos on disk, smart HTTP via `git http-backend` (protocol v2), token/password auth, push size limits, `receive.fsckObjects` |
| Code browsing | Trees, blobs, raw, history, branches, compare, README rendering (sanitized Markdown) |
| Semantic diff | Rust crate (`packages/kicad-core`): S-expression parser → typed model → UUID-matched diff of footprints, tracks, vias, zones, nets, symbols, wires, labels, sheets; net reroute summaries; BOM diff; object-level merge conflicts. Compiled to WASM for Node and the browser, plus a native CLI. |
| Viewers | WebGL (PixiJS) PCB and schematic renderers in KiCad's default colours with layer toggles, flip, net highlight, find-by-reference, hierarchical sheet navigation; kicad-cli SVG renders; 3D via three.js (GLB) and OpenCascade WASM (STEP) |
| Pull requests | Reviews (approve/request changes), timeline, line comments on text diffs, comments anchored to design objects, side-by-side/overlay/swipe visual diffs, mergeability (conflicts, required checks, approvals), merge/squash/fast-forward without a worktree |
| Checks | BullMQ worker runs kicad-cli (ERC, DRC with schematic parity, SVG renders, GLB/STEP/Gerber exports) in a sandbox; BOM from the Rust core; results and violation markers in the UI; configurable via `.pcbhub.yml` |
| Platform | Users, orgs, collaborators, private repos, personal access tokens with scopes, GitHub OAuth, sessions with CSRF guard, rate limiting, audit log, live updates over WebSocket, OpenAPI docs at `/api/docs` |

## Repository layout

```
apps/web/            React SPA (Vite, TanStack Router/Query, Tailwind)
apps/api/            Fastify API + git smart-HTTP
apps/worker/         BullMQ job runner (kicad-cli pipeline)
packages/kicad-core/ Rust: parser, diff, BOM (native CLI + WASM for Node/browser)
packages/viewer/     WebGL schematic/PCB renderer, 3D viewer
packages/ui/         Design system (tokens + React components)
packages/shared/     Zod schemas, API types, .pcbhub.yml config
packages/db/         Drizzle schema + migrations (PostgreSQL)
packages/storage/    Artifact storage (S3/MinIO or local filesystem)
docker/              Compose files, Dockerfiles, Caddyfile
docs/                Architecture, configuration, self-hosting
```

## Development

Prerequisites: Node 22+, pnpm, Rust (stable) with the `wasm32-unknown-unknown` target, `wasm-pack`, git ≥ 2.38,
PostgreSQL and Redis (or Docker). `kicad-cli` (KiCad 8/9) is needed only for ERC/DRC/render/export checks.

```sh
pnpm install
pnpm wasm                                            # build the Rust core (WASM + CLI)
docker compose -f docker/docker-compose.dev.yml up -d # postgres, redis, minio
cp .env.example .env
pnpm dev                                             # web :5173, api :3000, worker
```

Open http://localhost:5173 — the first account you register becomes the instance admin.
Migrations run automatically when the API starts (`AUTO_MIGRATE=true`).

```sh
pnpm lint && pnpm typecheck && pnpm test   # all packages (Rust tests included)
pnpm build                                 # production bundles
```

Push a project:

```sh
git remote add origin http://localhost:5173/<you>/<repo>.git
git push -u origin main    # username + personal access token (Settings → Access tokens)
```

## Production

`docker compose -f docker/docker-compose.yml up -d --build` starts Postgres, Redis, MinIO, the API, the
KiCad worker and Caddy (serving the SPA and proxying the API and git). See [docs/self-hosting.md](docs/self-hosting.md).
