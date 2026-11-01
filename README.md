# Jumper

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
| Checks | BullMQ worker runs kicad-cli (ERC, DRC with schematic parity, SVG renders, ray-traced 3D renders, GLB/STEP, Gerbers + drill, pick-and-place, schematic/board PDFs, netlist, optional IPC-2581/ODB++) in a sandbox; 3D model paths from older KiCad versions are remapped to the installed library; one-click JLCPCB manufacturing package (gerbers + BOM + CPL); results, violation markers and downloads in the UI; configurable via `.jumper.yml` |
| BOM sourcing | Live pricing and stock from LCSC and JLCPCB (no keys) plus Mouser and DigiKey (API keys), matched by LCSC code, MPN or value + footprint; MOQ/price-break aware totals per supplier and cheapest mix for N boards; datasheet links; priced CSV and JLCPCB BOM export |
| Compare | Any two revisions of a schematic or board side by side, overlay or swipe (Blob → Compare versions, or Compare in file history), plus side-by-side 3D for boards |
| 3D | Live 3D board generated in the browser from the .kicad_pcb (rotate, flip, turntable, mask colour), KiCad GLB with real models, STEP tessellated by OpenCascade, and KiCad ray-traced renders |
| Issues & discussions | Issues and discussions with labels, assignees, milestones with progress, and links to parts, nets or board locations; `@mentions` and a notification inbox (only ever sent to people who can read the repo) |
| Review process | Per-PR review checklist from a repo template, path-based sign-off rules (“power/** needs alice”), whole-file locks that block conflicting merges, region locks, all enforced in the merge box |
| Design analysis | Measured board statistics, fab-compatibility checks (JLCPCB, PCBWay, OSH Park, Eurocircuits), auto-written design changelog, part policy (approved/preferred/banned), BOM cost at 1/10/100/1000 boards, firmware pin map (`pins.h`, Zephyr overlay, CSV) with pin-change diff |
| Engineering tools | IPC-2221 trace width, IPC-2141 impedance (microstrip, stripline, differential), power-budget calculator |
| Sharing & integration | Expiring, revocable, optionally watermarked read-only share links for clients and fabs; signed webhooks with SSRF protection and a delivery log |
| Accounts & organizations | Self-service account deletion with a preview of what goes (content you wrote elsewhere is kept as “ghost”), password reset by email or admin link, data export, organization settings (members, roles, leave, delete), forks of public and private repositories |
| Platform | Users, orgs, collaborators, private repos, personal access tokens with scopes, GitHub OAuth, sessions with CSRF guard, rate limiting, audit log, live updates over WebSocket, OpenAPI docs at `/api/docs` |

## Repository layout

```
apps/web/            React SPA (Vite, TanStack Router/Query, Tailwind)
apps/api/            Fastify API + git smart-HTTP
apps/worker/         BullMQ job runner (kicad-cli pipeline)
packages/kicad-core/ Rust: parser, diff, BOM (native CLI + WASM for Node/browser)
packages/viewer/     WebGL schematic/PCB renderer, 3D viewer
packages/ui/         Design system (tokens + React components)
packages/shared/     Zod schemas, API types, .jumper.yml config
packages/db/         Drizzle schema + migrations (PostgreSQL)
packages/storage/    Artifact storage (S3/MinIO or local filesystem)
docker/              Compose files, Dockerfiles, Caddyfile
docs/                Architecture, configuration, self-hosting
```

## Development

Prerequisites: Node 22+, pnpm, Rust (stable) with the `wasm32-unknown-unknown` target, `wasm-pack`, git ≥ 2.38,
PostgreSQL and Redis (or Docker). `kicad-cli` (KiCad 8/9; 9 recommended for ray-traced renders) is needed only for ERC/DRC/render/export checks.
With `KICAD_CLI=auto` the worker uses `kicad-cli` from PATH, or the host's kicad-cli via `flatpak-spawn` when it runs inside a Flatpak sandbox (e.g. a VSCodium terminal).

```sh
pnpm install
pnpm wasm                                            # build the Rust core (WASM + CLI)
docker compose -f docker/docker-compose.dev.yml up -d # postgres, redis, minio
cp .env.example .env
pnpm dev                                             # web :5173, api :3000, worker (hot reload)
```

**Day-to-day use, demos and anything performance-sensitive:** run the optimized build instead. It starts in a few
seconds, uses a fraction of the memory and loads pages ~10× faster than the dev server:

```sh
pnpm start        # builds, then runs api + worker + web on :3000 / :5173
pnpm start:fast   # run what is already built
```

Open http://localhost:5173 — register an account, then run `pnpm admin:grant <username>` on the server to make it the instance admin (nobody is admin by default). The same CLI creates users, prints password-reset links and deletes accounts: `pnpm admin` lists the commands.
Admins get **Admin** in the header: instance stats, user management (promote, suspend) and a read-only
database browser at `/admin/database` (secret columns are never sent). To edit rows, run `pnpm db:studio`.
In-app docs live at `/docs` (sources in `docs/` and `apps/web/src/docs/`).
Migrations run automatically when the API starts (`AUTO_MIGRATE=true`).

```sh
pnpm lint && pnpm typecheck && pnpm test   # all packages (Rust tests included)
pnpm build                                 # production bundles
```

### Testing

API integration tests boot the real app against a throwaway PostgreSQL database named `pcbhub_test` (created
automatically; override with `TEST_DATABASE_URL`, whose database name must contain “test”). They are skipped when
PostgreSQL is not reachable. Start `pnpm services` first to run them. Redis is not required for tests.

### Where things live

```
apps/api/src/modules/<name>/   one folder per API module: routes.ts, services, tests (see apps/api/README.md)
apps/api/src/tests/            cross-module integration and security tests
apps/web/src/app/              router and the app shell (header, footer)
apps/web/src/features/<name>/  one folder per screen area (see apps/web/README.md)
apps/web/src/shared/           components and helpers used by several features
packages/engineering/          pure engineering logic with no I/O (calculators, fab rules, pin maps)
```

A new API module is wired in by one line in `apps/api/src/modules/index.ts`; a new screen by one route in
`apps/web/src/app/router.tsx`.

## Production

`docker compose -f docker/docker-compose.yml up -d --build` starts Postgres, Redis, MinIO, the API, the
KiCad worker and Caddy (serving the SPA and proxying the API and git). See [docs/self-hosting.md](docs/self-hosting.md).
