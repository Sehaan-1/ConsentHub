# ConsentHub

ConsentHub is a consent-management platform organised as one contract-first monorepo. The
TypeScript half uses pnpm workspaces and the Java half uses a Maven multi-module build.

## Repository layout

| Path | What it is |
|---|---|
| `packages/ui` | Shared React 18 component library consumed by both frontends |
| `apps/customer-portal` | Customer React + Vite SPA |
| `apps/ops-console` | Operations React + Vite SPA |
| `apps/bff` | Node + TypeScript backend-for-frontend |
| `apps/partner-sandbox` | Node + TypeScript partner mock |
| `contract/openapi` | Shared OpenAPI contract |
| `backend/consenthub-domain` | Entities, domain services, and state machines |
| `backend/consenthub-infra` | Repositories, outbox poller, and scheduled jobs |
| `backend/consenthub-api` | Spring Boot controllers, security, and configuration |

## Getting started

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
mvn -q -pl backend/consenthub-domain -am verify
```

The frontend calls the BFF through the relative URL `/api/hello`. The BFF forwards that
request to the backend using `BACKEND_URL`; browser code never contains a backend host.
For a complete local stack, use `docker compose up --build` or `make up`.

## Development commands

- `pnpm dev` starts all TypeScript applications in parallel.
- `pnpm build` builds every workspace.
- `pnpm test` and `pnpm lint` run the strict TypeScript checks in every workspace.
- `make verify` runs the Java and TypeScript verification entry points.

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
