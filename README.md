# Jumper

The KiCad companion for GitHub. Keep your hardware projects where they are; Jumper follows the repository and
turns every commit into something you can check:

- **Visual diffs.** Any two revisions of a schematic or board, side by side, overlaid, swiped or in 3D, with parts,
  nets and tracks matched by KiCad UUID rather than lines of text.
- **ERC and DRC on every commit**, run by `kicad-cli` in a sandbox, with violations you can locate on the board.
- **A priced BOM**: live stock and price breaks from LCSC, JLCPCB, Mouser and DigiKey, cost at 1 to 1000 boards,
  stock and end-of-life alerts.
- **Fab packages**: Gerbers, drill, pick-and-place, PDFs, STEP and GLB, packaged for JLCPCB, PCBWay or OSH Park.
- **Team controls**: organizations, roles, single sign-on, SCIM, audit log, branch protection, share links.

Repositories come in from GitHub (or GitLab, Gitea, any git URL) as pull mirrors, or are pushed directly over
HTTPS, SSH or the KiCad plugin.

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
plugins/kicad/        KiCad action plugin (commit, push, compare from the PCB editor)
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
In-app docs live at `/docs` (sources in `apps/web/src/features/docs/content/`).
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
KiCad worker and Caddy (serving the SPA and proxying the API and git). Set the secrets in `.env` first
(`cp .env.example .env`); every option is described there. Set `PLANS_ENFORCED=true` on a hosted instance to apply
plan limits.
