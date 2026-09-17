# ConsentHub

A consent-management platform: two React apps, a Node BFF, a mock partner sandbox, and a
Java backend, versioned together in a single pnpm + Maven monorepo.

## Repository layout

| Path | What it is |
|---|---|
| `apps/web` | Customer React SPA |
| `apps/portal` | Partner React SPA |
| `services/bff` | Node backend-for-frontend (consumes the OpenAPI contract) |
| `sandbox/partner-mock` | Mock partner sandbox for integrators |
| `contract/openapi` | The shared OpenAPI contract (single source of truth) |
| `backend` | Java backend as a Maven multi-module build |

## Getting started

```bash
pnpm install
pnpm contract:generate   # regenerate typed clients from the OpenAPI contract
pnpm build
```

## Architecture Decision Records

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](docs/adr/0001-monorepo-vs-polyrepo.md) | Monorepo vs Polyrepo for ConsentHub | Accepted | 2026-09-15 |
| [ADR-0002](docs/adr/0002-authentication-model.md) | Authentication and session model | Accepted | 2026-09-15 |
| [ADR-0003](docs/adr/0003-append-only-audit-model.md) | Append-only audit ledger | Accepted | 2026-09-15 |
| [ADR-0004](docs/adr/0004-frontend-state-management.md) | Frontend state management split | Accepted | 2026-09-17 |
