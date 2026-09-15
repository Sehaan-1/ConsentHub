# ADR-0001: Monorepo vs Polyrepo for ConsentHub

- **Status:** Accepted
- **Date:** 2026-09-15
- **Deciders:** ConsentHub engineering
- **Tags:** architecture, repository-structure, ci-cd, contract-first

## Context

ConsentHub ships as a set of deployables that must be versioned together:

- Two React single-page apps — the customer **web** app and the partner **portal**.
- A Node **BFF** (backend-for-frontend) that adapts the public API for the SPAs.
- A **mock partner sandbox** used by integrators to test against a fake partner.
- A Java **backend** (Spring Boot) that owns the system of record and the OpenAPI contract.

The binding constraint is contract evolution. When the OpenAPI contract changes in the
backend, the BFF and the two SPAs must adapt in the *same* change set, or the build must
fail. We have to decide the repository topology **before** scaffolding so the layout is
deliberate, not accidental.

Two topologies are on the table:

- **(a) Monorepo** — one repository; the JavaScript/TypeScript half is managed with
  pnpm workspaces at the root, and the Java half is a Maven multi-module build under
  `backend/`.
- **(b) Polyrepo** — two repositories: `consenthub-platform` (backend + contract) and
  `consenthub-clients` (the two SPAs, the BFF, and the mock sandbox).

## Decision

We adopt **(a) a single monorepo** with pnpm workspaces at the root and a Maven
multi-module build under `backend/`.

The OpenAPI contract is a first-class file at the repository root
(`contract/openapi/consenthub-api.yaml`) and is consumed by **both** halves through code
generation, so a contract edit is visible to every consumer in the same PR.

## Consequences

**Positive**

- Contract-first development actually pays off: the spec and both consumers live in one PR.
  A breaking change to the spec regenerates the BFF types and the backend stubs in the same
  change set, and CI fails immediately if either side is incompatible.
- One clone, one issue tracker, one CI pipeline, one `pnpm install`. A new engineer gets a
  working system with a single command.
- Cross-cutting refactors (auth, logging, version bumps) span every module in a single,
  reviewable PR.
- The Maven multi-module build under `backend/` keeps the Java services in lockstep with
  each other and with the contract.

**Costs / trade-offs**

- A single, growing repository: `git` operations and CI caches need housekeeping over time.
- Everyone shares one CI queue and one main branch; a red main branch blocks all merges.
- Toolchain breadth (Node + Maven/Java) in one repo requires a clear layout convention and
  disciplined workspace boundaries.

## Alternatives considered

### (b) Polyrepo — rejected

Two repositories: `consenthub-platform` (backend + contract) and `consenthub-clients`
(SPAs, BFF, mock sandbox).

**How the contract would be shared:** the contract is owned by `consenthub-platform` and
published as a *versioned artifact* — an npm package (for the JS half) and a JAR (for the
Java half) produced by a dedicated release pipeline. The clients repo consumes a pinned
contract version.

**CI consequence:** two pipelines (one per repo) **plus** a contract-release pipeline.
Cross-repo compatibility is enforced by a contract-test job in `consenthub-clients` that
runs against the published contract version.

**Why it lost (60-second version):** a contract change can no longer fail the frontend build
*in the same PR*. It requires a version bump in `consenthub-platform`, a separate release,
then a dependent PR in `consenthub-clients` — leaving a window of version skew across two
repos and two tracking boards, which directly defeats the contract-first goal that motivated
this decision. A polyrepo only earns its overhead when the two halves are owned by separate
teams that must deploy and version independently — which is not our case for the week-0
system.

## OpenAPI contract sharing — side by side

| | Monorepo (chosen) | Polyrepo (rejected) |
|---|---|---|
| Contract location | `contract/openapi/consenthub-api.yaml` at repo root | Owned by `consenthub-platform`, published as an artifact |
| Frontend consumption | `openapi-typescript` / `orval` generate typed clients at build time from the root spec | Install the published npm contract package at a pinned version |
| Backend consumption | `openapi-generator-maven-plugin` generates server stubs; a contract test asserts the running API matches | Same plugin, but against the published JAR spec version |
| Failure mode | Spec edit in a PR regenerates both sides; build fails immediately if incompatible | Spec edit ships as a new version; clients break only after a separate bump PR |

## CI consequence — side by side

| | Monorepo (chosen) | Polyrepo (rejected) |
|---|---|---|
| Pipeline shape | One workflow at repo root that fans out (matrix / reusable `workflow_call`) across JS workspaces and Maven modules | Two pipelines (platform, clients) + a contract-release pipeline |
| Status checks | Single set of checks on one PR | Coordinated checks across two repos + an artifact gate |
| Contract drift | Impossible within a PR — both sides generated from the same file | Possible during the bump window between the two repos |

## References

- Repo layout implemented by this decision: `pnpm-workspace.yaml`, `apps/*`, `services/bff`,
  `sandbox/partner-mock`, `contract/openapi`, `backend/` (Maven multi-module).
- Companion CI: `.github/workflows/ci.yml`.
