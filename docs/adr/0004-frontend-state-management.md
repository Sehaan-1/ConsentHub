# ADR-0004: Frontend state management split

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** ConsentHub engineering
- **Tags:** frontend, state-management, caching, tanstack-query, zustand, sse, testing

## Context

Two React SPAs consume the same API: the customer portal (`apps/web`, role `CUSTOMER`) and the ops
console (`apps/portal`, roles `AGENT`/`SUPERVISOR`/`ADMIN`). Both are built in week 3–4 (#56–#73)
against generated types from `contract/openapi/consenthub-api.yaml` (ADR-0001), both authenticate
with an in-memory bearer token (ADR-0002), and both display data whose authority is the append-only
ledger (ADR-0003). Every screen in both apps is a projection of rows that some **other** actor can
change while the screen is open: an FIU raises a request, an expiry job flips a consent to
`EXPIRED`, a second tab revokes, a supervisor approves somebody else's paperwork, an agent searches
for a customer and that search is itself written to the ledger.

That is the whole of the problem. The plan's one-liner is "caching and invalidation belong to Query,
UI state to Zustand", and this ADR decides what that means precisely enough that two apps cannot
drift, because three failure modes are already visible from here:

1. **The stale consent.** A consent shown as `ACTIVE` after the FIU has been blocked (or the
   reverse: shown revoked while the server disagreed) is not a cosmetic bug. The product's claim is
   *proof of consent*, and a UI that contradicts the ledger undermines the one thing the ledger
   exists to establish. A hand-rolled cache is how that happens: a store, a `useEffect` fetch, a
   manual `setState` on success, and an invalidation nobody remembered to write.
2. **The lie.** An approval that renders as done before the server has recorded it is the same
   failure with worse timing — the customer believes they granted something that may never have
   been written, or withheld something that was.
3. **The leak.** Client state is a copy of personal data living in a browser process. Whatever we
   keep, and for how long, is a retention decision; whatever we *persist* outlives the session, the
   logout and the tab. ADR-0002 §8 removed the access token from `localStorage` for exactly this
   reason, and the argument does not stop at the token.

The constraints that shape the decision:

- **The contract is generated, so the client's API surface is not hand-written** (ADR-0001, #58).
  Query keys and cache identity have to be derivable from generated types, or a contract change
  silently becomes a runtime mismatch instead of a compile error.
- **The server owns consent state, and it says so loudly.** `consent_artefact` carries a `@Version`
  optimistic lock (ADR-0003 §8.1) and the state machine's transitions are the only writers of
  `status` (#31). A 409 is therefore a *normal* outcome the customer UI must explain in words
  (#62), not a generic error string.
- **Reads have write side-effects.** `GET /api/v1/audit` writes an `AUDIT_READ` row and the CSV
  export writes `AUDIT_EXPORTED` (ADR-0003 §13.2). A frontend refetch policy is therefore also a
  write-amplification policy, and "just refetch aggressively" is not free.
- **The ledger is append-only and its events are the truth** (ADR-0003 §12.2: no state change
  without its row, in the same transaction). Any client cache that is written *from* a stream rather
  than re-read *from* the ledger can drift into a state nothing will ever correct — §6.
- **Freshness has a deadline in the demo script**: #78's acceptance criterion is that revoking a
  consent in another tab updates the open dashboard within a second, and #58's is that a successful
  revoke refetches the consent list. Both are cache-policy statements, and both have to be true
  without a cache write.
- **Both apps are keyboard-first, axe-clean and tested with MSW request counts** (#62, #65, #66),
  so whatever we choose has to be assertable in a test: "the list was refetched" is a test we can
  write, "the cache is coherent" is not.
- **Two apps, one decade.** The ops console's reads are audited and role-scoped, the portal's are
  ownership-scoped (#30). Both must be able to answer "where does this value live?" without asking
  a person who has left.

## Decision

**One rule decides every piece of state, and one asymmetry decides whether a mutation may be
optimistic:**

> **If the server can change a value without this tab knowing, it belongs to TanStack Query. If only
> this browser session can change it, it belongs to Zustand. If it must survive a reload, a
> bookmark, a share or the back button, it belongs to the URL — not to either store.**

> **An optimistic patch may only ever *narrow* what the customer has (revoke, pause). A mutation
> that *widens* it (approve, resume) is never optimistic — the UI does not claim consent the server
> has not recorded.**

The decision in full:

1. **Server state is Query, and only Query.** Consents, consent requests, timelines, access logs,
   pinned notices, DSARs, approvals, the audit viewer, the session inventory and reference data are
   `useQuery` reads of the API. No store, no `useState`, no `useEffect` copy: **the cache is the
   only client-side copy of a server fact**, and it is a cache, not a store — it may be discarded at
   any moment without loss.
2. **Client state is Zustand, and Zustand holds nothing else.** The rules are mechanical: a store
   may hold ids, codes, booleans, numbers and the user's own in-progress input. It may not hold an
   API entity, a credential, an authorisation claim, or a derived count of server rows. Two
   components that are not parent and child, or a value that must outlive a component, is the
   trigger for a store; anything else is `useState`.
3. **Shareable, restorable state is the URL.** Route identity, applied filters, the page number and
   a linkable modal live in `useSearchParams`/route params, because they are the states a customer,
   an agent — or the audit trail — should be able to send to someone else.
4. **One `QueryClient` per app, built by `createQueryClient()`** with the defaults in §3.3, so tests
   and production share one policy and no screen invents its own `staleTime`.
5. **Mutations declare an invalidation set, and it is a table, not a habit** (§4). Revoke, approve
   and deny all invalidate the consent list *and* the pending-request list; a mutation is not
   finished when the server returns 200, it is finished when every read model that could contain the
   changed fact has been invalidated. Asserted with MSW request counts.
6. **Optimistic revoke, with an exact rollback** (§5): `cancelQueries` → snapshot → narrow →
   `onError` restores the snapshot and classifies the failure (409 says "changed in another tab",
   5xx says "nothing was revoked", 404 removes the entity) → `onSettled` invalidates everything.
7. **The SSE stream is a change hint, never a data source** (§6): an event maps to a query key and
   invalidates it. Nothing is written into the cache from the wire — not even when the payload
   contains the new state.
8. **Nothing personal is persisted, and logout empties everything** (§7.6): no `persistQueryClient`,
   a persistence allowlist of four non-personal preferences, and `queryClient.clear()` plus
   `resetClientState()` on the ADR-0002 §5 logout path.

The one-line property, stated so a reviewer can test it: **a value has exactly one home, a screen
never holds server truth, and the UI can never show more consent than the ledger records.**

### 1. The three-question test, and why the boundary is where it is

A new piece of state is classified by asking, in order:

1. **Can the server change it without this tab knowing?** → **Query.** (If yes, it is not client
   state, no matter how convenient a store would be.)
2. **Must it survive a reload, a bookmark, a share or the back button?** → **the URL.** (Applied
   filters, the selected entity, the page.)
3. **Does a second component render it, or must it outlive a component?** → **Zustand.** Otherwise:
   `useState`.

And a fourth category that is *not* a store: **imperative, non-rendered resources** — the access
token, the single-flight refresh promise, the `QueryClient`, the `EventSource`/stream client, the
generated API client — live in **module scope**, exactly as ADR-0002 §2 puts the access token in "a
variable in a closure". They are not state to render; they are objects with a lifetime. The only
thing that crosses from module scope into a store is a *status* someone renders (the stream badge in
§6.6).

Why the boundary is not negotiable in either direction:

| Mistake | What actually goes wrong |
|---|---|
| Server data in Zustand | It is a second copy of a fact the ledger owns. Every mutation in every screen must remember to update it, every job that changes the row server-side misses it, and the failure is a screen telling a customer they are still sharing data when they are not. There is no way to detect *missing* updates from the client. |
| UI state in Query | The cache's lifetime policy (`staleTime`, `gcTime`, invalidation) is meaningless for a wizard draft. Worse, it *works* at first: a draft stored under `['wizard']` survives until `gcTime` collects it, until an unrelated `invalidateQueries` walks over it, or until it is persisted by someone "optimising" boot. UI state in the cache also makes the invalidation contract unverifiable — you can no longer say "every invalidation below only touches server state". |
| Shareable state in Zustand | The URL stops being the source of truth for "what is on screen". A support person cannot be sent the view they are looking at, the back button lies, and the audit trail records a search whose filters nobody can reproduce (#69's reason-for-access prompt is only honest if the query it belongs to is reproducible). |

The reason this matters more here than in a CRUD app: the UI has a **verification obligation**.
Every screen in ConsentHub is the customer-facing rendering of an auditable fact, and the moment a
value has two homes, "which one is true?" becomes a question only the code can answer.

### 2. The state census — where each named piece of state lives

The acceptance criterion for this ADR is "someone new can read it and know which store a given piece
of state belongs in". This is that table; §10 is how to use it on a value that is not listed.

#### 2.1 Server state → TanStack Query

| State | Key | Notes |
|---|---|---|
| Consent list (filtered, sorted, paged) | `consentKeys.list(filters)` | #36, #61. Filters are part of the key, so two filter views are two cache entries, never one mutated list. |
| Consent detail | `consentKeys.detail(id)` | #36, #61, #62 |
| Consent timeline / events | `consentKeys.events(id)` | #37, #63; nested under the detail key so one prefix covers it (§4.3) |
| Access log for a consent | `consentKeys.accessLog(id, window)` | #40, #63. The window is in the key: a new range is a new entry, and `placeholderData: keepPreviousData` keeps the table from blanking. |
| Pinned notice + version history | `consentKeys.notice(id)` | #64, ADR-0003 §9. `staleTime: Infinity` — the pin is immutable rows. |
| Pending consent requests (list, detail) | `requestKeys.list(filters)` / `requestKeys.detail(id)` | #33, #60 |
| Dashboard aggregate (BFF) | `dashboardKeys.all` | #77, #61. One aggregate query is a *read model*, and §4.2 makes it a mandatory invalidation target. |
| DSARs (list, detail, SLA fields) | `dsarKeys.*` | #44, #72 |
| Approval queue + decision history | `approvalKeys.*` | #45, #71 |
| Audit events (paged, filtered) | `auditKeys.list(filters)` | #46, #73. Special freshness policy in §3.3 because reading is audited. |
| Caller's live sessions | `sessionKeys.all` | #26, ADR-0002 §5 |
| Reference data: purposes, categories, FIU registry, notice catalogue | `referenceKeys.*` | #14, #42, #26. Slow-changing; long `staleTime`. |
| Customer record (ops console) | `customerKeys.detail(id)` | #69. Search results are `customerKeys.list(term)`. |

#### 2.2 URL state

| State | Where | Why the URL |
|---|---|---|
| Selected entity | Route params: `/consents/:id`, `/requests/:id`, `/dsar/:id` | Refresh, deep link, back button. The route param *is* the query key argument. |
| Access-log window and category filter | `?from=&to=&category=` | #63: "test: date-range filter issues the right query params". |
| Audit viewer filters | `?from=&to=&actorType=&eventType=&consentId=&page=` | #73: "the query params match the API contract". An investigation must be reproducible by URL. |
| Dashboard status filter, sort, customer search term | `?status=&sort=&q=` | #61: filters compose and are test-covered; shareable. |
| Approval queue filter, DSAR status/`breachedOnly`, page numbers | `?status=&page=` | #71, #72 |
| A modal a link should reopen | e.g. `/consents/:id/revoke` | If a link, a refresh or the back button should restore it, it is the URL; a modal only the current click opened is `useState`. |

#### 2.3 Client state → Zustand

| State | Store | Lifetime / reset |
|---|---|---|
| Approval wizard step | `useApprovalDraftStore` | Keyed by `requestId`; reset on route change and on `requestId` change (§7.2) |
| Granular category toggles (the draft) | `useApprovalDraftStore` | Same; defaults derived once from the server's `requiresExplicitOptIn` flags when the draft starts |
| Expiry / date-range picker draft | `useApprovalDraftStore` | Same |
| Deny reason text | `useApprovalDraftStore` | Same; **never persisted** (§7.6) |
| Filter panel open/closed + uncommitted draft values | `usePanelStore` | Session; the *applied* filter is in the URL, the draft is not |
| Row multi-select for bulk actions | `useSelectionStore` | Session; cleared on route change and after the bulk call (#72) |
| Toasts / notifications | `useToastStore` | Transient. In a store because non-React code raises them (the query error handler, the stream client). |
| Stream status badge (`live`/`polling`/`offline`) | `useStreamStatusStore` | §6.6. The connection object is module scope; only the rendered status is a store. |
| Idle-timeout warning dismissed; "stay signed in" in flight | `useSessionUiStore` | ADR-0002 §6; per tab |
| UI preferences: theme, density, reduced motion, table page size | `usePrefsStore` | Persisted allowlist (§7.6) |

#### 2.4 The four traps, and the derived-value rule

These are the states that look like one home and belong in another. All four are recurring review
comments:

| Looks like | Actually | Because |
|---|---|---|
| `isLoading`, `isError`, `error` flags for a fetch | `isPending` / `isError` on the query | A parallel store flag is a second source of truth that a second observer of the same query will not update. |
| "Last updated at" / freshness indicator | `query.state.dataUpdatedAt` | Every query already has it; storing it means keeping it in sync. |
| Pending-count badge in the nav (#71) | `usePendingRequests().data?.total` | The classic store-drift bug: five mutations must remember to increment a counter. Derived from the query, invalidated by the same contract (§4). |
| DSAR SLA countdown (#72) | Derived from the server's `dueAt` + a ticking clock | Store the anchor (`dueAt`, which came from the server), never a decrementing number that drifts when a tab is suspended. |

> **Rule:** a value that can be computed from the cache is never stored. Store the input, derive the
> rest in a selector or in the component.

### 3. TanStack Query: one client, typed keys, fixed defaults

#### 3.1 One client per app, created by a function

```ts
// apps/*/src/api/queryClient.ts
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, gcTime: 300_000, retry: retryUnlessClientError,
                 refetchOnWindowFocus: true, refetchOnReconnect: true, throwOnError: false },
      mutations: { retry: 0 },
    },
    queryCache: new QueryCache({ onError: reportQueryError }),   // Problem → toast, in one place
    mutationCache: new MutationCache({ onError: reportMutationError }),
  });
}
```

- **One per app, not one per screen or per route.** A cache that is recreated on navigation is not a
  cache; it is a fetch per render.
- **Created by a function so tests get a fresh one** (#65's custom render helper calls
  `createQueryClient({ retry: false })` and `queryClient.clear()` in teardown) — a shared module
  singleton in tests leaks state between specs and is the most common source of order-dependent
  failures in a Query codebase.
- **`gcTime` is a retention clock.** 5 minutes after the last observer of a query goes away, the
  browser's copy of that consent is gone. It is not a security boundary — it is the shortest
  defensible option that does not cause a refetch storm on tab switches — but it is the number a
  reviewer should look at when someone asks "how long does the browser keep my data".

#### 3.2 The key factory is the contract

Every key literal in both apps comes from one file per app (`src/api/keys.ts`). Components never
write a key by hand, and the factory's argument types come from the generated client, so a contract
change that renames or reshapes a query parameter fails `tsc` at the only place keys are built:

```ts
// apps/web/src/api/keys.ts — the only file in the app that contains a query-key literal.
import type { operations } from '../generated';

export type ConsentFilters = NonNullable<operations['listConsents']['parameters']['query']>;
export type AccessWindow  = { from: string; to: string; category?: string };

export const consentKeys = {
  all: ['consents'] as const,
  lists: () => [...consentKeys.all, 'list'] as const,
  list: (filters: ConsentFilters) => [...consentKeys.lists(), filters] as const,
  details: () => [...consentKeys.all, 'detail'] as const,
  detail: (id: string) => [...consentKeys.details(), id] as const,
  // Nested under the detail key on purpose: one invalidation of `detail(id)` covers the whole
  // consent — body, timeline, access log and pinned notice — without touching other consents.
  events: (id: string) => [...consentKeys.detail(id), 'events'] as const,
  accessLog: (id: string, w: AccessWindow) => [...consentKeys.detail(id), 'access-log', w] as const,
  notice: (id: string) => [...consentKeys.detail(id), 'notice'] as const,
} as const;

export const requestKeys = {
  all: ['consent-requests'] as const,
  lists: () => [...requestKeys.all, 'list'] as const,
  list: (filters: RequestFilters) => [...requestKeys.lists(), filters] as const,
  detail: (id: string) => [...requestKeys.all, 'detail', id] as const,
} as const;

export const dashboardKeys = { all: ['dashboard'] as const } as const;
export const dsarKeys      = { all: ['dsar'] as const, /* list/detail/… */ } as const;
export const approvalKeys  = { all: ['approvals'] as const, /* list/history/… */ } as const;
export const auditKeys     = { all: ['audit'] as const,
                               list: (f: AuditFilters) => ['audit', 'list', f] as const } as const;
export const referenceKeys = { purposes: ['reference', 'purposes'] as const, /* … */ } as const;
export const sessionKeys   = { all: ['auth', 'sessions'] as const } as const;
```

Three rules that make the factory worth its file:

- **The key contains every input the query function uses.** A filter that changes the response but
  not the key is a cache-serving-the-wrong-data bug, and it is invisible until someone filters in
  production. This is why `accessLog` takes the window rather than reading it from a store.
- **Hierarchy mirrors containment**, so a prefix invalidation is meaningful and a test can assert a
  prefix rather than a string.
- **Store values may appear in a key only in debounced form.** The search box's raw text is local
  `useState`; the term that reaches `customerKeys.list(term)` is debounced (250 ms, #69), so a
  five-character search creates one cache entry, not five.

#### 3.3 Freshness, with the reasoning attached to the numbers

| Query family | `staleTime` | `refetchOnWindowFocus` | Why this number |
|---|---|---|---|
| Consents, requests, dashboard, DSARs, approvals | **30 s** | ✅ | A decision made anywhere (another tab, an agent, a job) changes these. 30 s bounds staleness for a screen that is just being looked at, without a request per render; window focus covers the case a background tab cannot see; §6 makes it under a second when the stream is up. |
| Consent timeline, access log | **30 s** | ✅ | Append-only: it only grows. A refetch is cheap and never wrong; a stale timeline is the thing the transparency screen exists to prevent. |
| Pinned notice + history | **Infinity** | ➖ | The artefact pins the notice version and its hash (ADR-0003 §9); those rows are immutable, so refetching can only return identical bytes. The cache is as immutable as the row. |
| Audit viewer (#73) | **60 s** | ❌ | **Because reading is audited** (ADR-0003 §13.2): every `GET /audit` writes an `AUDIT_READ` row, so a focus-refetch is a write. A page that reorders under a reader mid-investigation is also worse than staleness; the viewer shows `dataUpdatedAt` and an explicit Refresh. |
| Reference data (purposes, categories, FIUs) | **30 min** | ❌ | Changes by migration or onboarding, not by traffic. |

The remaining defaults, stated because they are decisions:

- **`retry`** — up to 2 attempts for GETs with exponential backoff, **never** for 4xx (other than
  408/429) and **never** for mutations. A retried 401 is not a retry, it is the single-flight silent
  refresh (ADR-0002 §4) — exactly one, then logout. A retried `POST /consents/{id}/revoke` is a
  second revocation attempt against the ledger, which is a product decision we do not make by
  accident.
- **`refetchOnReconnect: true`** — a dropped connection is precisely a window of missed changes.
- **`refetchInterval`** — `undefined` everywhere except the polling fallback (§6.5).
- **`placeholderData: keepPreviousData`** on paged lists (`ConsentPage`, audit, DSAR) so pagination
  and filter changes do not blank the table (#61's "no layout shift between loading and loaded
  states").
- **`throwOnError: false`**, with the error surface standardised through the shared hook #58 asks
  for. Screens render `Loading` / `Error` / `Empty` from one place; a route-level error boundary is
  for bugs, not for 500s.

#### 3.4 What a cache entry may contain

**Only what the server returned.** The canonical example is the revoke flow: it is tempting to add
`pendingRevocation: true` to a cached `Consent` so the row can render a spinner. We do not, because
after that line no type says whether a field came from the API or from a client patch, and §6's
"the cache is a projection of the ledger" stops being checkable. Pending state is rendered from
`mutation.isPending` (via `useMutationState` for a row-level indicator), not from the entity.

#### 3.5 Exports are commands, not queries

`GET /audit/export.csv` (#73) and the DSAR export bundle (#44) are `useMutation`s that hand the
response to `URL.createObjectURL` and revoke the URL immediately after the download. They are never
`useQuery`s, never cached, and never rendered from a cache entry: a blob of audit rows or personal
data sitting in an in-memory cache with a 5-minute `gcTime` is a retention decision made by a
library default, which is not how this codebase should ever make one.

### 4. The invalidation contract

A mutation is not finished when the server answers. It is finished when every read model that could
contain the changed fact has been invalidated. The invalidation sets are written down once, in
`src/api/invalidation.ts`, so a review of "what does revoke invalidate?" is a review of one file:

```ts
// apps/web/src/api/invalidation.ts — read by the mutation hooks and by the tests in §9.
export const invalidatedBy = {
  createRequest:  () => [requestKeys.all, dashboardKeys.all],
  approveRequest: () => [requestKeys.all, consentKeys.all, dashboardKeys.all],
  denyRequest:    () => [requestKeys.all, consentKeys.all, dashboardKeys.all],
  revokeConsent:  (id: string) => [consentKeys.lists(), consentKeys.detail(id),
                                   requestKeys.all, dashboardKeys.all],
  pauseConsent:   (id: string) => [consentKeys.lists(), consentKeys.detail(id), dashboardKeys.all],
  resumeConsent:  (id: string) => [consentKeys.lists(), consentKeys.detail(id), dashboardKeys.all],
  raiseDsar:      () => [dsarKeys.all],
  decideApproval: (taskType: ApprovalTaskType) => [approvalKeys.all, ...targetKeys(taskType)],
} as const;
```

#### 4.1 The table

| Mutation | Ticket | Invalidates | Optimistic |
|---|---|---|---|
| Approve a request | #34 | `requestKeys.all` **(the pending-request list)**, `consentKeys.all` **(the consent list)**, `dashboardKeys.all` | ❌ (§5.5) |
| Deny a request | #35 | `requestKeys.all`, `consentKeys.all`, `dashboardKeys.all` | ❌ (§5.5) |
| Revoke (full or partial) | #38 | `consentKeys.lists()`, `consentKeys.detail(id)` — which carries the **timeline and access log** — `requestKeys.all`, `dashboardKeys.all` | ✅ (narrowing) |
| Pause | #39 | `consentKeys.lists()`, `consentKeys.detail(id)`, `dashboardKeys.all` | ✅ (narrowing) |
| Resume | #39 | `consentKeys.lists()`, `consentKeys.detail(id)`, `dashboardKeys.all` | ❌ (widening) |
| FIU raises a request | #32 | `requestKeys.all`, `dashboardKeys.all` | ❌ |
| DSAR raise / progress / execute | #44 | `dsarKeys.all`, and after execution `consentKeys.all` + `auditKeys.all` (erasure redacts artefacts and writes `DSAR_COMPLETED`) | ❌ |
| Approval decision | #45, #71 | `approvalKeys.all` **plus the target resource's keys** via `targetKeys(taskType)` — a decision *is* the action it authorises | ❌ |
| Bulk DSAR assignment | #72 | `dsarKeys.lists()` | ❌ |
| Logout / principal change | #57 | `queryClient.clear()` — the one legal unkeyed invalidation (§6.4) | ➖ |

The issue's floor, restated precisely because it is the sentence that matters: **revoke, approve and
deny each invalidate the consent list and the pending-request list.** #58's phrasing adds the
per-consent children to revoke/pause/resume; between the two tickets the union above is the
contract, and any mutation that touches consent state invariant-wise invalidates both lists.

#### 4.2 Why both lists, and why the dashboard is on every set

- **Both lists, always.** A pending request and the consent it becomes are two projections of one
  state machine. If approve invalidated only the request list, the dashboard would keep showing
  "no active consents" for a customer who just granted one — for up to 30 s — and if revoke
  invalidated only the consent list, the request list could keep offering a decision on an artefact
  that no longer exists. Invalidation is two `GET`s against a bounded list that is almost always
  already mounted; the class of bugs it removes is the class this product cannot afford.
- **The dashboard aggregate is a third projection (#77).** The BFF's aggregate endpoint is a read
  model containing consents, requests and counts; a mutation that invalidates the lists but not the
  aggregate leaves the *screenshot in the README* stale. Rule: **a new read model is added to this
  table in the same PR that adds it**, and #77's own acceptance criterion ("cache is invalidated on
  revoke/approve — no stale consent state") is discharged twice: once in the BFF, once here.
- **A decision's target is decided by its type.** `decideApproval` dispatches through
  `targetKeys(taskType)`: a `CONSENT_REINSTATEMENT` invalidates consents, an `ERASURE_EXECUTION`
  invalidates DSARs and consents, a `LEDGER_PURGE` invalidates the audit viewer. The map is where a
  new `ApprovalTask` type must be registered, so a missing invalidation is a type error rather than
  a `staleTime` accident.

#### 4.3 What `invalidateQueries` actually does, since the sets above rely on it

- **Prefix matching**: `{ queryKey: consentKeys.detail(id) }` matches `[…,'detail',id,'events']` and
  `[…,'detail',id,'access-log',w]`. That is why §3.2 nests by containment.
- **Active queries are refetched; inactive ones are marked stale** and refetched when next mounted.
  A broad prefix (`consentKeys.all`) is therefore cheap in practice — a filter view nobody is
  looking at costs nothing until it is opened.
- **`invalidateQueries` with no key is banned** outside logout and the post-reconnect resync of
  §6.4. It is the shape of a missing dependency: someone who does not know which key to invalidate
  reaches for all of them, and the review comment should be "name the key", not "performance".

#### 4.4 The test that proves it

The invalidation contract is not documentation-only. #58's acceptance criterion is a test that
counts MSW requests: perform the mutation, assert the consent list and the pending-request list were
fetched again. The same shape is repeated per row of §4.1, and it is the cheapest regression test in
the codebase:

```ts
it('revoke refetches the consent list, timeline and pending requests', async () => {
  // …render, open the revoke modal, confirm…
  await waitFor(() => expect(msw.calls('GET /api/v1/consents').count).toBeGreaterThan(1));
  expect(msw.calls('GET /api/v1/consents/:id/events').count).toBeGreaterThan(1);
  expect(msw.calls('GET /api/v1/consent-requests').count).toBeGreaterThan(1);
  expect(msw.calls('GET /api/v1/consents/:id/access-log').count).toBeGreaterThan(1);
});
```

### 5. Optimistic updates: narrowing may be optimistic, widening never is

#### 5.1 The rule, and why the asymmetry is the safety property

> **An optimistic patch may only ever reduce what the customer appears to be sharing. Anything that
> grants, restores or extends is applied only after the server has recorded it.**

The consequence is that every possible optimistic state is a *lower bound* on the customer's real
permissions, on both the success and the failure path:

- Wrong in the narrowing direction (we showed "revoked" and the server refused): the customer
  believes less is shared than actually is. Uncomfortable, but it errs toward *more* privacy, is
  rollback-able, and the error toast says exactly what happened: "Nothing was revoked — the consent
  is still active."
- Wrong in the widening direction (we showed "approved" and the server refused): the customer
  believes *their data is being shared* when it is not — or worse, believes they withheld consent
  while an FIU is fetching. That is the product's core claim, inverted, by an optimistic guess.

So: **revoke ✅, pause ✅** (both narrow), **approve ❌, resume ❌, deny ❌**. Deny is excluded for a
different reason, from #60: the pending-review screen exists to make a decision unambiguous, and a
screen that shows a request as decided before the server agrees has told the customer a decision was
recorded when it may not have been. The screen's honesty is the feature.

#### 5.2 Revoke, step by step

```ts
// apps/web/src/features/consents/useRevokeConsent.ts
export function useRevokeConsent(consentId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: RevokeRequest) => api.revokeConsent(consentId, body),
    retry: 0,                                   // §3.3: a retried revoke is a second attempt

    // (1) Stop the responses that would otherwise land on top of the patch. An in-flight list
    //     fetch that started before the mutation will resolve after it and silently overwrite
    //     the optimistic state — the classic optimistic-update bug.
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: consentKeys.all });

      // (2) Snapshot every entry the patch touches, so rollback is exact — not a refetch,
      //     not a guess, not "invalidate and hope".
      const snapshot = queryClient.getQueriesData<Consent>({ queryKey: consentKeys.all });

      // (3) Patch by NARROWING only. A partial revoke produces a *new* artefact with the
      //     remaining categories and marks the old row REVOKED (ADR-0003 §8, substance by
      //     lineage), so we may not invent a successor id or an updated expiry here: we show
      //     the artefact we have, as revoked, with the revoked categories removed, and let
      //     onSettled's invalidation bring the successor in.
      const revoked = new Set(body.categories ?? []);
      queryClient.setQueriesData<Consent>({ queryKey: consentKeys.all }, (old) =>
        old
          ? { ...old, status: 'REVOKED',
              dataCategories: old.dataCategories.filter((c) => !revoked.has(c)) }
          : old,
      );

      return { snapshot };
    },

    // (4) Roll back first on every path, then classify. The rollback is not conditional.
    onError: (error, _body, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);

      if (error instanceof VersionConflict) {        // 409: someone else changed it first
        void queryClient.invalidateQueries({ queryKey: consentKeys.all });
        toast.error('This consent changed in another tab — refresh and try again.');
      } else if (error instanceof NotFound) {        // 404: it is gone; do not resurrect it
        queryClient.removeQueries({ queryKey: consentKeys.detail(consentId) });
        void queryClient.invalidateQueries({ queryKey: consentKeys.lists() });
      } else if (error instanceof StepUpRequired) {  // 428 (ADR-0002 §6): ops-console path
        sessionUi.requestStepUp(() => revokeAgain());  // prompt, then retry the same mutation once
      } else {
        toast.error('Nothing was revoked — the consent is still active.');
      }
    },

    // (5) The server is the truth on success *and* failure. `onSettled`, not `onSuccess`.
    onSettled: () => {
      for (const key of invalidatedBy.revokeConsent(consentId)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
```

Points a reviewer should check, because each one is a real bug avoided:

1. **`cancelQueries` before the snapshot**, not after. Snapshotting first and cancelling second
   leaves a window in which the cancelled fetch's result is captured as "previous state".
2. **The snapshot is the pair list from `getQueriesData`**, so rollback restores *every* matching
   entry — all filter variants of the list, the detail, the timeline — not just the one the screen
   is showing.
3. **Rollback happens before classification.** An error branch that throws on the way to its own
   `invalidateQueries` must not leave the UI lying.
4. **`onSettled` invalidates, not just `onSuccess`.** A failed optimistic mutation is exactly the
   case where the cache's relationship to the server is least certain.
5. **No retry** on the mutation.
6. **The mutation owns the patch.** `setQueryData` appears in `onMutate`/`onSuccess` of the owning
   mutation and in the stream client's resync (§6.4) — nowhere else. In particular, never in an
   event handler, never in a `useEffect`, never in the SSE callback.

#### 5.3 Partial revocation

Partial revoke (choose categories to keep, revoke the rest — #62) is the case where the client must
resist inventing state:

- The patch removes the revoked category codes from `dataCategories` and sets `status: 'REVOKED'` on
  the artefact the customer is looking at. That is a truthful lower bound: the FIU will not be able
  to fetch those categories.
- The patch does **not** create the successor artefact. Its id comes from the server; a fabricated
  id would leak into `consentKeys.detail(id)`, into the URL, and into the timeline's next fetch.
  The successor appears through §4.1's invalidation, normally within one round trip.
- If the mutation returns the successor (`Consent` in the response), the hook may seed that *one*
  detail key with `setQueryData(consentKeys.detail(successor.id), successor)` — the mutation
  response is authoritative for the entity it names, and only for that entity. Lists still come from
  invalidation, because the successor's position in a filtered/sorted list is the server's business.
- The confirmation modal (#62) states what is being revoked, in categories, before any of this runs.
  Optimism starts *after* the customer has confirmed; the modal itself is never optimistic.

#### 5.4 Four failures, four behaviours, four sentences

| Server answer | Meaning | Client behaviour | What the user is told |
|---|---|---|---|
| `409` + `Problem` | `@Version` conflict — the consent changed elsewhere (ADR-0003 §8, #62) | Roll back, invalidate the consent, do not retry | "This consent changed in another tab — refresh and try again." |
| `404` | The artefact is gone | Roll back, `removeQueries` on the detail, invalidate the list | "That consent no longer exists." |
| `428` | Step-up re-authentication required (ADR-0002 §6) | Roll back, prompt, retry the *same* mutation exactly once | Password prompt, no error |
| `5xx` / network | Unknown — the server may or may not have applied it | Roll back, invalidate, no auto-retry | "Nothing was revoked — the consent is still active." |

`401` is not in this table on purpose: it never reaches the mutation. The generated client's mutator
performs exactly one single-flight refresh (ADR-0002 §4) and replays the request; if that fails, the
app logs out and clears the cache (#57), and there is no UI sentence to write.

#### 5.5 Approve and deny are pessimistic, and the screen says so

On the pending-review screen (#60), the primary action's pending state is the message: the button
becomes disabled with a spinner, the card stays visible, and only the server's `200` triggers
navigation and the §4.1 invalidation. On failure the error is rendered where the button was, with
the request still open — not a toast that disappears while the customer wonders whether they just
approved something.

#### 5.6 The residual: a sub-second window

An optimistic patch lives in the cache for one round trip, and anything else that refetches the same
key inside that window can replace the patch with pre-mutation data — the revocation visually
"undoes" until `onSettled` re-invalidates. Two mitigations, both cheap:

- `cancelQueries` (§5.2 step 1) removes the in-flight case, which is the common one.
- The **polling fallback of §6.5 is gated on `!queryClient.isMutating()`**, because polling is the
  only other source of background refetches that can land inside the window.

The principled alternative — keeping optimistic state entirely outside the cache and rendering it
with `useMutationState`, so the cache stays a pure projection — is recorded here as the growth path.
It removes the window but complicates every read (each screen would have to merge "cache value" with
"pending overlay"), and the narrow rule of §5.1 makes the merged result cheap to reason about.
Revisit if a second optimistic flow appears.

#### 5.7 Mutation-side hygiene

- One hook per mutation (`useRevokeConsent`, `useApproveRequest`, `useDecideApproval`, …), colocated
  with its feature, each one declaring its invalidation set from §4.1. No screen calls
  `useMutation` inline with its own `onSuccess`.
- **Queries never mutate the cache.** No `useEffect` writes a fetch result into a store, and no
  `onSuccess` of a query patches another key. Edges belong in mutations and the stream resync.
- `mutationKey` is set from the same factory (`['revokeConsent', consentId]`) so `useMutationState`
  can find pending mutations for row-level indicators (§3.4).

### 6. The stream is an invalidation hint, never a data source

The BFF emits server-sent events for consent state changes (#78). The decision:

> **An event maps to a query key and calls `invalidateQueries`. It does not write a value into the
> cache — not even when the event's payload contains the new state.**

#### 6.1 Why, in four failure modes that a cache write cannot survive

1. **A missed event leaves a confident lie.** SSE delivery is at-most-once across a reconnect gap; a
   write-from-stream client that misses `CONSENT_REVOKED` has no mechanism that will ever correct
   it, because nothing else refreshes the cache. An invalidation that is missed is corrected by the
   next focus refetch, the next mount, or §6.4's post-reconnect resync. *Invalidation is
   self-healing; a write is not.*
2. **The stream is a second representation of the ledger.** ADR-0003 §13.1 kept `data_access_log` as
   a separate, self-contained table rather than a projection of `consent_event`, precisely because a
   projection you can render without re-reading the ledger is a projection that can disagree with
   it. A client cache written from an event stream is exactly that third representation — this time
   with no test that can compare it to anything.
3. **The payload is a summary, and the screens need the row.** Rendering a revoke from the event
   means implementing the state machine's rendering twice: once from the artefact, once from the
   event envelope. The two will diverge the first time a field is added.
4. **Authorisation is per-read, not per-event.** A session can lose the right to see an entity
   between the event being emitted and the client rendering it (role change, family revocation,
   erasure — ADR-0002 §5). An invalidation re-reads under the caller's *current* authority and gets
   a truthful 403/404; a cache write injects data the caller may no longer be allowed to see.

#### 6.2 The hint envelope carries ids and codes only

```ts
// The BFF's event envelope (#78). Ids, codes and a timestamp — the ADR-0003 §3 discipline
// (no prose, no names, no payloads) applied to the wire, because a stream is a network log line
// and a devtools artifact too.
type StreamHint = {
  id: string;                                   // monotonic per connection; Last-Event-ID
  type: 'CONSENT_APPROVED' | 'CONSENT_REVOKED' | 'CONSENT_PAUSED' | 'CONSENT_RESUMED'
      | 'CONSENT_EXPIRED' | 'DATA_ACCESSED' | 'NOTIFIED';
  consentId: string;
  occurredAt: string;
};
```

The vocabulary is ADR-0003 §4's, so the stream and the ledger speak the same language and a new
event type is added to both in one PR. No category lists, no FIU names, no amounts: the client's
next `GET` fetches those, authorised, from the ledger's read path.

#### 6.3 The stream client — `fetch`, not `EventSource`

`EventSource` is the natural API and it cannot be used here: it cannot set headers, so it cannot
send `Authorization: Bearer`, and the refresh cookie cannot stand in for it because its `Path` is
`/api/v1/auth/refresh` (ADR-0002 §3) — the browser does not attach it to `/events` at all. Putting a
token in a query string is rejected outright: it lands in proxy logs, browser history and referers,
which is the exfiltration path ADR-0002 §8 exists to close.

So the client is `fetch` + `ReadableStream` with a hand-rolled reader, and the reconnect logic that
`EventSource` would have given us becomes explicit:

- **Reconnect with backoff and jitter** (1 s → 30 s, ±20%), sending `Last-Event-ID`. The BFF replays
  from a bounded ring buffer; if the id is older than the buffer, it closes the stream and the
  client performs the §6.4 resync instead of pretending it caught up.
- **Reconnect at token renewal.** The access token lives 300 s (ADR-0002 §1) while a healthy stream
  lives for hours. The stream does not authenticate per event; it reconnects (with the new token) on
  a timer slightly shorter than the token TTL, and on `401` it goes through the single-flight silent
  refresh and then reconnects.
- **Heartbeats** every 15 s (`: keepalive` comment frames) so intermediaries do not close an idle
  connection, and `Content-Type: text/event-stream`, `Cache-Control: no-store`,
  `X-Accel-Buffering: no` on the BFF side.
- **Same-origin relative URL** (`/events` via the dev proxy, #56), so no CORS preflight, no
  credentialed cross-origin stream.
- **One connection per tab**, with jittered reconnect so N tabs do not reconnect in lockstep. If the
  BFF's documented connection budget (#78) is ever exceeded, leader election over the existing
  `BroadcastChannel` (ADR-0002 §4) is the next step — recorded as the growth path, not built now.

#### 6.4 The hint handler, and the one legal unkeyed invalidation

```ts
// apps/web/src/api/stream.ts — module scope, like the token (ADR-0002 §2).
const HINT_TARGETS: Record<StreamHint['type'], readonly QueryKey[]> = {
  CONSENT_APPROVED: [consentKeys.all, requestKeys.all, dashboardKeys.all],
  CONSENT_REVOKED:  [consentKeys.all, requestKeys.all, dashboardKeys.all],
  CONSENT_PAUSED:   [consentKeys.all, dashboardKeys.all],
  CONSENT_RESUMED:  [consentKeys.all, dashboardKeys.all],
  CONSENT_EXPIRED:  [consentKeys.all, dashboardKeys.all],
  DATA_ACCESSED:    [consentKeys.all],            // nested: timeline + access log
  NOTIFIED:         [consentKeys.all],
};

// A burst (an approval writes several ledger rows) must not become a refetch storm: at most one
// invalidation per key per 250 ms, trailing edge. The coalescer is here, not in components.
export function onHint(queryClient: QueryClient, hint: StreamHint) {
  for (const key of HINT_TARGETS[hint.type]) {
    coalesce(key, () => queryClient.invalidateQueries({ queryKey: key }));
  }
}

// The single exception to §4.3's "name the key" rule: events that arrived while we were
// disconnected are unknowable, so a reconnect is a resync point for everything we are showing.
export function onStreamOpen(queryClient: QueryClient) {
  void queryClient.invalidateQueries();
  useStreamStatusStore.getState().set('live');
}
```

The three assertions a reviewer makes about this file: it imports no rendering code; it never calls
`setQueryData`; and every branch of the envelope lands on a key from `keys.ts`. #78's acceptance
test — "revoking a consent in another tab updates the open dashboard within a second" — is satisfied
by *the refetch this triggers*, and the test asserts the refetch (MSW request count), not a cache
value. That is the difference between testing the mechanism and testing a coincidence.

#### 6.5 Fallback, and the honest badge

If the stream cannot connect (two failed attempts inside 10 s) the client degrades to polling:
`refetchInterval: 30_000` on the consent-bearing queries, `refetchIntervalInBackground: false`, and
the badge in the shell changes from "Live" to "Polling" — because a customer looking at a
transparency screen deserves to know whether the screen is live or a minute old. The polling gate
`streamStatus === 'polling' && !isMutating` (§5.6) is part of the contract, not an optimisation.
A stream is never assumed: everything in §4 has to be true with the stream down, which is also why
the invalidation table exists independently of §6.

#### 6.6 Cross-tab

The `BroadcastChannel` that coordinates refresh (ADR-0002 §4) also carries the hint envelope between
tabs of the same origin, so an approve in tab A does not leave tab B's queue stale until focus. The
receiving tab **invalidates** — the channel is a transport for hints, and the same rule as §6.1
applies: a cross-tab message is a reason to re-read, never a value to store. Logout broadcasts too
(§7.6).

### 7. Zustand: the stores we will actually have

Zustand is not a small Redux. It is a hook-shaped store with no provider, no actions/reducers
duality, and — the reason it wins here — **`getState()` is callable from non-React code**, which is
what lets the query error handler raise a toast and the stream client publish a status without
threading a context through the app.

#### 7.1 The inventory, with lifetimes

| Store | State | Reset trigger | Persisted |
|---|---|---|---|
| `useApprovalDraftStore` | `requestId`, `step`, `toggles`, `expiresAt`, `denyReason` | Route change, `requestId` change, successful decision, logout | ❌ |
| `usePanelStore` | `openPanel`, per-panel uncommitted draft values | Route change, Apply/Cancel, logout | ❌ |
| `useSelectionStore` | `selectedIds: Set<string>` for bulk actions | Route change, after the bulk mutation, logout | ❌ |
| `useToastStore` | queue of `{id, kind, message}` | TTL per toast, logout | ❌ |
| `useStreamStatusStore` | `'connecting' / 'live' / 'polling' / 'offline'` | Logout | ❌ |
| `useSessionUiStore` | `idleWarningDismissed`, `stepUpPromptOpen` | Logout, successful re-auth | ❌ |
| `usePrefsStore` | `theme`, `density`, `reducedMotion`, `tablePageSize` | Never (device preference) | ✅ allowlist (§7.6) |

`resetClientState()` calls `reset()` on every store; it is called from the logout path and from
nothing else.

#### 7.2 The wizard draft, keyed by its subject

```ts
// apps/web/src/state/approvalDraft.ts
type ApprovalDraft = {
  requestId: string | null;                 // the server id this draft belongs to
  step: 1 | 2 | 3;
  toggles: Record<string, boolean>;         // data-category code → included (default OFF where the
                                            // server flags requiresExplicitOptIn)
  expiresAt: string | null;                 // ISO-8601 date the customer picked
  denyReason: string;
  start: (requestId: string) => void;       // resets everything when the id changes
  setToggle: (code: string, on: boolean) => void;
  setExpiry: (iso: string | null) => void;
  setDenyReason: (text: string) => void;
  next: () => void;
  back: () => void;
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
  /* … */
}));
```

Three properties this shape buys, all of them tested in #58/#60:

- **The draft is the delta the customer is composing; the subject of the draft is server state.**
  The FIU's name, the purpose, the notice text, the category list's *labels* and the current expiry
  all come from `usePendingRequest(id)` / `consentKeys.notice(id)`. The store holds only what the
  customer has decided so far. That is why a stale store can never show the wrong FIU.
- **`start(requestId)` is idempotent per subject**, so navigating between two pending requests
  cannot leak one customer's toggle choices into another's approval — the bug that a single global
  `toggles: {}` produces on the second request.
- **Route-change reset is explicit** (#58's acceptance criterion: "the Zustand wizard draft does not
  survive a route change unintentionally"): the route component calls `start(id)` on mount and
  `reset()` on unmount, and a test navigates away and back and asserts an empty draft.

#### 7.3 `useState` versus Zustand: the tie-breaker

> **A value goes to Zustand when two components that are not parent and child render it, or when it
> must outlive the component that owns it. Otherwise it is `useState`.**

That is why the sidebar's collapsed flag is a store (the shell header and the nav both render it)
and why a modal's open flag is `useState` (only the trigger and the modal's own subtree care). And
why the access-log panel's *draft* is a store: the panel's Apply button lives in a footer that is a
sibling of the panel, and the badge "2 filters applied" is in the header — three consumers, one
value. A store with one consumer is a review comment: "why not `useState`?"

Corollary for selectors: components subscribe to the narrowest slice
(`useApprovalDraft((s) => s.toggles[code])`) and use `useShallow` when the selector returns an
object or array. A selector that returns a fresh object on every render re-renders the subscriber on
every store write — the one Zustand footgun that shows up as a jank bug rather than an error.

#### 7.4 Store hygiene

- **No derivation in the store.** `canRevoke`, `allCategoriesOff`, `stepCount` are computed in
  selectors or by `packages/ui` components, from the store's inputs and the query cache. Storing a
  derived value means every mutation path must remember to recompute it (§2.4's badge).
- **Actions are the only writers.** Components call `setToggle`, not `set({ toggles: … })`; the
  store file is where invariants (an OFF toggle for a category that requires explicit opt-in cannot
  become ON without the customer's action) are enforced once.
- **`devtools` middleware in dev only**, named after the store, so a UI bug is diagnosable without a
  rebuild.
- **Components in `packages/ui` are state-agnostic.** They take value/onChange/children props and
  import neither `@tanstack/react-query` nor `zustand` (#59). The shared library is the one place
  where "which store?" must never be a question — and where a boundary lint (§9) keeps it that way.
  (`pnpm-workspace.yaml` does not yet include `packages/*`; #54 adds it when `packages/ui` lands.)

#### 7.5 What a store may never hold

- **Server entities.** No `Consent`, `ConsentRequest`, `DataAccessLog` or generated API type in any
  store's state — only ids, codes, booleans, numbers and the user's own input. Enforced by the
  boundary test in §9, not by review alone.
- **Credentials and authorisation claims.** `roles`, `customerId`, the access token: module scope
  (ADR-0002 §2). A role list in a store is a stale-authority bug and an XSS target.
- **Anything about a person other than the current user's own input.** An agent's "recent customers"
  list, a cached customer name in a filter panel, a pasted account number: all forbidden. Personal
  data in the browser is a retention and a leak decision, and §7.6 gives the two places it is
  allowed to exist — the Query cache (bounded by `gcTime` and cleared on logout) and the user's
  in-progress input (never persisted).

#### 7.6 Persistence allowlist, and logout

```ts
// Only these four, only in usePrefsStore, only via `persist` with an explicit partialize.
persist(store, {
  name: 'ch.prefs.v1',
  partialize: (s) => ({ theme: s.theme, density: s.density, reducedMotion: s.reducedMotion,
                        tablePageSize: s.tablePageSize }),
})
```

- **No `persistQueryClient`.** It is a convenient, well-documented library feature and it is
  rejected for the reason ADR-0002 §8 gives about `localStorage` with the same force: it writes
  personal data to disk, it survives logout, and it is readable by any script on the origin. The
  Query cache is in-memory only, and its `gcTime` (§3.1) is the retention clock.
- **No draft persistence.** The approval draft contains a decision about a person's data; it lives
  in memory, and a reload losing it is the correct outcome.
- **Filters with identifiers go to the URL, not to storage.** `?customerId=…` in the address bar is
  the user's own deliberate action; the same value in `localStorage` is an undeclared retention.
- **Logout** (ADR-0002 §5 step 4, extended by this ADR): clear the in-memory token,
  `queryClient.clear()`, `resetClientState()`, broadcast the logout on the `BroadcastChannel`,
  redirect to `/login`. A principal change (login as a different user in the same tab) runs the same
  sequence, so no cache entry from the previous principal can be observed by the next one.

### 8. Enforcement: the boundary has tests, not just prose

ADR-0003's ledger is append-only because a grant and a test say so. The frontend equivalent is
cheaper but the same in kind — the rules above are asserted by tests in the suite, and one of them
is a negative control:

1. **Boundary test** (`src/state/stateBoundary.test.ts`): no file under `src/state/**` imports from
   `src/api/**`, the generated client, `@tanstack/react-query` or `zod`; no store's exported types
   reference a generated API entity; and no file outside `src/api/**` contains a query-key array
   literal. A fixture file with a deliberate violation is scanned alongside, so the test proves it
   bites rather than asserting an empty set forever (the same pattern as ADR-0003 §6.3's violation
   fixture).
2. **The invalidation test** (§4.4) — MSW request counts per mutation, one case per row of §4.1.
3. **The draft-isolation tests** — route change clears the draft (#58); switching `requestId` starts
   a fresh draft (§7.2).
4. **The optimism tests** — #62's "shows revoked immediately and rolls back on a 500", plus the
   inverse assertion: an approve mutation performs **no** cache write before its response resolves
   (§5.5).
5. **The no-persistence test** — after a logout, `localStorage` contains exactly the `ch.prefs.v1`
   key, and it contains none of the strings from the seeded customer's data.
6. **The audit viewer test** — focusing the window on `/audit` issues no request (§3.3), because
   that request would write a ledger row.

### 9. Worked examples: "where does this go?" in 60 seconds

| The state | Answer | The rule that decides it |
|---|---|---|
| "Which tab of the consent detail screen is open" | URL (`/consents/:id?tab=access`) | Q2 — a link should restore it |
| "Which categories the customer has toggled off in the wizard" | Zustand draft | Q3 — the footer summary renders it |
| "The FIU's legal name and the notice text for that request" | Query (`requestKeys.detail(id)`) | Q1 — the server owns it |
| "Whether the revoke button is disabled while in flight" | `mutation.isPending` | Not state at all — it is the mutation's own status |
| "The number of pending requests in the nav badge" | Derived from `requestKeys` | §2.4 — never stored |
| "The date range typed into the access-log filter but not yet applied" | Zustand draft (or `useState` if the panel owns it) | Q3 |
| "The date range that *is* applied" | URL | Q2 — #63 asserts query params |
| "The sidebar collapsed state" | Zustand, persisted | Q3 + §7.6 allowlist |
| "The access token" | Module scope | Not renderable state; it is a credential (ADR-0002 §2) |
| "Which consent rows are ticked for bulk assignment" | Zustand selection | Q3 — the toolbar and the table both read it |
| "The last time the dashboard data was updated" | `dataUpdatedAt` | §2.4 — already exists |
| "The alert shown after a failed revoke" | Zustand toast queue | Raised from non-React code (the mutation cache handler) |

### 10. What this costs

- **Two places to look, one rule to know.** A developer who does not internalise §1 will try to put
  a fetched list in a store "because it is already there". The boundary test catches the mechanical
  case; the review question "who can change this value?" catches the rest.
- **Invalidation discipline is real work.** Every new mutation and every new read model is a row in
  §4.1, and a missed row is a stale screen that no type checker will find. The MSW count tests are
  the mitigation and they cost ~10 minutes per feature.
- **Optimism adds a code path that only runs on failure**, which is exactly the code path nobody
  tests by hand. Hence #62's 500 and 409 cases being acceptance criteria rather than suggestions.
- **The stream is more client code than `new EventSource(url)`.** §6.3's reconnect logic exists
  because the token is a header and the cookie is path-scoped (ADR-0002 §2–§3); that is a real
  ~100 lines bought with the auth model's guarantees.
- **`staleTime: 30 s` is a guess that will be revisited.** It is written here as a number so it can
  be argued with; the alternative — leaving it to each screen — is how two screens end up with
  different definitions of "current".

## Consequences

**Positive**

- **The stale-consent class of bug is designed out.** There is one copy of every server fact, it is
  owned by a library whose job is invalidation, and §4.1 enumerates what each mutation must refresh.
- **The UI cannot lie about consent.** Approve and resume are pessimistic; optimistic patches may
  only narrow; the failure sentence for a failed revoke is "the consent is still active" (§5.4).
- **Every screen's state has a home with a name**, so "where does this go?" has an answer that does
  not depend on who is in the room (§1, §9), and the answer is testable rather than stylistic.
- **Freshness policy is expressed in the product's terms.** The audit viewer's exception exists
  because reads are audited (ADR-0003 §13.2); the notice's `staleTime: Infinity` exists because the
  pin is immutable (§3.3). Two ADRs end up reinforcing each other instead of contradicting.
- **The stream is a latency optimisation, not a dependency.** Because it only invalidates, the app
  is correct with the stream down, which is what makes #78's polling fallback cheap and its
  "within a second" criterion testable.
- **Testability falls out of the design.** Request counts, cache state, and store resets are all
  assertable with MSW and RTL; "the cache is coherent" never has to be.

**Costs / trade-offs**

- **Two libraries, two mental models, one rule to keep.** Accepted: the alternative is one library
  and two mental models, where the cache and the store both claim to own a value.
- **`gcTime` and `staleTime` are retention and freshness decisions living in a config object.** They
  are one 12-line function (§3.1) so a change is reviewable, and the review question is "what does
  this mean for a customer looking at their data?", not "is it fast".
- **The invalidation table must be maintained by hand.** It is 10 lines and it is the single most
  valuable 10 lines in the frontend, but it is not generated from anything.
- **`queryClient.clear()` invalidates the one thing a mutation's `onSettled` must not race with.** A
  mutation that settles after logout would re-invalidate an empty cache — harmless, but the logout
  path cancels outstanding queries first for tidiness.
- **Zustand's flexibility is also its failure mode**: a store can hold anything, including a
  `Consent`. §7.5 and §8 are the wall, and they are thinner than ADR-0003's grant — a lint test, not
  a database privilege.
- **The demo's "live" feeling depends on the BFF's stream being up.** The fallback is honest rather
  than seamless (§6.5): the badge says "Polling", and a 30 s poll is more latency than a demo wants.

## Alternatives considered

### Redux Toolkit (+ RTK Query) — rejected

The default answer, and the one the JD bullet is usually testing for. It would work; it is rejected
for this codebase for three specific reasons and one honest loss.

1. **Server-state duplication is structural, not accidental.** Redux's centre of gravity is a single
   serialisable store that every feature contributes to. In that model, the consent list is
   naturally a slice, and RTK Query's cache is *also* holding it — so the same fact exists twice,
   with the slice usually winning because it is easier to read from. The rule this ADR exists to
   state ("no server data in a client store") is exactly the rule a Redux organisation erodes: the
   store is already there, and `consentsSlice` is one file away.
2. **Invalidation becomes hand-written.** RTK Query models invalidation with `providesTags` /
   `invalidatesTags`: coarse, explicit tag lists that must be re-derived for each read model. The
   hierarchy here — consent → detail → timeline → access log → notice → dashboard aggregate →
   pending requests — is a *tree*, and TanStack Query's key-prefix invalidation expresses it
   directly (§4.3). With tags, "revoke invalidates the consent, its timeline, its access log, the
   list, the request list and the BFF aggregate" is a tag string that must be kept in sync with the
   key it stands for; with keys, the invalidation *is* the key, and the boundary test can prove keys
   stay in `keys.ts`.
3. **The optimistic-update ergonomics are what we need least and were the tie-breaker.**
   `onQueryStarted` + `patchResult.undo()` is genuinely good. But TanStack Query gives
   `cancelQueries`, `getQueriesData`/`setQueriesData` and a returned `context` that make §5.2 a
   nine-line snapshot and a four-line rollback; Redux adds `configureStore`, slices, `extraReducers`
   glue, and an `immer`-based reducer style for state that is, per this ADR, mostly *not* Redux's
   business.
4. **Honest loss: DevTools.** Redux's time-travel debugger is the best in the ecosystem. We trade it
   for Query Devtools (cache and invalidation visibility, which is what actually needs debugging
   here) and Zustand's `devtools` middleware (per-store action log). For this app's failure modes —
   stale cache and a wrong invalidation — the Query devtools are the better instrument.

The related rejection stands on its own: **RTK Query alone (no hand-written slices)** solves (1) and
much of (2), and it is the strongest version of the Redux answer. It loses on §3.2, §3.5 and §6: a
typed, contract-derived key factory, a `QueryClient` that non-React code (the stream client, the
logout path) can drive, and a key-prefix invalidation model that the stream's hint map can reuse
directly rather than translating into tags.

### Everything in Zustand (fetch in a `useEffect`, store the result) — rejected

The smallest dependency count and the fastest first screen. **Why it lost:** it is a hand-written
cache, which means hand-written deduplication, cancellation, retry, refetch-on-focus,
refetch-on-reconnect, staleness and invalidation — the last of which is the one that bites, because
a missing invalidation is invisible until a customer sees a consent that is not theirs to give. It
is also the exact design that produces this ADR's opening failure mode, at scale.

### Everything in Query (UI state in the query cache) — rejected

`useQuery({ queryKey: ['wizard'], queryFn: () => null })` or `setQueryData(['ui'], …)` is a real
pattern and it "works" for a demo. **Why it lost:** the cache's lifetime policy is wrong for UI
state (`gcTime` could silently drop a half-completed draft; any `invalidateQueries` prefix that
overlaps `['ui']` wipes it), the invalidation contract becomes unverifiable when keys stop meaning
"a server resource", and a draft that looks like cached server data will eventually be persisted,
logged or serialised by someone who reasonably assumed it was one.

### Context + `useReducer` for all UI state — rejected

No dependency, standard React. **Why it lost:** a context provider re-renders every consumer on any
change, which is why large apps end up splitting one logical store into a provider per concern and
then re-implementing selectors; and a context value is unreachable from outside React, which the
toast path and the stream status both need. `useReducer` + context remains the right answer *inside*
one screen (a form's local state), which is why §7.3 keeps `useState` in the toolbox.

### SWR — rejected

A close competitor with a smaller API. **Why it lost:** invalidation is keyed by hand-built strings
with no typed factory and no hierarchical prefix model (the `mutate(['consents'])` glob is a string
match, not a tree), `useMutation`'s optimistic context is thinner, and the two SPAs would then use a
different mental model from the tests and from the BFF's own caching notes. TanStack Query is also
what the plan names, and consistency across an eight-week build is worth more than a smaller bundle.

### Persisting the Query cache (`persistQueryClient` / `localStorage` hydration) — rejected

Instant boot with data on screen. **Why it lost:** identical reasoning to ADR-0002 §8, and the same
conclusion — personal data on disk outlives the session, is readable by any script on the origin,
and cannot be revoked server-side. The boot cost we accept instead is one round trip and a loading
state, which the shells already have (#56).

### Optimistic everywhere (including approve) — rejected

It makes the demo feel fastest. **Why it lost:** it inverts the product's central claim (§5.1) and
it is not a rendering bug but a compliance one: the customer's screen would assert that consent was
given before the ledger's `CONSENT_APPROVED` row exists (ADR-0003 §12.2).

### Writing SSE events into the cache — rejected

The obvious optimisation, since the event arrives before the refetch completes. **Why it lost:**
§6.1's four failure modes, of which the first is decisive: a missed event under a write-from-stream
client is *permanent* wrongness with no self-healing path, while an invalidation is corrected by the
next read. The perceived cost — one extra round trip inside the second #78 allows — is the price of
the cache never being able to disagree with the ledger.

### XState for the approval wizard — deferred, not rejected

A multi-step approval flow with guards is exactly what a state machine is for, and #31's backend
state machine is the precedent for taking that seriously. It is deferred because this flow is three
linear steps with a draft and no branching guard: ~40 lines of Zustand against a new runtime
dependency and a second state-management vocabulary in the same PR. **The trigger to revisit is
written down**: a fourth step, a conditional step, or a transition that depends on more than one
field. #59's `Stepper` component takes `step` + `onStepChange` and does not care which store is
behind it.

### A shared `packages/state` across both apps — rejected for now

Both apps read the same API, so sharing a key factory and a `QueryClient` factory looks free.
**Why it lost:** the two apps differ exactly where caching policy matters — the ops console's reads
are audited and role-scoped, its idle timeout is 15 minutes (ADR-0002 §6), and its screens cache
other people's data on a back-office terminal. A shared package would have to be parameterised by
audience to be correct, which is a worse abstraction than two files that follow this ADR. Extraction
is revisited when a third consumer with the *same* authorisation semantics appears; note that
`pnpm-workspace.yaml` does not yet include `packages/*`, which #54 adds when `packages/ui` lands.

## Consistency with the contract

Per ADR-0001 the contract is `contract/openapi/consenthub-api.yaml` and the frontend consumes
generated types from it (#58). The client cannot invent endpoints, and this ADR cannot invent cache
keys for operations that do not exist yet — so the following is what #26 must land for §3–§6 to be
implementable as written. Nothing here changes the contract today; the current file has only six
operations and no list parameters, so there is no drift to record yet.

| ADR clause | Contract element #26 must add | Why the client needs it |
|---|---|---|
| §3.2 keys are built from operation params | Query parameters on the list operations: `GET /consents` (`status`, `fiuId`, `purposeCode`, `sort`, `page`, `size`), `GET /consent-requests` (`status`, `page`), `GET /audit` (`from`, `to`, `actorType`, `eventType`, `consentId`, `page`), `GET /consents/{id}/access-log` (`from`, `to`, `category`), `GET /dsar` (`status`, `breachedOnly`), `GET /approvals` (`status`, `page`) | Filters live in the URL (§2.2), the URL is the key, and the key's type is the operation's params — a filter that changes the response but not the key is the bug §3.2 exists to prevent |
| §5.4 (409 vs 5xx) | `Consent.version` (or `ETag`/`If-Match`) and a documented `409` `Problem` for a stale version | #62's acceptance criterion is a *specific* conflict message; without a version on the wire the client cannot tell an optimistic-locking conflict from a validation failure. ADR-0003 §8.1 already puts `@Version` on the artefact, so this is the mapping, not new behaviour |
| §2.1 (both apps' reads) | `GET /consents/{id}/events` (#37), `/access-log` (#40), `/notice` (#64), `GET /dsar` (#44), `GET /approvals` (#45), `GET /audit` + `/export.csv` (#46), `GET /fiu` (#42) | One query per read model in §2.1; a screen with no operation has no cache entry |
| §3.5 (exports are commands) | `GET /audit/export.csv` returns `text/csv` with a `Content-Disposition` filename | The client streams it to a blob and never caches it |
| §4.1 (invalidation needs a decision endpoint) | `POST /consent-requests/{id}/approve` (#34), `/deny` (#35), `POST /consents/{id}/revoke` (#38), `/pause`, `/resume` (#39), `POST /approvals/{id}/decide` (#45) | The mutation half of the contract; a mutation without an operation cannot declare an invalidation set |
| §3.4 + §2.4 | `updatedAt` (or `version`) on consent-bearing read models | A freshness indicator and a conflict message both come from the payload, not from a client-computed timestamp |
| §5.1 (widenings are pessimistic) | No change | The rule is client-side |
| §6 | **Nothing.** `GET /events` (#78) is a BFF endpoint, not a backend one | Recorded deliberately: the stream is not part of the backend contract, its envelope is defined once in `apps/web/src/api/stream.ts`, and the BFF's README documents it. If the backend ever exposes a stream, the envelope should move into the contract instead — the vocabulary is already ADR-0003 §4's |

Two recorded disagreements, not silently resolved:

- **`Consent.status` is `granted | revoked | expired` in the contract while #17/#31 and ADR-0003 §8
  have five states** (`PENDING | ACTIVE | PAUSED | REVOKED | EXPIRED`). ADR-0003 already put this on
  record as #26's fix. The frontend consequence: the status→pill map (#59) is a total
  `Record<Consent['status'], Pill>` with a `never`-checked default branch, so the day #26 widens the
  enum the build fails at the map instead of the screen rendering an unstyled pill.
- **The contract has no pagination parameters**, only `ConsentPage.total`. §4.3's `keepPreviousData`
  and #61/#73's "pagination or virtualisation" criteria both assume `page`/`size`; #26 owns them.

## Ticket contract — how this lands in week 3, and what proves it

This ADR is decision-complete on purpose: the week-3 and week-4 tickets should be transcriptions,
not decisions. §4.1's table, §3.2's key factory and §7.1's inventory are the wiring #58 asks for.

| Ticket | Must contain, from this ADR | The check that proves it |
|---|---|---|
| **#57** login / silent refresh / logout | `queryClient.clear()` + `resetClientState()` + logout broadcast on the logout path (§7.6); the principal and token in module scope (§1, §7.5) | Test: after logout the cache is empty, every store is reset, and no principal data remains observable |
| **#58** typed client + Query/Zustand wiring | `createQueryClient()` with §3.3's numbers; `keys.ts` as §3.2; `invalidation.ts` as §4.1; the §7.1 stores; the §8 boundary test | Its own acceptance criteria — generated client in CI, MSW request count after revoke, the draft does not survive a route change, no server data in Zustand — plus the boundary test as a third check |
| **#59** component library | Components import neither Query nor Zustand (§7.4); status→pill map total over the contract's status union with a `never` check | Boundary lint on `packages/ui`; `tsc` fails when the enum grows (after #26) |
| **#60** pending review screen | Draft in `useApprovalDraftStore` (§7.2); approve and deny **not** optimistic (§5.5); pending indicator from `mutation.isPending`; "already decided" state from the request detail | Its AC tests, plus a test asserting no cache write occurs before the approve response resolves |
| **#61** dashboard | Query reads with `keepPreviousData`; filters/sort in the URL; counts derived, never stored (§2.4) | Its "filters compose" tests read/write `searchParams`; the no-layout-shift test |
| **#62** revoke flow | §5.2's hook verbatim; the four error paths of §5.4 with their four sentences; confirmation before optimism | Its three AC tests: optimistic + rollback on 500, the 409 message, keyboard-safe confirmation |
| **#63** access-log timeline | `consentKeys.accessLog(id, window)` with the window in the key (§3.2); applied filters in the URL | Its AC test: the date-range filter issues the right query params |
| **#64** notice viewer | `staleTime: Infinity` for the pinned notice (§3.3); the pinned body from the artefact's `notice_version` (ADR-0003 §9) | Its AC test with MSW fixtures: the old consent shows the version in force at approval |
| **#65** test harness | `createQueryClient({ retry: false })` per test; `queryClient.clear()` in teardown; MSW handlers from the contract's examples; coverage on `src/features/**` | The coverage gate, the suite's runtime budget, and a test that fails if the harness shares a cache across specs |
| **#69** ops shell + search | Input text local; debounced term in the key and the URL (§3.2, §9); nav badge from the pending-count query; the reason-for-access prompt is session state, never persisted (§7.6) | Its AC: the lookup writes an audit event with a reason and the search is reproducible from the URL |
| **#71** approvals queue | `approvalKeys` + `targetKeys(taskType)` union invalidation (§4.2); maker's own tasks not decidable | Its AC: a decision triggers the underlying action and the queue updates (MSW counts) |
| **#72** DSAR queue | Countdown derived from `dueAt` (§2.4); bulk selection in `useSelectionStore`, cleared on route change and after the bulk call | Its AC: the countdown renders correctly for due/nearly-due/breached with fake timers |
| **#73** audit viewer | `staleTime: 60 s` + `refetchOnWindowFocus: false` because **reading is audited** (ADR-0003 §13.2); filters in the URL; export as a `useMutation` + blob, never cached (§3.5) | Its AC: the CSV matches the visible filters; a focus event issues no `GET /audit` |
| **#77** BFF aggregate | `dashboardKeys` on every consent-state mutation (§4.2); BFF cache invalidated on the same mutation path; the client invalidates regardless | Its AC: one dashboard request, and no stale consent after revoke/approve |
| **#78** SSE | §6 verbatim: hint envelope of ids and codes; hint→key map; coalescing; resync on reconnect; polling fallback gated on `!isMutating()`; status badge | Its AC: the invalidation path is tested (MSW count, not a cache value), and "revoking in another tab updates the dashboard within a second" is asserted as a refetch |
| **#54** LESS tokens / `packages/ui` | Add `packages/*` to `pnpm-workspace.yaml` when the package lands; `packages/ui` imports neither Query nor Zustand (§7.4) | Build + the boundary lint from §8 |
| **#26** contract | The elements in "Consistency with the contract", above all `version` on `Consent` and query parameters on the list operations | Contract lint, regenerated clients compile, and the status-enum map fails `tsc` when it widens |

What this ADR explicitly does **not** ask anyone to build: no shared frontend state package
(§Alternatives), no `EventSource` wrapper pretending to set headers (§6.3), no cache persistence
(§7.6), no `invalidateQueries()` without a key outside logout and post-reconnect resync (§4.3).

## References

- Issue #4 — this ADR's task list; #58 (the wiring this document specifies), #56–#65 (week 3,
  customer portal) and #69–#73 (week 4, ops console), #77–#78 (the BFF aggregate and the SSE
  stream), #26 (the contract surface §3–§6 assume), #65 (the test harness §8's enforcement runs in).
- ADR-0001 — the contract is a root-level artifact; the client is generated from it, which is what
  makes §3.2's keys contract-derived.
- ADR-0002 — §2 (access token in memory, never storage), §3–§4 (rotation, single-flight refresh,
  `BroadcastChannel`), §5 (logout clears the cache and resets the stores — amended by §7.6 here), §6
  (ops-console idle timeout and step-up, which §5.4's 428 path and §7.1's session store implement).
- ADR-0003 — §4 (the event vocabulary the stream speaks), §8 (the `@Version` conflict behind 409,
  and substance-by-lineage behind §5.3), §9 (the immutable notice pin behind `staleTime: Infinity`),
  §12.2 (no state change without its ledger row — the reason the UI may never get ahead of the
  server), §13.2 (reads are audited — the reason the audit viewer does not refetch on focus).
- ADR-0005 (persistence, #12) and ADR-0007 (where Node.js belongs, #68) — not directly referenced
  here, but the generated client and the BFF's aggregate endpoint assume both.
- TanStack Query documentation — *Important Defaults*, *Query Keys*, *Invalidations from Mutations*,
  *Optimistic Updates* (`cancelQueries`/`getQueriesData`/`setQueriesData`).
- Zustand documentation — `persist` with `partialize`, `useShallow`, `getState` outside React.
- Redux Toolkit / RTK Query documentation — `providesTags`/`invalidatesTags` and `onQueryStarted`;
  read for the rejection in Alternatives, not as the design.
