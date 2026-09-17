# ADR-0004: Frontend state management split

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** ConsentHub engineering
- **Tags:** frontend, state-management, caching, tanstack-query, zustand, sse, testing

## Context

Two React SPAs sit on top of the same API: the customer portal (`apps/web`, role `CUSTOMER`) and the
ops console (`apps/portal`, roles `AGENT` / `SUPERVISOR` / `ADMIN`), built in weeks 3–4 (#56–#73).
Both consume generated types from `contract/openapi/consenthub-api.yaml` (ADR-0001), both hold their
access token in memory and refresh it from an `httpOnly` cookie (ADR-0002), and both render data
whose authority is the append-only ledger (ADR-0003).

The plan's one-liner is *"caching and invalidation belong to Query, UI state to Zustand"*. This ADR
decides what that means precisely enough that two apps, built by different people in different
weeks, cannot drift. Three failure modes are already visible from here:

1. **The stale consent.** Every screen is a projection of rows some *other* actor can change while
   the screen is open: an FIU raises a request, the expiry job flips `ACTIVE` → `EXPIRED` (#51), a
   second tab revokes, a supervisor approves somebody else's paperwork. A dashboard that says
   "active" after the FIU has been cut off does not undermine the cache — it undermines the product
   claim, which is *proof of consent*. A hand-rolled cache is exactly how that happens: a store, a
   `useEffect` fetch, a `setState` on success, and an invalidation nobody remembered to write.
2. **The lie.** An approval that renders as done before the server recorded it tells the customer
   they granted something that may never have been written — or that they withheld something that
   was. Optimism is a UX choice; it is not allowed to be an authorisation claim.
3. **The leak.** Client state is a copy of personal data living in a browser process. Whatever we
   keep, and for how long, is a retention decision; whatever we *persist* outlives the tab, the
   logout and the session. ADR-0002 §8 removed the access token from `localStorage` for exactly this
   reason, and the argument does not stop at the token.

Constraints that shape the decision:

- **The client's API surface is generated, not hand-written** (ADR-0001, #26, #58). Query keys and
  cache identity have to be derivable from generated types, or a contract change becomes a runtime
  mismatch instead of a compile error.
- **The server owns consent state and says so loudly.** `consent_artefact` carries a `@Version`
  optimistic lock and the state machine is the only writer of `status` (ADR-0003 §8, #31), so a 409
  is a *normal* outcome the UI must explain in words (#62), not a generic error string.
- **Reads have write side-effects.** `GET /api/v1/audit` writes an `AUDIT_READ` row and the CSV
  export writes `AUDIT_EXPORTED` (ADR-0003 §13.2). Refetch policy is therefore also a
  write-amplification policy; "just refetch aggressively" is not free.
- **The ledger is the only truth** (ADR-0003 §12.2: no state change without its row, in the same
  transaction). A client cache *written from* a stream rather than re-read *from* the ledger is a
  third representation of the record, and §6 refuses to create one.
- **Freshness has a deadline in the demo script.** #78's acceptance criterion is that revoking in
  another tab updates the open dashboard within a second; #58's is that a successful revoke refetches
  the consent list. Both are cache-policy statements, and both must hold with no cache write.
- **Everything is tested with MSW request counts** (#65). "The list was refetched" is an assertion we
  can write; "the cache is coherent" is not.

## Decision

**Four homes, one rule each, and one asymmetry about optimism.**

> **If the server can change a value without this tab knowing, it belongs to TanStack Query. If it
> must survive a reload, a bookmark, a share or the back button, it belongs to the URL. If only this
> browser session can change it and more than one component renders it, it belongs to Zustand.
> Otherwise it is `useState`. Imperative, non-rendered resources (the access token, the stream
> client, the `QueryClient`) are module scope, not state at all.**

> **An optimistic patch may only ever *narrow* what the customer appears to be sharing (revoke,
> pause). A mutation that grants, restores or extends (approve, resume, deny) is applied only after
> the server has recorded it.**

The decision in full:

1. **Server state is Query, and only Query** — consents, consent requests, timelines, access logs,
   pinned notices, DSARs, approvals, the audit viewer, the session inventory and reference data are
   `useQuery` reads of the API. The cache is the only client-side copy of a server fact, and it is a
   *cache*: it can be discarded at any moment without loss.
2. **UI state is Zustand, and Zustand holds nothing else** — ids, codes, booleans, numbers and the
   user's own in-progress input. Never an API entity, never a credential, never a derived count of
   server rows.
3. **Shareable state is the URL** — route identity, applied filters, page number, a linkable modal.
4. **One `QueryClient` per app**, built by `createQueryClient()` with the defaults in §3.1, so no
   screen invents its own `staleTime` and tests share the production policy.
5. **Mutations declare an invalidation set from a table** (§4). A mutation is finished when every
   read model that could contain the changed fact has been invalidated — not when the server
   answers 200.
6. **Revoke is optimistic with an exact rollback** (§5): `cancelQueries` → snapshot → narrow →
   rollback on every error path → `onSettled` invalidation.
7. **The SSE stream is a change hint** (§6): an event maps to a query key and invalidates it. Nothing
   is written into the cache from the wire, not even when the payload carries the new state.
8. **Nothing personal is persisted, and logout empties everything** (§7.5): no `persistQueryClient`,
   a four-key preference allowlist, and `queryClient.clear()` plus a reset of every store on the
   ADR-0002 §5 logout path.

The property a reviewer can test: **every value has exactly one home, no screen holds server truth,
and the UI can never show more consent than the ledger records.**

### 1. The rule, and why the boundary sits there

Classification asks three questions, in order:

1. **Can the server change it without this tab knowing?** → **Query.** If yes, it is not client state,
   however convenient a store would be.
2. **Must it survive a reload, a bookmark, a share or the back button?** → **the URL.**
3. **Do two components that are not parent and child render it, or must it outlive a component?**
   → **Zustand.** Otherwise → `useState`.

Why neither direction is negotiable:

| Mistake | What actually goes wrong |
|---|---|
| Server data in Zustand | It is a second copy of a fact the ledger owns. Every mutation in every screen must remember to update it, every server-side job that changes the row misses it, and the failure mode is a customer being told they are still sharing data when they are not. Missing *updates* are undetectable from the client — there is no compile error for "you forgot to sync the store". |
| UI state in the Query cache | The cache's lifetime policy is meaningless for a wizard draft: `gcTime` can collect a half-completed approval, and any overlapping prefix invalidation wipes it. Worse, it destroys the one claim that makes the invalidation contract checkable — that every key under `src/api/keys.ts` names a server resource. |
| Shareable state in a store | The URL stops being the source of truth for "what is on screen". Support cannot be sent the view they are looking at, the back button lies, and the ops console records a search under filters nobody can reproduce (#69). |
| Server data in `useState`, per screen | The same problem as the store, one screen at a time, and it is invisible in review: each screen looks locally correct; the system is inconsistent. |

The reason this matters more here than in a CRUD app: **every screen is the customer-facing rendering
of an auditable fact.** The moment a value has two homes, "which one is true?" becomes a question
only the code can answer.

### 2. The census: every named piece of state and its home

This is the table the acceptance criterion asks for. §9 is how to use it on a value that is not
listed.

#### 2.1 Server state → TanStack Query

| State | Key | Notes |
|---|---|---|
| Consent list (filtered, sorted, paged) | `consentKeys.list(filters)` | #36, #61. Filters are part of the key: two filter views are two entries, never one mutated list. |
| Consent detail | `consentKeys.detail(id)` | #36, #61, #62 |
| Consent timeline (ledger events) | `consentKeys.events(id)` | #37, #63. Nested under the detail key, so one prefix invalidation covers it (§4.3). |
| Access log for a consent | `consentKeys.accessLog(id, window)` | #40, #63. The window is in the key; `keepPreviousData` keeps the table from blanking on a filter change. |
| Pinned notice + history | `consentKeys.notice(id)` | #64, ADR-0003 §9. `staleTime: Infinity` — the pin is immutable rows. |
| Pending consent requests, list + detail | `requestKeys.list(filters)` / `requestKeys.detail(id)` | #33, #60 |
| Dashboard aggregate (BFF) | `dashboardKeys.all` | #77, #61. A read model, and §4.2 makes it a mandatory invalidation target. |
| DSARs (queue, detail, SLA fields) | `dsarKeys.*` | #44, #72 |
| Approval queue + decision history | `approvalKeys.*` | #45, #71 |
| Audit events (paged, filtered) | `auditKeys.list(filters)` | #46, #73. Special freshness policy in §3.3 because reading is audited. |
| Caller's live sessions | `sessionKeys.all` | ADR-0002 §5, lands with #26 |
| Reference data: purposes, categories, FIU registry | `referenceKeys.*` | #14, #42, #26. Slow-changing; long `staleTime`. |
| Customer record and search results (ops) | `customerKeys.detail(id)` / `customerKeys.list(term)` | #69. The search term in the key is debounced (§3.2). |

#### 2.2 Shareable state → the URL

| State | Where | Why |
|---|---|---|
| Selected entity | Route params: `/consents/:id`, `/requests/:id`, `/dsar/:id` | Refresh, deep link, back button. The param *is* the query-key argument. |
| Access-log window and category filter | `?from=&to=&category=` | #63's "the date-range filter issues the right query params". |
| Audit viewer filters | `?from=&to=&actorType=&eventType=&consentId=&page=` | #73's "the query params match the API contract". An investigation has to be reproducible by URL. |
| Dashboard status filter, sort, search term | `?status=&sort=&q=` | #61: filters compose and are test-covered; shareable. |
| Approval queue filter, DSAR status and breached-only, page numbers | `?status=&page=` | #71, #72 |
| A dialog a link should reopen | e.g. `/consents/:id/revoke` | If a link, a refresh or the back button should restore it, it is the URL. A dialog only the current click opened is `useState`. |

#### 2.3 Client state → Zustand

| State | Store | Lifetime / reset |
|---|---|---|
| Approval wizard: step, granular category toggles, expiry pick, deny reason | `useApprovalDraft` | Keyed by `requestId`; reset on route change, on a different `requestId`, on a successful decision, on logout (§7.2) |
| Filter panel open/closed and its uncommitted draft values | `usePanelState` | Route change, Apply/Cancel, logout. The *applied* filter is in the URL; only the draft is here. |
| Row multi-select for bulk actions | `useSelection` | Route change, after the bulk mutation, logout (#72) |
| Toasts and banners | `useToasts` | Transient. In a store because non-React code raises them (the `QueryCache` error handler, the stream client). |
| Stream status badge (`connecting`/`live`/`polling`/`offline`) | `useStreamStatus` | §6.5. The connection object is module scope; only the rendered status is a store. |
| Idle-timeout warning dismissed, step-up prompt open | `useSessionUi` | Per tab; ADR-0002 §6. Reset after successful re-auth and on logout. |
| Preferences: theme, density, reduced motion, table page size | `usePrefs` | The only persisted store, via an explicit allowlist (§7.5) |
| "Reason for access" text on the ops console | `useAccessReasonDraft` | Draft only; what the ledger records is the server's `AUDIT_READ` row (#69, ADR-0003 §13.2) |

#### 2.4 Non-rendered resources → module scope

The access token, the single-flight refresh promise, the `QueryClient`, the generated API client and
the stream connection are objects with a lifetime, not state to render. They live in module scope —
exactly as ADR-0002 §2 puts the access token in "a variable in a closure". The only thing that
crosses from module scope into a store is a *status* somebody renders: the stream badge (§6.5).

#### 2.5 The four traps, and the derived-value rule

These are the values that look like they belong in a store and do not. All four recur in review:

| Looks like | Actually | Because |
|---|---|---|
| `isLoading` / `isError` flags for a fetch | `isPending` / `isError` on the query | A parallel flag is a second source of truth that a second observer of the same query will not update. |
| "Last updated" indicator | `query.state.dataUpdatedAt` | Every query already has it; storing it means keeping it in sync. |
| Pending-count badge in the nav (#71) | `usePendingRequests().data?.total` | The classic drift bug: every mutation must remember to increment a counter. Derive it, and the same invalidation contract (§4) refreshes it. |
| DSAR SLA countdown (#72) | Server `dueAt` + a ticking clock | Store the anchor that came from the server, never a decrementing number that drifts when the tab is suspended. |

> **Rule:** a value computable from the cache is never stored. Store the input, derive the rest in a
> selector or in the component.

### 3. TanStack Query: one client, typed keys, fixed defaults

#### 3.1 One `QueryClient` per app, built by a factory

```ts
// apps/*/src/api/queryClient.ts
export function createQueryClient({ retry = retryUnlessClientError } = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 300_000,
        retry,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        throwOnError: false,
      },
      mutations: { retry: 0 },
    },
    queryCache: new QueryCache({ onError: reportQueryError }),     // Problem → toast, one place
    mutationCache: new MutationCache({ onError: reportMutationError }),
  });
}

// 4xx other than 408/429 are answers, not failures: retrying them cannot help.
function retryUnlessClientError(failureCount: number, error: unknown) {
  const status = (error as ApiError).status;
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  return failureCount < 2;
}
```

- **One per app, not one per route or screen.** A cache recreated on navigation is not a cache; it is
  a fetch per render. #56's shell mounts the provider once, above the router.
- **A function, not a module singleton, so tests get a fresh one.** #65's render helper calls
  `createQueryClient({ retry: false })` and clears it in teardown. A shared singleton in tests leaks
  state between specs and is the most common source of order-dependent failures in a Query codebase.
- **`gcTime` is a retention number, and it is chosen, not defaulted.** Five minutes after the last
  observer goes away, the browser's copy of that consent is gone. It is not a security boundary — it
  is the shortest defensible value that does not cause a refetch storm on tab switches — but it is
  the number to look at when someone asks "how long does the browser keep my data", and it is why
  §7.5 forbids persisting the cache.

#### 3.2 The key factory is the contract

Every query-key literal in an app comes from one file (`src/api/keys.ts`); components never write one
by hand. The factory's argument types come from the generated client (#58, generated by #26's
contract), so a contract change that renames or reshapes a parameter fails `tsc` at the single place
keys are built:

```ts
// apps/web/src/api/keys.ts — the only file in the app that contains a query-key literal.
export type ConsentFilters = NonNullable<operations['listConsents']['parameters']['query']>;
export type AccessWindow  = { from: string; to: string; category?: string };

export const consentKeys = {
  all:     ['consents'] as const,
  lists:   () => [...consentKeys.all, 'list'] as const,
  list:    (f: ConsentFilters) => [...consentKeys.lists(), f] as const,
  details: () => [...consentKeys.all, 'detail'] as const,
  detail:  (id: string) => [...consentKeys.details(), id] as const,
  // Nested under the detail so that one invalidation of `detail(id)` covers the whole consent —
  // body, timeline, access log and pinned notice — without touching other consents.
  events:    (id: string) => [...consentKeys.detail(id), 'events'] as const,
  accessLog: (id: string, w: AccessWindow) => [...consentKeys.detail(id), 'access-log', w] as const,
  notice:    (id: string) => [...consentKeys.detail(id), 'notice'] as const,
} as const;

export const requestKeys = {
  all:    ['consent-requests'] as const,
  lists:  () => [...requestKeys.all, 'list'] as const,
  list:   (f: RequestFilters) => [...requestKeys.lists(), f] as const,
  detail: (id: string) => [...requestKeys.all, 'detail', id] as const,
} as const;

export const dashboardKeys = { all: ['dashboard'] as const } as const;
export const dsarKeys      = { all: ['dsar'] as const, /* list/detail/… */ } as const;
export const approvalKeys  = { all: ['approvals'] as const, /* queue/history/… */ } as const;
export const referenceKeys = { purposes: ['reference', 'purposes'] as const, /* … */ } as const;
export const sessionKeys   = { all: ['auth', 'sessions'] as const } as const;

export const auditKeys = {
  all:  ['audit'] as const,
  list: (f: AuditFilters) => ['audit', 'list', f] as const,
} as const;

export const customerKeys = {
  all:  ['customers'] as const,
  list: (term: string) => ['customers', 'list', term] as const,
} as const;
```

Three rules make the file worth itself:

- **The key contains every input the query function uses.** A filter that changes the response but
  not the key serves the wrong data out of the cache, and it is invisible until someone filters in
  production. That is why `accessLog` takes the window instead of reading it from a store.
- **Hierarchy mirrors containment**, so a prefix invalidation means something and a test can assert a
  prefix rather than a string.
- **A store value may appear in a key only in debounced form.** The search box's raw text is local
  `useState`; the term that reaches `customerKeys.list(term)` is debounced (250 ms, #69), so a
  five-character search creates one cache entry, not five.

#### 3.3 Freshness: the numbers, and the reason for each

| Query family | `staleTime` | Focus refetch | Why this number |
|---|---|---|---|
| Consents, requests, dashboard, DSARs, approvals | 30 s | ✅ | A decision made anywhere — another tab, an agent, the expiry job — changes these. 30 s bounds staleness for a screen being looked at without a request per render; focus covers the background-tab case; §6 makes it sub-second while the stream is up. |
| Consent timeline, access log | 30 s | ✅ | Append-only: it only grows. A refetch is cheap and cannot be wrong, and a stale timeline is the thing the transparency screen exists to prevent. |
| Pinned notice + history | **Infinity** | ➖ | The artefact pins the notice version and its hashes (ADR-0003 §9); those rows cannot change, so a refetch can only return identical bytes. The cache is as immutable as the row. |
| Audit viewer (#73) | 60 s | ❌ | **Because reading is audited** (ADR-0003 §13.2): every `GET /audit` writes an `AUDIT_READ` row, so a focus refetch is a write. A table that reorders under a reader mid-investigation is also worse than staleness; the viewer shows `dataUpdatedAt` and an explicit Refresh. |
| Reference data (purposes, categories, FIUs) | 30 min | ❌ | Changes by migration or onboarding, not by traffic. |

The remaining defaults, stated because they are decisions:

- **No retry on mutations, ever.** A retried `POST /consents/{id}/revoke` is a second revocation
  attempt against the ledger, which is a product decision we do not make by accident.
- **`401` is not a retry.** It is the single-flight silent refresh (ADR-0002 §4), performed once by
  the generated client's mutator; if the refresh fails, the app logs out and clears the cache (#57).
- **`placeholderData: keepPreviousData`** on paged lists (consents, audit, DSAR) so pagination and
  filter changes do not blank the table — #61's "no layout shift between loading and loaded".
- **`refetchInterval: undefined`** everywhere except the polling fallback (§6.5).
- **`throwOnError: false`**, with `Loading` / `Error` / `Empty` rendered from one shared component
  (#56, #58). A route-level error boundary is for bugs, not for 500s.

#### 3.4 Mutations: one hook each, and what a cache entry may contain

- One hook per mutation, colocated with its feature (`useRevokeConsent`, `useApproveRequest`,
  `useDecideApproval`, …), each declaring its invalidation set from §4. No screen calls `useMutation`
  inline with its own `onSuccess`, because that is how two screens come to disagree about what a
  revoke refreshes.
- **A cache entry contains only what the server returned.** The canonical temptation is
  `pendingRevocation: true` on a cached `Consent` so the row can render a spinner. We do not: after
  that line, no type says whether a field came from the API or from a client patch, and §6's "the
  cache is a projection of the ledger" stops being checkable. Pending state is rendered from
  `mutation.isPending` (`useMutationState` for a row-level indicator), keyed by the mutation key
  `['revokeConsent', consentId]`.
- **Queries never write.** No query's `onSuccess` patches another key, and no `useEffect` copies a
  fetch result anywhere. Cache writes belong to mutations (§5.2) and to the stream's reconnect
  resync — nowhere else.

#### 3.5 Exports are commands, not queries

`GET /api/v1/audit/export.csv` (#73) and the DSAR export bundle (#44) are `useMutation`s that hand the
response to `URL.createObjectURL` and revoke the URL immediately after download. They are never
`useQuery`s and never cached: a blob of audit rows or personal data sitting in an in-memory cache
with a five-minute `gcTime` is a retention decision made by a library default, which is not how this
codebase makes them.

### 4. The invalidation contract

A mutation is not finished when the server answers. It is finished when every read model that could
contain the changed fact has been invalidated. The sets are written once, in
`src/api/invalidation.ts`, so "what does revoke invalidate?" is a review of one file:

```ts
// apps/web/src/api/invalidation.ts — read by the mutation hooks and by the tests in §4.4.
export const invalidatedBy = {
  createRequest:  () => [requestKeys.all, dashboardKeys.all],
  approveRequest: () => [requestKeys.all, consentKeys.all, dashboardKeys.all],
  denyRequest:    () => [requestKeys.all, consentKeys.all, dashboardKeys.all],
  revokeConsent:  (id: string) => [consentKeys.lists(), consentKeys.detail(id),
                                   requestKeys.all, dashboardKeys.all],
  pauseConsent:   (id: string) => [consentKeys.lists(), consentKeys.detail(id), dashboardKeys.all],
  resumeConsent:  (id: string) => [consentKeys.lists(), consentKeys.detail(id), dashboardKeys.all],
  raiseDsar:      () => [dsarKeys.all],
  decideApproval: (type: ApprovalTaskType) => [approvalKeys.all, ...targetKeys(type)],
} as const;

// A decision *is* the action it authorises, so its invalidation set is the target's.
function targetKeys(type: ApprovalTaskType): readonly QueryKey[] {
  switch (type) {
    case 'CONSENT_APPROVAL':      return [consentKeys.all, requestKeys.all];
    case 'CONSENT_REINSTATEMENT': return [consentKeys.all];
    case 'ERASURE_EXECUTION':     return [dsarKeys.all, consentKeys.all, auditKeys.all];
    case 'LEDGER_PURGE':          return [auditKeys.all];
  }
}
```

The `ApprovalTaskType` members themselves land with #45; ADR-0003 §14 and §11.3 name
`CONSENT_REINSTATEMENT`, `ERASURE_EXECUTION` and `LEDGER_PURGE`, and the rule above is that this
switch stays exhaustive over whatever #45 declares.

#### 4.1 The table

| Mutation | Ticket | Invalidates | Optimistic |
|---|---|---|---|
| Approve a request | #34, #60 | `requestKeys.all` **(the pending-request list)**, `consentKeys.all` **(the consent list)**, `dashboardKeys.all` | ❌ (§5.5) |
| Deny a request | #35, #60 | `requestKeys.all`, `consentKeys.all`, `dashboardKeys.all` | ❌ (§5.5) |
| Revoke (full or partial) | #38, #62 | `consentKeys.lists()`, `consentKeys.detail(id)` — which carries the **timeline, access log and notice** — `requestKeys.all`, `dashboardKeys.all` | ✅ narrowing (§5.2) |
| Pause | #39 | `consentKeys.lists()`, `consentKeys.detail(id)`, `dashboardKeys.all` | ✅ narrowing |
| Resume | #39 | `consentKeys.lists()`, `consentKeys.detail(id)`, `dashboardKeys.all` | ❌ widening |
| FIU raises a request | #32 | `requestKeys.all`, `dashboardKeys.all` | ❌ |
| DSAR raise / progress / execute | #44, #72 | `dsarKeys.all`; after execution `consentKeys.all` + `auditKeys.all`, because erasure redacts artefacts and writes `DSAR_COMPLETED` (ADR-0003 §10) | ❌ |
| Approval decision | #45, #71 | `approvalKeys.all` plus the target's keys via `targetKeys(type)` | ❌ |
| Bulk DSAR assignment | #72 | `dsarKeys.lists()` | ❌ |
| Logout / principal change | #57 | `queryClient.clear()` — one of the two legal unkeyed operations (§4.3, §7.5) | ➖ |

The issue's floor, restated precisely: **revoke, approve and deny each invalidate the consent list
and the pending-request list.** #58 adds the per-consent children to revoke/pause/resume. Between the
two tickets, the union above is the contract, and any mutation that touches consent state
invalidates both lists.

#### 4.2 Why both lists, and why the dashboard is on every set

- **Both lists, always.** A pending request and the consent it becomes are two projections of one
  state machine. A denial is a decision the customer's history and the audit log both record (#35),
  so the consent-side read models change on a deny too. If approve invalidated only the request
  list, the dashboard would show "no active consents" for up to 30 s to a customer who just granted
  one; if revoke invalidated only the consent list, the review screen could keep offering a decision
  on an artefact that no longer exists. Invalidation costs two `GET`s against bounded lists that are
  usually already mounted; the bugs it removes are the class this product cannot afford.
- **The dashboard aggregate is a third projection** (#77). The BFF's aggregate contains consents,
  counts and pending requests, so a mutation that invalidates the lists but not the aggregate leaves
  the screenshot in the README stale. Rule: **a new read model is added to this table in the same PR
  that adds it**, and #77's own criterion ("cache is invalidated on revoke/approve — no stale consent
  state") is discharged twice: once in the BFF, once here.
- **A decision's target is decided by its type.** `targetKeys` is exhaustive over
  `ApprovalTaskType`, so a new task type is a type error until it is registered — a missing
  invalidation, not a `staleTime` accident. `switch` with no `default` and an unused-variable check is
  the mechanism (the same `never`-checked map §"Consistency with the contract" asks for on statuses).

#### 4.3 What `invalidateQueries` actually does, since these sets rely on it

- **Prefix matching**: `{ queryKey: consentKeys.detail(id) }` matches `[…, 'detail', id, 'events']`
  and `[…, 'detail', id, 'access-log', w]`. That is why §3.2 nests by containment.
- **Active queries refetch; inactive ones are marked stale** and refetched on next mount. A broad
  prefix (`consentKeys.all`) is therefore cheap in practice: a filter view nobody is looking at costs
  nothing until it is opened.
- **`invalidateQueries()` with no key is banned** outside the two documented cases — logout
  (`clear()`) and the post-reconnect resync (§6.4). An unkeyed invalidation is the signature of a
  missing dependency: someone who does not know which key to invalidate reaches for all of them, and
  the review comment should be "name the key", not "performance".

#### 4.4 The test that proves it

The contract is not documentation-only. #58's acceptance criterion is an MSW request-count test;
every row of §4.1 gets the same shape, which makes it the cheapest regression test in the codebase:

```ts
it('revoke refetches the consent list, the consent children and the pending requests', async () => {
  // …render dashboard + detail, open the revoke modal, confirm…
  await waitFor(() => expect(msw.calls('GET /api/v1/consents').count).toBeGreaterThan(1));
  expect(msw.calls('GET /api/v1/consents/:id/events').count).toBeGreaterThan(1);
  expect(msw.calls('GET /api/v1/consents/:id/access-log').count).toBeGreaterThan(1);
  expect(msw.calls('GET /api/v1/consent-requests').count).toBeGreaterThan(1);
});
```

### 5. Optimistic revoke, and its rollback

#### 5.1 Narrowing may be optimistic; widening never is

> **An optimistic patch may only ever reduce what the customer appears to be sharing. Anything that
> grants, restores or extends is applied only after the server has recorded it.**

That makes every possible optimistic state a *lower bound* on the customer's real permissions, on
both the success and the failure path:

- Wrong in the narrowing direction (we showed "revoked" and the server refused): the customer
  believes less is shared than is. Uncomfortable, but it errs toward more privacy, it is reversible,
  and the error sentence says exactly what happened: *"Nothing was revoked — the consent is still
  active."*
- Wrong in the widening direction (we showed "approved" and the server refused): the customer
  believes their data is being shared when it is not — or believes they withheld consent while an FIU
  is fetching. That is the product's core claim, inverted by a UI guess.

So: **revoke ✅, pause ✅** (both narrow); **approve ❌, resume ❌, deny ❌**. Deny is excluded for a
second reason, from #60: the review screen exists to make a decision unambiguous, and a screen that
shows the decision as recorded before the server agrees has told the customer something that may
not be true.

#### 5.2 The hook

```ts
// apps/web/src/features/consents/useRevokeConsent.ts
type Snapshot = Array<[QueryKey, Consent | undefined]>;

export function useRevokeConsent(consentId: string) {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, RevokeBody, { snapshot: Snapshot }>({
    mutationKey: ['revokeConsent', consentId],
    mutationFn: (body) => revokeConsent(consentId, body),
    retry: 0,                                     // §3.3: a retried revoke is a second attempt

    // (1) Stop the responses that would otherwise land on top of the patch, (2) snapshot exactly
    //     what the patch touches, (3) patch by narrowing only.
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: consentKeys.all });
      const snapshot = queryClient.getQueriesData<Consent>({ queryKey: consentKeys.all });

      const revoked = new Set(body.categories ?? []);
      queryClient.setQueriesData<Consent>({ queryKey: consentKeys.all }, (old) =>
        old
          ? { ...old, status: 'REVOKED',
              dataCategories: old.dataCategories.filter((c) => !revoked.has(c)) }
          : old,
      );

      return { snapshot };
    },

    // (4) Roll back first, then classify: no error branch may leave the UI optimistic.
    onError: (error, _body, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);

      if (isVersionConflict(error)) {          // 409 — someone else changed it first
        void queryClient.invalidateQueries({ queryKey: consentKeys.all });
        toast.error('This consent changed in another tab — refresh and try again.');
      } else if (isNotFound(error)) {          // 404 — it is gone; do not resurrect it
        queryClient.removeQueries({ queryKey: consentKeys.detail(consentId) });
        void queryClient.invalidateQueries({ queryKey: consentKeys.lists() });
      } else if (isStepUpRequired(error)) {    // 428 — ADR-0002 §6, the ops-console path
        sessionUi.promptStepUp(() => revokeOnceMore());
      } else {                                 // 5xx, network, anything unexpected
        toast.error('Nothing was revoked — the consent is still active.');
      }
    },

    // (5) The server is the truth after success *and* failure.
    onSettled: () => {
      for (const key of invalidatedBy.revokeConsent(consentId)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
```

What a reviewer should check, because each is a real bug avoided:

1. **`cancelQueries` before the snapshot**, not after. Snapshot-first leaves a window in which an
   in-flight fetch's result is captured as "previous state", and the rollback restores a value that
   was never current.
2. **The snapshot is the pair list from `getQueriesData`**, so rollback restores *every* matching
   entry — all filter variants of the list, the detail, the timeline — not just the one on screen.
3. **Rollback happens before classification**, so an error branch that throws on its way to its own
   `invalidateQueries` cannot leave the UI lying.
4. **`onSettled`, not `onSuccess`.** A failed optimistic mutation is exactly when the cache's
   relationship to the server is least certain.
5. **No retry.** The mutation is not idempotent in the ledger's terms: each attempt appends.
6. **The mutation owns the patch.** `setQueryData` appears in a mutation's `onMutate` and in the
   stream resync (§6.4) — nowhere else. Never in an event handler, never in a `useEffect`, never in
   the SSE callback.

#### 5.3 Partial revocation

Partial revoke (choose categories to keep, revoke the rest — #62) is where the client must resist
inventing state:

- The patch removes the revoked category codes from `dataCategories` and sets `status: 'REVOKED'`
  where the REVOKED status applies to the artefact. That is a truthful lower bound: the FIU will not
  be able to fetch those categories.
- The patch does **not** invent the successor artefact that ADR-0003 §8's lineage rule produces. Its
  id comes from the server; a fabricated id would leak into `consentKeys.detail(id)`, into the URL
  and into the timeline's next fetch. The successor arrives through §4.1's invalidation, normally
  within one round trip.
- If the response *does* return the successor, the hook may seed that one detail key —
  `setQueryData(consentKeys.detail(successor.id), successor)`. A mutation response is authoritative
  for the entity it names and nothing else; lists still come from invalidation, because the
  successor's position in a filtered, sorted list is the server's business.
- The confirmation dialog (#62) states what is being revoked, in categories, before any of this
  runs. Optimism starts after the customer confirms; the dialog itself is never optimistic.

#### 5.4 Four failures, four behaviours, four sentences

| Server answer | Meaning | Client behaviour | What the user is told |
|---|---|---|---|
| `409` + `Problem` | `@Version` conflict: the consent changed elsewhere (ADR-0003 §8.1, #62) | Roll back, invalidate the consent, no retry | "This consent changed in another tab — refresh and try again." |
| `404` | The artefact is gone | Roll back, `removeQueries` the detail, invalidate the list | "That consent no longer exists." |
| `428` | Step-up re-authentication required (ADR-0002 §6) | Roll back, prompt, retry the *same* mutation exactly once | Password prompt, no error banner |
| `5xx` / network | Unknown: the server may or may not have applied it | Roll back, invalidate, no auto-retry | "Nothing was revoked — the consent is still active." |

#### 5.5 Approve and deny are pessimistic, and the screen says so

On the review screen (#60), the pending state *is* the message: the button disables with a spinner,
the card stays put, and only the server's `200` triggers navigation and §4.1's invalidation. On
failure the error renders where the button was, with the request still open — not a toast that
disappears while the customer wonders whether they just approved something. #60's "rollback on
failure" is therefore the simplest possible implementation: the pending indicator clears and the card
returns to its undecided state, because nothing was written optimistically in the first place. #60
says it in one line — "optimistic-free (approval is not optimistic — it must not lie about consent
state)" — and §5.1 is why.

#### 5.6 The residual window, stated honestly

An optimistic patch lives in the cache for one round trip. Anything that refetches the same key
inside that window can replace the patch with pre-mutation data, and the revocation visually
"undoes" until `onSettled` invalidates. Two cheap mitigations:

- `cancelQueries` (§5.2 step 1) removes the in-flight case, which is the common one.
- The polling fallback (§6.5) is gated on `!queryClient.isMutating()`, because polling is the only
  other background refetch that can land inside the window.

The principled alternative — keeping optimistic intent outside the cache entirely and rendering it
with `useMutationState`, so the cache stays a pure projection — is recorded as the growth path. It
removes the window but makes every read merge "cache value" with "pending overlay"; with §5.1's
narrowing rule the merged result stays easy to reason about, so we defer it until a second optimistic
flow exists.

### 6. The stream is an invalidation hint, never a data source

The BFF emits server-sent events for consent changes (#78). The decision:

> **An event maps to a query key and calls `invalidateQueries`. It does not write a value into the
> cache — not even when the payload contains the new state.** (#78's task list already names this
expectation; this section records why it is the only safe design.)

#### 6.1 Why, in four failure modes a cache write cannot survive

1. **A missed event leaves a confident lie.** SSE delivery across a reconnect gap is at-most-once; a
   write-from-stream client that misses `CONSENT_REVOKED` has no mechanism that will ever correct it,
   because nothing else refreshes that cache entry. A missed *invalidation* is repaired by the next
   focus refetch, the next mount, or the post-reconnect resync. Invalidation is self-healing; a write
   is not.
2. **The stream would become a second representation of the ledger.** ADR-0003 §13.1 kept
   `data_access_log` as its own table rather than a projection of `consent_event` precisely because a
   projection that renders without re-reading the record is a projection that can disagree with it. A
   client cache written from an event stream is that projection, with no test comparing it to
   anything.
3. **The payload is a summary; the screens need the row.** Rendering a revocation from the event
   means implementing the state machine's rendering twice — once from the artefact, once from the
   envelope — and the two diverge the first time a field is added.
4. **Authorisation is per-read, not per-event.** A session can lose the right to see an entity between
   emission and render (role change, token-family revocation, erasure — ADR-0002 §5, ADR-0003 §10).
   An invalidation re-reads under the caller's *current* authority and gets a truthful 403/404; a
   cache write injects data the caller may no longer be allowed to see.

#### 6.2 The envelope: ids, codes and a timestamp

```ts
// The BFF's event envelope (#78). ADR-0003 §3's discipline — no prose, no names, no payloads —
// applied to the wire, because a stream is a network log line and a devtools artefact too.
type StreamHint = {
  id: string;                          // monotonic per connection; echoed as Last-Event-ID
  type: 'CONSENT_APPROVED' | 'CONSENT_DENIED' | 'CONSENT_PAUSED' | 'CONSENT_RESUMED'
      | 'CONSENT_REVOKED' | 'CONSENT_EXPIRED' | 'DATA_ACCESSED' | 'NOTIFIED';
  consentId: string;
  occurredAt: string;                  // ISO-8601, UTC
};
```

The vocabulary is ADR-0003 §4's, so the stream and the ledger speak one language and a new event type
is added to both in one PR. No category lists, no FIU names, no amounts: the client's next `GET`
fetches those — authorised — from the ledger's read path.

#### 6.3 The transport: `fetch`, not `EventSource`

`EventSource` is the natural API and cannot be used here: it cannot set headers, so it cannot send
`Authorization: Bearer`, and the refresh cookie cannot stand in for it because its `Path` is
`/api/v1/auth/refresh` (ADR-0002 §3) — the browser never attaches it to `/events`. Putting a token in
the query string is rejected outright: it lands in proxy logs, browser history and referers, which is
the exfiltration path ADR-0002 §8 exists to close.

So the client is `fetch` + `ReadableStream` with an explicit reader, and the reconnection that
`EventSource` would have given us becomes our code:

- **Reconnect with backoff and jitter** (1 s → 30 s, ±20%), sending `Last-Event-ID`. The BFF replays
  from a bounded ring buffer; if the id has fallen out of the buffer the stream is closed and the
  client resyncs (§6.4) instead of pretending it caught up.
- **Reconnect at token renewal.** The access token lives 300 s (ADR-0002 §1) while a healthy stream
  lives for hours. The stream reconnects with a fresh token on a timer slightly shorter than the TTL,
  and on `401` it goes through the single-flight refresh and reconnects.
- **Heartbeats** every 15 s (`: keepalive` comment frames) so intermediaries do not close an idle
  connection; `Content-Type: text/event-stream`, `Cache-Control: no-store` on the BFF side.
- **Same-origin relative URL** (`/events`, proxied in dev per #56), so there is no credentialed
  cross-origin stream and no preflight.
- **One connection per tab**, with jittered reconnect so N tabs do not reconnect in lockstep. If
  #78's documented connection budget is ever exceeded, leader election over the existing
  `BroadcastChannel` (ADR-0002 §4) is the next step — recorded as the growth path, not built now.
- No `localhost` and no absolute API host (#56): the BFF is reached through the dev proxy with a
  relative URL, which is also what makes the hosted preview work.

#### 6.4 The handler, coalescing, and the reconnect resync

```ts
// apps/web/src/api/stream.ts — module scope, like the token (ADR-0002 §2).
const HINT_TARGETS: Record<StreamHint['type'], readonly QueryKey[]> = {
  CONSENT_APPROVED: [consentKeys.all, requestKeys.all, dashboardKeys.all],
  CONSENT_DENIED:   [consentKeys.all, requestKeys.all, dashboardKeys.all],
  CONSENT_PAUSED:   [consentKeys.all, dashboardKeys.all],
  CONSENT_RESUMED:  [consentKeys.all, dashboardKeys.all],
  CONSENT_REVOKED:  [consentKeys.all, requestKeys.all, dashboardKeys.all],
  CONSENT_EXPIRED:  [consentKeys.all, dashboardKeys.all],
  DATA_ACCESSED:    [consentKeys.all],   // nested: timeline + access log (§3.2)
  NOTIFIED:         [consentKeys.all],
};

// A burst (one approval writes several ledger rows) must not become a refetch storm: at most one
// invalidation per key per 250 ms, trailing edge. The coalescer lives here, not in components.
export function onHint(hint: StreamHint) {
  for (const key of HINT_TARGETS[hint.type]) {
    coalesce(key, () => queryClient.invalidateQueries({ queryKey: key }));
  }
}

// The other legal unkeyed invalidation (§4.3): events that arrived while we were disconnected are
// unknowable, so a reconnect is a resync point for everything on screen.
export function onStreamOpen() {
  void queryClient.invalidateQueries();
  useStreamStatus.getState().set('live');
}
```

Three assertions a reviewer can make about this file: it imports no rendering code; it never calls
`setQueryData`; and every branch of the envelope lands on a key from `keys.ts`. #78's acceptance
test — "revoking a consent in another tab updates the open dashboard within a second" — is satisfied
by *the refetch this triggers*, and the test asserts the refetch (MSW request count), not a cache
value. That is the difference between testing the mechanism and testing a coincidence.

#### 6.5 Fallback polling, and the badge that says so

If the stream cannot connect (two failed attempts inside 10 s), the client degrades to polling:
`refetchInterval: 30_000` on the consent-bearing queries, `refetchIntervalInBackground: false`, and
the shell badge changes from **Live** to **Polling** — because a customer looking at a transparency
screen deserves to know whether it is live or a minute old. The polling gate
`streamStatus === 'polling' && !isMutating` (§5.6) is part of the contract, not an optimisation. The
stream is never assumed: §4 must be true with the stream down, which is exactly why the invalidation
table exists independently of this section.

#### 6.6 Cross-tab

The `BroadcastChannel` that coordinates refresh (ADR-0002 §4) also carries hints between tabs of the
same origin, so an approval in tab A does not leave tab B's queue stale until focus. The receiving
tab **invalidates** — the channel is another transport for hints, and the rule is the same: a
cross-tab message is a reason to re-read, never a value to store. Logout broadcasts too (§7.5).

### 7. Zustand: the stores, and their limits

Zustand is not a small Redux. It is a hook-shaped store with no provider and no actions/reducers
duality, and — the reason it wins here — `getState()` is callable from non-React code, which is what
lets the query error handler raise a toast and the stream client publish a status without threading a
context through the app.

#### 7.1 The inventory

| Store | State | Reset on | Persisted |
|---|---|---|---|
| `useApprovalDraft` | `requestId`, `step`, `toggles`, `expiresAt`, `denyReason` | Route change, different `requestId`, successful decision, logout | ❌ |
| `usePanelState` | open panel, per-panel uncommitted values | Route change, Apply/Cancel, logout | ❌ |
| `useSelection` | `selectedIds: Set<string>` for bulk actions | Route change, after the bulk mutation, logout | ❌ |
| `useToasts` | queue of `{ id, kind, message }` | per-toast TTL, logout | ❌ |
| `useStreamStatus` | `connecting` / `live` / `polling` / `offline` | logout | ❌ |
| `useSessionUi` | idle warning dismissed, step-up prompt open | successful re-auth, logout | ❌ |
| `useAccessReasonDraft` | the ops console's reason-for-access text | submit, route change, logout | ❌ |
| `usePrefs` | `theme`, `density`, `reducedMotion`, `tablePageSize` | never (a device preference) | ✅ allowlist (§7.5) |

`resetClientState()` calls `reset()` on every store; it is called from the logout path and from
nowhere else.

#### 7.2 The approval draft, keyed by its subject

```ts
// apps/web/src/state/approvalDraft.ts
type ApprovalDraft = {
  requestId: string | null;              // the server id this draft belongs to
  step: 1 | 2 | 3;
  toggles: Record<string, boolean>;      // category code → included
  expiresAt: string | null;              // the date the customer picked
  denyReason: string;
  start: (requestId: string) => void;    // resets everything when the id changes
  setToggle: (code: string, on: boolean) => void;
  setExpiry: (iso: string | null) => void;
  setDenyReason: (text: string) => void;
  reset: () => void;
};

export const useApprovalDraft = create<ApprovalDraft>()((set, get) => ({
  requestId: null,
  step: 1,
  toggles: {},
  expiresAt: null,
  denyReason: '',
  start: (requestId) => {
    if (get().requestId === requestId) return;      // same subject: keep the draft
    set({ requestId, step: 1, toggles: {}, expiresAt: null, denyReason: '' });
  },
  // setToggle / setExpiry / setDenyReason / reset omitted
}));
```

Three properties this shape buys, all testable in #58/#60:

- **The draft is the delta the customer is composing; the subject is server state.** The FIU's name,
  the purpose, the notice text, the category *labels* and the current expiry all come from
  `usePendingRequest(id)` and `consentKeys.notice(id)`. The store holds only what the customer has
  decided. That is why a stale store can never show the wrong FIU.
- **`start(requestId)` is idempotent per subject**, so moving between two pending requests cannot
  leak one customer's toggle choices into another's approval — the bug a single global `toggles: {}`
  produces on the second request.
- **Route-change reset is explicit** (#58's "the wizard draft does not survive a route change
  unintentionally"): the review screen calls `start(id)` on mount and `reset()` on unmount, and a test
  navigates away and back and asserts an empty draft.

#### 7.3 `useState` or Zustand? The tie-breaker

> **Zustand when two components that are not parent and child render the value, or when it must
> outlive the component that owns it. Otherwise `useState`.**

That is why the sidebar's collapsed flag is a store (the header and the nav both render it) and why a
dialog's open flag is `useState` (only the trigger and the dialog's subtree care). And why the
access-log panel's *draft* is a store: the panel's Apply button is in a footer that is a sibling of
the panel, and the "2 filters applied" badge is in the header — three consumers, one value. A store
with one consumer is a review comment: "why not `useState`?"

Corollary for selectors: subscribe to the narrowest slice
(`useApprovalDraft((s) => s.toggles[code])`) and use `useShallow` when the selector returns an object
or array. A selector that returns a fresh object on every render re-renders its subscriber on every
store write — the one Zustand footgun that shows up as jank rather than as an error.

#### 7.4 What a store may never hold

- **Server entities.** No `Consent`, `ConsentRequest`, `DataAccessLog` or generated API type in any
  store — only ids, codes, booleans, numbers and the user's own input. Enforced by the boundary test
  in §8, not by review alone.
- **Credentials and authorisation claims.** `roles`, `customerId`, the access token: module scope
  (ADR-0002 §2). A role list in a store is a stale-authority bug and an XSS target.
- **Personal data that is not the current user's own input.** An agent's "recent customers" list, a
  cached customer name in a filter panel, a pasted account number: all forbidden. Personal data in
  the browser is a retention decision, and §7.5 names the only two places it may exist — the Query
  cache (bounded by `gcTime`, cleared on logout) and the user's in-progress input (never persisted).
- **Derived values.** `canRevoke`, `allTogglesOff`, `pendingCount` are selectors over the store's
  inputs and the cache — never stored (§2.5).

#### 7.5 Persistence allowlist, and logout

```ts
// Only these four keys, only in usePrefs, only through an explicit partialize.
persist(createPrefsStore(), {
  name: 'ch.prefs.v1',
  partialize: (s) => ({ theme: s.theme, density: s.density,
                        reducedMotion: s.reducedMotion, tablePageSize: s.tablePageSize }),
});
```

- **No `persistQueryClient`.** It is a convenient, well-documented library feature and it is rejected
  with the same argument ADR-0002 §8 makes about `localStorage`: it writes personal data to disk, it
  survives logout, and any script on the origin can read it. The Query cache is in-memory only, and
  `gcTime` (§3.1) is the retention clock for the one copy that does exist.
- **No draft persistence.** An approval draft is a decision about somebody's data; a reload losing it
  is the correct outcome.
- **Filters with identifiers go to the URL, not to storage.** `?customerId=…` in the address bar is
  the user's own deliberate action; the same value in `localStorage` is an undeclared retention.
- **Logout** (ADR-0002 §5 step 4, extended here): cancel outstanding queries, clear the in-memory
  token, `queryClient.clear()`, `resetClientState()`, broadcast the logout on the `BroadcastChannel`,
  redirect to `/login` with the intended destination preserved. A principal *change* (logging in as
  somebody else in the same tab) runs the same sequence, so no entry from the previous principal can
  be observed by the next one.

### 8. How the boundary is enforced: tests, not prose

ADR-0003's ledger is append-only because a grant and a test say so. The frontend equivalent is
cheaper but the same in kind — the rules above are asserted in the suite, and one of them is a
negative control (ADR-0003 §6.3's pattern):

1. **Boundary test** (`src/state/stateBoundary.test.ts`): no file under `src/state/**` imports from
   `src/api/**`, the generated client or `@tanstack/react-query`; no store's exported types reference
   a generated API entity; no file outside `src/api/**` contains a query-key array literal. A fixture
   with a deliberate violation is scanned alongside, so the test proves it bites instead of asserting
   an empty set forever.
2. **Invalidation tests** (§4.4): MSW request counts, one case per row of §4.1.
3. **Draft-isolation tests**: a route change clears the draft (#58); switching `requestId` starts a
   fresh draft (§7.2).
4. **Optimism tests**: #62's "shows revoked immediately and rolls back on a 500", the 409 conflict
   sentence, plus the inverse assertion that an approve mutation performs *no* cache write before its
   response resolves (§5.5).
5. **No-persistence test** (#57's `localStorage.length === 0` assertion, extended): after a logout,
   `localStorage` contains exactly the `ch.prefs.v1` key and no string from the seeded customer's
   data.
6. **Audit-viewer test**: focusing the window on `/audit` issues no request (§3.3), because that
   request would write a ledger row.

### 9. "Where does this go?" — worked examples

| The state | Home | The rule that decides it |
|---|---|---|
| Which tab of the consent detail screen is open | URL (`/consents/:id?tab=access`) | Q2 — a link should restore it |
| Which categories the customer has toggled in the review wizard | `useApprovalDraft` | Q3 — the summary footer renders it |
| The FIU's legal name and the notice text for that request | `requestKeys.detail(id)` | Q1 — the server owns it |
| Whether the revoke button is disabled while in flight | `mutation.isPending` | Not state at all: the mutation's own status |
| The number of pending requests in the nav badge | Derived from `requestKeys` | §2.5 — derived values are never stored |
| The date range typed into the access-log filter but not applied | `usePanelState` (or `useState` if the panel owns it) | Q3 |
| The date range that *is* applied | URL | Q2 — #63 asserts the query params |
| The sidebar collapsed flag | `usePrefs` (persisted) | Q3 + §7.5 |
| The access token | Module scope | Not renderable state; a credential (ADR-0002 §2) |
| Which consent rows are ticked for bulk assignment | `useSelection` | Q3 — the toolbar and the table both read it |
| When the dashboard data was last fetched | `dataUpdatedAt` on the query | §2.5 — already exists |
| The banner shown after a failed revoke | `useToasts` | Raised from non-React code (the mutation cache handler) |
| The DSAR SLA countdown | Server `dueAt` + a ticking clock | §2.5 — store the anchor, derive the ticks |
| The agent's reason for looking at a customer | `useAccessReasonDraft` until submitted; the ledger afterwards | Q1 + Q3: the user's input is client state, the recorded reason is a server fact (ADR-0003 §13.2) |

### 10. What this costs

- **Two places to look, one rule to know.** A developer who has not internalised §1 will try to put a
  fetched list in a store "because it is already there". The boundary test catches the mechanical
  case; the review question — "who can change this value?" — catches the rest.
- **Invalidation discipline is real work.** Every new mutation and read model is a row in §4.1, and a
  missed row is a stale screen no type checker will find. The MSW count tests are the mitigation, at
  roughly ten minutes per feature.
- **Optimism adds a code path that only runs on failure** — precisely the path nobody exercises by
  hand. Hence #62's 500 and 409 cases being acceptance criteria rather than suggestions.
- **The stream is more client code than `new EventSource(url)`.** §6.3's reconnect logic exists
  *because* of ADR-0002's token model; that is ~100 lines bought with the auth guarantees.
- **`staleTime: 30 s` is a guess, written down so it can be argued with.** The alternative — leaving
  it to each screen — is how two screens end up with different definitions of "current".

## Consequences

**Positive**

- **The stale-consent class of bug is designed out.** There is one copy of every server fact, owned
  by a library whose job is invalidation, and §4.1 enumerates what each mutation must refresh.
- **The UI cannot overstate consent.** Approve and resume are pessimistic, optimistic patches may
  only narrow, and the failure sentence for a failed revoke is "the consent is still active" (§5.4).
- **Every screen's state has a named home**, so "where does this go?" has an answer that does not
  depend on who is in the room (§2, §9), and the answer is testable rather than stylistic.
- **Freshness is expressed in the product's terms.** The audit viewer refetches less because reading
  is audited (ADR-0003 §13.2); the notice never refetches because the pin is immutable (ADR-0003 §9).
  Two ADRs reinforce each other instead of contradicting.
- **The stream is a latency optimisation, not a dependency.** Because it only invalidates, the app is
  correct with the stream down — which is what makes #78's polling fallback cheap and its
  "within a second" criterion assertable as a refetch.
- **Testability falls out of the design.** Request counts, cache state and store resets are all
  assertable with MSW and RTL; "the cache is coherent" never has to be.

**Costs / trade-offs**

- **Two libraries, two mental models, one rule to keep.** Accepted: the alternative is one library
  and two mental models, where the cache and the store both claim to own a value.
- **`gcTime` and `staleTime` are retention and freshness decisions living in a config object.** They
  are one function (§3.1), so a change is reviewable, and the review question is "what does this mean
  for a customer looking at their data?", not "is it fast".
- **The invalidation table is maintained by hand.** It is ten lines, it is not generated from
  anything, and it is the most valuable ten lines in the frontend.
- **Zustand's flexibility is also its failure mode** — a store can hold anything, including a
  `Consent`. §7.4 and §8 are the wall, and they are thinner than ADR-0003's grant: a lint test, not a
  database privilege.
- **The "live" feeling depends on the BFF's stream being up.** The fallback is honest rather than
  seamless (§6.5): the badge says "Polling", and a 30 s poll is more latency than a demo wants.

## Alternatives considered

### Redux Toolkit (+ RTK Query) — rejected

The default answer, and the one this JD bullet is usually probing for. It would work. It loses here
for three specific reasons and one honest one:

1. **Server-state duplication is structural, not accidental.** Redux's centre of gravity is one
   serialisable store every feature contributes to. In that model the consent list is naturally a
   slice — and RTK Query's cache is *also* holding it, so the same fact exists twice, with the slice
   usually winning because it is easier to read from. The rule this ADR exists to state ("no server
   data in a client store") is exactly the rule a Redux organisation erodes: the store is already
   there, and `consentsSlice.ts` is one file away.
2. **Cache invalidation becomes hand-written string bookkeeping.** RTK Query models it with
   `providesTags` / `invalidatesTags`: coarse tag lists that must be re-derived for every read model.
   Our dependencies are a tree — consent → detail → timeline → access log → notice → dashboard
   aggregate → pending requests — and TanStack Query expresses it directly as key prefixes (§4.3).
   With tags, "revoke invalidates the consent, its timeline, its access log, the list, the request
   list and the BFF aggregate" is a set of strings that must be kept in sync with the keys they stand
   for; with keys, the invalidation *is* the key, and §8's boundary test can prove keys stay in one
   file.
3. **Its best ergonomics are for the thing we do least.** `onQueryStarted` + `patchResult.undo()` is
   genuinely good, and we need optimism exactly once (§5.2). TanStack Query's `cancelQueries`,
   `getQueriesData`/`setQueriesData` and returned `context` make that a nine-line snapshot and a
   four-line rollback; Redux adds `configureStore`, slices, `extraReducers` glue and an Immer reducer
   style for state that, per this ADR, is mostly not Redux's business.
4. **Honest loss: DevTools.** Redux's time-travel debugger is the best in the ecosystem. We trade it
   for Query Devtools (cache and invalidation visibility — what actually needs debugging here) and
   Zustand's `devtools` middleware (a per-store action log). For this app's failure modes, stale cache
   and a wrong invalidation, the Query devtools are the better instrument.

**RTK Query alone** (no hand-written slices) is the strongest version of this alternative and is worth
naming: it fixes (1) and much of (2). It still loses on §3.2, §3.5 and §6 — a typed,
contract-derived key factory; a `QueryClient` that non-React code (the stream client, the logout path)
can drive; and a key-prefix model the stream's hint map reuses directly instead of translating into
tags.

### Everything in Zustand (fetch in a `useEffect`, store the result) — rejected

The smallest dependency count and the fastest first screen. It is a hand-written cache, which means
hand-written deduplication, cancellation, retry, refetch-on-focus, refetch-on-reconnect, staleness
and invalidation — the last of which is the one that bites, because a missing invalidation is
invisible until a customer is shown a consent that is not theirs to give. It is the opening failure
mode of this ADR, at scale.

### Everything in Query (UI state in the query cache) — rejected

`useQuery({ queryKey: ['wizard'], queryFn: () => null })` or `setQueryData(['ui'], …)` is a real
pattern and it works in a demo. It loses because the cache's lifetime policy is wrong for UI state
(`gcTime` silently drops a half-completed draft; any overlapping prefix invalidation wipes it), the
invalidation contract stops being checkable once keys no longer mean "a server resource", and a draft
that looks like cached server data will eventually be persisted, logged or serialised by someone who
reasonably assumed it was one.

### Context + `useReducer` for all UI state — rejected

Zero dependencies and it satisfies "two components, one value". It loses on the two places that
matter here: non-React code cannot reach a reducer (the `QueryCache` error handler cannot raise a
toast, the stream client cannot publish a status), and every consumer of any context re-renders on
every dispatch unless the app is split into a provider tree that is more code than the stores it
replaces. Zustand is the same idea with an escape hatch and selector-level subscriptions.

### SWR — rejected

Smaller, and its `mutate`-based invalidation is pleasant. It loses on the structural requirement:
there is no key hierarchy to invalidate by prefix (§3.2), no `cancelQueries` to close the optimistic
race (§5.2), no `QueryClient` for the stream and logout paths to drive, and `useMutation` is
comparatively thin for §5.4's four-branch failure handling. Choosing it would mean re-implementing
TanStack Query's key model on top of it.

### `persistQueryClient` / hydrating the cache from `localStorage` — rejected

Instant first paint on a reload, and the same reason ADR-0002 §8 rejects a stored token: it writes
personal data to disk, survives logout and is readable by any script on the origin. The boot cost we
accept instead is one silent refresh and one loading state (#57).

### Optimistic everywhere, approve included — rejected

The demo would feel faster and the failure mode is the one §5.1 exists to prevent: a customer told
their data is being shared, or their consent withheld, on the strength of a client guess. The
asymmetry — narrow optimistically, widen only on the server's word — is the cheapest possible version
of "the UI never claims consent the ledger has not recorded".

### Writing SSE events into the cache — rejected

Explicitly rehearsed in §6.1: a missed event under a write-from-stream client is *permanent*
wrongness, the envelope is a summary that would have to be rendered by a second implementation of the
state machine, and it bypasses the per-read authorisation that the invalidation path re-applies.
#78 mandates the invalidation path; this ADR records why.

### XState for the approval wizard — deferred, not rejected

The wizard has three steps and a handful of guards; Zustand plus a discriminated union of step types
is enough today. If the decision flow grows a second dimension (per-category expiry, a supervisor
branch, resumable drafts), XState becomes the better tool and the draft store is the only thing that
changes — the server-state half of this ADR is unaffected, which is the point of the boundary.

### A shared `packages/state` across both apps — rejected for now

The two apps share shapes but not screens: the portal approves as a customer, the console decides on
someone's behalf, and their stores differ (`useAccessReasonDraft` exists only in the console). What
they must share — the query-key vocabulary and the freshness policy — is small enough to be
duplicated deliberately and kept honest by the contract that generates both clients (#26, #58). If
the key factories ever diverge, the fix is a shared package, not a shared store.

## Consistency with the contract

The contract is `contract/openapi/consenthub-api.yaml` (ADR-0001, drafted in full by #26). Today it
carries `/auth/login`, `/auth/refresh`, `/auth/logout`, `/consents` and `/consents/{id}`, so most of
§2.1's keys name endpoints that land with #26 — the key factory is written against the generated
types, so #26's additions extend it rather than invalidate it.

| ADR clause | Contract element | Status |
|---|---|---|
| §3.2 keys are derived from generated types | the generated `operations` types (#58) | lands with #26/#58 |
| §4.1 invalidation targets | `/consents`, `/consents/{id}`, `/consents/{id}/events`, `/consents/{id}/access-log`, `/consents/{id}/revoke`, `/consent-requests`, `/consent-requests/{id}/approve` and `/deny`, `/dsar`, `/approvals`, `/audit` | lands with #26 |
| §3.5 exports are mutations | `/audit/export.csv`, the DSAR export bundle | lands with #26/#46 |
| §6 the stream | the BFF's `/events` (#78) — not part of the backend contract, and therefore not reachable from the generated client; it has its own envelope (§6.2) | lands with #78 |
| §7.5 logout clears everything | `POST /auth/logout` (in the contract now) + the SPA-side reset | in the contract; the client half lands with #57 |

One contract disagreement is *already on record* and this ADR adds the frontend consequence: the
contract's `Consent.status` enum is `granted | revoked | expired`, while #17/#31, ADR-0003 §8 and the
state machine it describes have `PENDING | ACTIVE | PAUSED | REVOKED | EXPIRED`. The frontend must not
paper over that with a fallback badge. The status → label/token map (#59) is a **total record with a
`never`-checked default branch**, so the day #26 fixes the enum the build fails *at the map* until
every new state has a rendered treatment — rather than rendering an unstyled pill for `PAUSED` in
production. In the meantime the map renders the three states the contract knows and `tsc` is the
reminder about the other two.

## Ticket contract — how this lands in week 3

This ADR is decision-complete on purpose: the implementing tickets are transcriptions, not decisions.
Each row states what the ticket must contain *and the check that proves it*.

| Ticket | Must contain, from this ADR | The check that proves it |
|---|---|---|
| **#26** contract | the full v1 surface the keys name (§2.1), and the `Consent.status` enum aligned to #17/#31 (§"Consistency with the contract") | #26's own "every operation has a summary, an example and a declared role"; the status map's `never` branch compiling against the fixed enum |
| **#54** LESS tokens | `packages/*` added to `pnpm-workspace.yaml` when `packages/ui` lands; no state implications | `pnpm build` compiles LESS → CSS; #54's grep for raw hex |
| **#56** shell + routing | `QueryClientProvider` mounted once above the router; route params and search params as the source of shareable state (§2.2); loading/error/empty as shared components | #56's "protected route redirects and returns"; a test that `?q=` survives reload and back |
| **#57** login / refresh / logout | in-memory token, single-flight refresh, no blind retry; logout = §7.5's full reset | #57's four tests, plus the extended `localStorage` assertion in §8 |
| **#58** typed client + wiring | `keys.ts`, `invalidation.ts`, `createQueryClient()`, one hook per mutation, the stores of §7.1, the stream client of §6.3–§6.4 | the MSW request-count test (§4.4), the draft-reset test, the boundary test with its violation fixture (§8) |
| **#59** component library | components take value/onChange props and import neither Query nor Zustand; the status → label/token map with the `never` default | #59's RTL tests; the boundary test's "no `@tanstack/react-query` in `packages/ui`" case |
| **#60** pending review | `useApprovalDraft` keyed by `requestId`; approve and deny are pessimistic with the pending indicator on the button (§5.5) | #60's RTL tests + §8's "approve performs no cache write before the response" |
| **#61** dashboard | consents from `consentKeys.list(filters)`, filters/sort/search in the URL, no derived counts in a store | #61's filter-composition tests; §8's invalidation count tests for pause/resume |
| **#62** revoke | §5.2's hook verbatim, §5.3's partial-revoke rule, §5.4's four sentences, the modal's focus management | #62's "shows revoked immediately and rolls back on a 500" and the 409 sentence |
| **#63** access log | `consentKeys.accessLog(id, window)`, window and category in the URL | #63's "date-range filter issues the right query params" |
| **#64** notice viewer | `consentKeys.notice(id)` with `staleTime: Infinity`; the pinned version is the rendered one | #64's "old consent shows the version in force at approval" + the XSS test |
| **#65** test harness | `createQueryClient({ retry: false })` in the render helper; MSW handlers generated from the contract | coverage gate; §4.4's count tests running in the suite |
| **#69** ops shell + search | debounced `customerKeys.list(term)`; reason-for-access draft in a store, the ledger row is the server's | #69's "returns seeded customers within a debounce"; its audit-event assertion |
| **#71** approvals queue | `decideApproval` → `targetKeys(type)`; nav badge derived from `approvalKeys`; decision note in a store, mandatory | #71's three tests; a count test that a decision refetches the target's keys |
| **#72** DSAR queue | countdown derived from `dueAt` + a clock; `?status=&breachedOnly=` in the URL; `useSelection` cleared after bulk assignment | #72's fake-timer countdown test; #72's "agent cannot execute an erasure" |
| **#73** audit viewer | `auditKeys.list(filters)` with `refetchOnWindowFocus: false`; filters in the URL; CSV export as a mutation (§3.5); "your access is recorded" copy | #73's filter/export tests; §8's "focus issues no request" case |
| **#77** BFF aggregate | `dashboardKeys.all` as a read model, added to §4.1 in the PR that adds it; the BFF's own cache invalidated on revoke/approve | #77's "single request" and "cache invalidated on revoke/approve" tests |
| **#78** SSE | §6 in full: envelope, fetch-based client, hint → invalidation, coalescing, resync, polling fallback and badge | #78's "revoking in another tab updates the dashboard within a second", asserted as a refetch |

## References

- ADR-0001 — the contract is a root-level artifact consumed by both halves; the generated client is
  not hand-written.
- ADR-0002 — §1 token TTLs, §2 the token in module scope, §3 the `Path`-scoped refresh cookie, §4
  rotation with single-flight refresh and `BroadcastChannel`, §5 logout (extended by §7.5 here), §6
  step-up and the console's idle policy, §8 why nothing is written to `localStorage`. **Amended by
  this ADR:** the logout step's "clears the TanStack Query cache" now reads as the full client-side
  reset in §7.5, and its reference to ADR-0004 names the split.
- ADR-0003 — §3 (ledger discipline the stream envelope copies), §4 (the event vocabulary the hint
  types reuse), §8 (the `@Version` the 409 path explains), §9 (the immutable pin behind
  `staleTime: Infinity`), §10 (erasure, which invalidates consents and audit), §12.2 (no state change
  without its row — the reason the stream may not be written into the cache), §13.1–§13.2 (the
  access-log read model and audited reads).
- `contract/openapi/consenthub-api.yaml` — the source of both generated clients: `openapi-typescript`
  plus a thin fetch wrapper for the SPAs (#58), orval for the BFF (ADR-0001); the status-enum drift is
  recorded above.
- Week 3–4 tickets: #54–#65 (portal and design system), #69–#73 (ops console), #77–#78 (BFF
  aggregation and the SSE stream), with #26 (contract) and #44–#46, #32–#42 (the endpoints the keys
  name) behind them.
- TanStack Query v5 documentation — `invalidateQueries` prefix semantics, `cancelQueries`,
  `getQueriesData`/`setQueriesData`, `useMutationState`, `keepPreviousData`.
- Zustand documentation — `create`, `persist` with `partialize`, `useShallow`, `devtools`.
- MDN — `Server-sent events`, `ReadableStream`, `BroadcastChannel`; the `EventSource` header
  limitation is the reason §6.3 exists.
