# ConsentHub

ConsentHub is a consent-management platform organised as one contract-first monorepo. The
TypeScript half uses pnpm workspaces and the Java half uses a Maven multi-module build.

## Quick start

```bash
git clone https://github.com/Sehaan-1/ConsentHub.git
cd ConsentHub
./scripts/boot.sh
```

That is the whole quick start (equivalently: `make boot`). The script copies
`.env.example` to `.env` when `.env` does not exist (dev-only credentials; `.env`
is gitignored), then runs `docker compose up --build`. First boot builds the
backend image and initialises MySQL/Redis, so allow a few minutes.

On first boot the backend (Spring profile `docker`) runs the Flyway migrations
against the `mysql` container — schema plus demo seed data — so the system is
seeded automatically. `docker compose down -v` removes all containers **and**
all state (volumes), and a fresh `./scripts/boot.sh` reproduces the system from
scratch.

### Services and ports

| URL (host) | Service | Notes |
|---|---|---|
| http://localhost:5173 | customer-portal | Vite dev server (HMR) |
| http://localhost:5174 | ops-console | Vite dev server (HMR) |
| http://localhost:4000 | bff | `/api/hello`, `/health` |
| http://localhost:8080 | backend | `/api/hello`, `/actuator/health` |
| http://localhost:4100 | partner-sandbox | mock FIU / FIP / notification receiver |
| (internal) | mysql, redis | compose network only; ports not published |

Frontends talk to the BFF through same-origin `/api` (Vite proxy in dev, nginx
proxy in the production override) — browser code never contains a backend host
or a localhost call.

### Configuration

All credentials live in `.env` (created from the committed `.env.example`);
`docker-compose.yml` only references them via `${VAR}` interpolation, so no
secret is committed. Variables:

| Variable | Used by | Purpose |
|---|---|---|
| `MYSQL_ROOT_PASSWORD` | mysql | image initialisation + healthcheck |
| `MYSQL_DATABASE` | mysql, backend | database name (default `consenthub`) |
| `MYSQL_USER` / `MYSQL_PASSWORD` | mysql, backend | application account |
| `REDIS_PASSWORD` | redis, backend | `requirepass` AUTH |

### Production-flavoured stack

`compose.prod.yml` swaps the dev servers for production images (nginx-served
frontends with an `/api` proxy, compiled BFF and sandbox on JRE/runtime-only
Node images) while keeping the same dependency graph:

```bash
docker compose -f docker-compose.yml -f compose.prod.yml up --build   # or: make up-prod
```

## Development without Docker

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
mvn -q -pl backend/consenthub-domain -am verify
```

The frontend calls the BFF through the relative URL `/api/hello`. The BFF forwards that
request to the backend using `BACKEND_URL`; browser code never contains a backend host.
For a complete local stack, use `./scripts/boot.sh` (or `docker compose up --build` /
`make up`).

### Backend profiles

- **default / `dev`** — in-memory H2 in MySQL mode; starts with zero external
  services (`mvn -f backend/pom.xml -pl consenthub-api spring-boot:run` works as-is).
  Flyway applies the same migrations + demo seed as the docker stack.
- **`docker`** — MySQL 8 (`mysql`) and Redis 7 (`redis`) compose hostnames with
  `SPRING_FLYWAY_ENABLED=true`; `/actuator/health` then genuinely depends on
  both stateful services and is what the compose healthcheck polls.

Note: dev seeding stays in the `dev` profile — it must never share a database
with the compose MySQL instance (which belongs to Flyway) or with
Testcontainers-based tests.

## Repository layout

| Path | What it is |
|---|---|
| `packages/ui` | Shared React 18 component library consumed by both frontends |
| `apps/customer-portal` | Customer React + Vite SPA |
| `apps/ops-console` | Operations React + Vite SPA |
| `apps/bff` | Node + TypeScript backend-for-frontend |
| `apps/partner-sandbox` | Node + TypeScript partner mock (FIU / FIP / notifications) |
| `contract/openapi` | Shared OpenAPI contract |
| `backend/consenthub-domain` | Entities, domain services, and state machines |
| `backend/consenthub-infra` | Repositories, outbox poller, and scheduled jobs |
| `backend/consenthub-api` | Spring Boot controllers, security, and configuration |
| `docker/` | Dockerfiles: backend (Maven → JRE), node dev/prod, nginx frontends |
| `scripts/boot.sh` | One-command boot (env bootstrap + `docker compose up --build`) |

## Development commands

- `pnpm dev` starts all TypeScript applications in parallel.
- `pnpm build` builds every workspace.
- `pnpm test` and `pnpm lint` run the strict TypeScript checks in every workspace.
- `make verify` runs the Java and TypeScript verification entry points.
- `make boot` / `make up` / `make up-prod` / `make down` drive the compose stacks.

## Architecture Decision Records

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](docs/adr/0001-monorepo-vs-polyrepo.md) | Monorepo vs Polyrepo for ConsentHub | Accepted | 2026-09-15 |
| [ADR-0002](docs/adr/0002-authentication-model.md) | Authentication and session model | Accepted | 2026-09-15 |
| [ADR-0003](docs/adr/0003-append-only-audit-model.md) | Append-only audit ledger | Accepted | 2026-09-15 |
| [ADR-0004](docs/adr/0004-frontend-state-management.md) | Frontend state management split | Accepted | 2026-09-17 |

## Commit and branch policy

Commits follow the Conventional Commits format, enforced by commitlint and the Husky
`commit-msg` hook. `main` requires a pull request, one approving review, and all required CI
checks; the declarative settings are recorded in `.github/branch-protection.yml`.
