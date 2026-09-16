# ADR-0002: Authentication and session model

- **Status:** Accepted
- **Date:** 2026-09-15
- **Deciders:** ConsentHub engineering
- **Tags:** architecture, security, authentication, sessions, contract

## Context

Three kinds of caller have to be authenticated by the same backend:

- The **customer portal** SPA (`apps/web`) — role `CUSTOMER`. Owners of the financial data.
- The **ops console** SPA (`apps/portal`) — roles `AGENT`, `SUPERVISOR`, `ADMIN`. People who
  approve consents, run DSARs and read the audit ledger on other people's behalf.
- The **FIU service account** — a machine client that raises consent requests and fetches
  artefacts. No human, no browser.

The backend is Spring Boot serving a stateless REST API with a deny-by-default filter chain
(issue #27), backed by MySQL 8 and Redis (issue #6). The OpenAPI contract is the single source
of truth for both halves (ADR-0001), so whatever we choose has to be expressible in the
contract, or the generated clients will not enforce it.

The binding constraints:

1. **XSS must not equal account takeover.** The portal renders consent notices whose text is
   authored upstream and versioned (issue #64). We assume XSS is possible and design so that a
   successful script injection does not hand over a long-lived credential.
2. **Revocation must be immediate for security events.** A consent platform has to be able to
   cut an actor off mid-session — an agent under investigation, a customer who just filed an
   erasure request, a replayed refresh token. "It expires in a few minutes" is not an answer
   when the actor can approve a consent in one request.
3. **Every audit event must be attributable to a session, not just a user.** ADR-0003 makes the
   ledger append-only; "user 42 did it" is weaker evidence than "user 42, session `9f1c…`, from
   this IP, did it".
4. **Both SPAs are separate origins but the same site**, and both call the same API origin. The
   session model has to survive two clients sharing one browser cookie jar.
5. **The ops console is a shared-terminal, back-office environment.** Idle sessions on a
   machine in a support centre are the realistic threat, not just a stolen laptop.

## Decision

**Short-lived JWT access token carried in `Authorization: Bearer` and held in memory only, plus
a rotating refresh token in an `httpOnly` + `Secure` + `SameSite=Strict` cookie, with
reuse detection that revokes the whole token family.**

### 1. Credentials and TTLs

Every number below is a configuration default; nothing here is "short" or "long".

| Credential | Value | TTL | Where it lives |
|---|---|---|---|
| Access token (JWT) — human clients | `Authorization: Bearer` | **300 s (5 min)** | SPA memory only (module scope) |
| Access token (JWT) — FIU service account | `Authorization: Bearer` | **900 s (15 min)** | Caller's process; no refresh token |
| Refresh token — customer portal | cookie `ch_rt_cus` | **43 200 s (12 h)**, sliding: each rotation issues a fresh 12 h | `httpOnly` cookie |
| Refresh token — ops console | cookie `ch_rt_ops` | **900 s (15 min)**, sliding: each rotation issues a fresh 15 min. This *is* the agent idle timeout. | `httpOnly` cookie |
| Token family absolute cap — customer | — | **259 200 s (72 h)** from first login, then forced re-authentication | server-side row |
| Token family absolute cap — ops console | — | **28 800 s (8 h)** from first login, then forced re-authentication | server-side row |
| Redis deny-list entry for a revoked session | `sid:<familyId>` | **300 s** (equal to the access-token TTL, so entries self-expire) | Redis |
| Step-up re-authentication validity (ops console) | — | **300 s (5 min)** since last credential entry | server-side session state |
| JWT signing-key rotation | RS256, `kid` in the header | rotate every **90 days**, previous `kid` accepted for a further **7 days** | JWKS endpoint |
| Clock-skew tolerance | `exp` / `nbf` | **30 s** | — |
| Expired-token cleanup job | — | hourly; deletes rows expired more than **86 400 s (24 h)** ago | scheduled job |

Login hardening, so the credential itself is not the weak point:

- Passwords are BCrypt, **cost 12** (issue #20 requires ≥ 10).
- **5** failed attempts per **900 s (15 min)** per username, and **20** per **900 s** per source
  IP (Redis counters); lockout lasts **900 s (15 min)** and is recorded as a `SECURITY_LOGIN_LOCKOUT`
  event (ADR-0003 §4 names the ledger's vocabulary).
- Failures return one generic message. No user enumeration, no "wrong password" vs "no such
  user" distinction (issue #57).

### 2. Access token

A signed JWT (RS256, 2048-bit, `kid` published on the JWKS endpoint) carrying
`iss`, `aud`, `sub` (user id), `sid` (the token family id), `roles[]`, `customerId` or `fiuId`,
`jti`, `iat`, `nbf`, `exp`. It is:

- **sent as `Authorization: Bearer`**, never as a cookie;
- **held in module scope in the SPA** — a variable in a closure, never `localStorage`, never
  `sessionStorage`, never IndexedDB;
- **lost on page reload by design.** On boot the app calls `POST /api/v1/auth/refresh` once to
  rehydrate silently, and renders a loading state until it resolves (issue #57).

Roles are read from the token, so a role change takes effect at the next access-token issue —
within **300 s**. Removing a role entirely is not left to expiry: it goes through the family
revocation path in §5, which takes effect immediately.

### 3. Refresh token and the cookie

The refresh token is **opaque**, not a JWT: 256 bits from a CSPRNG, base64url-encoded. The
server stores only its **SHA-256 hash**, so a database read does not yield usable tokens.

Each row records: `token_hash`, `family_id`, `generation`, `user_id`, `audience`, `status`
(`ACTIVE` / `ROTATED` / `REVOKED`), `issued_at`, `expires_at`, `replaced_by_hash`,
`source_ip`, `user_agent`.

Cookie attributes, identical for both clients except the name:

```
Set-Cookie: ch_rt_cus=<token>; Path=/api/v1/auth/refresh; HttpOnly; Secure; SameSite=Strict
```

- **`HttpOnly`** — no script on the origin can read it. This is the whole point.
- **`Secure`** — never sent over plaintext, including in dev unless the dev host is TLS.
- **`SameSite=Strict`** — not sent on any cross-site request. Strict costs us nothing here
  because this cookie is only ever sent by a `fetch` from our own SPA origin to our own API
  origin (`app.consenthub.example` → `api.consenthub.example` is *same-site*: SameSite is about
  the registrable domain, not the origin, and ports are ignored). It is never carried on a
  top-level navigation, which is the usual UX penalty of `Strict`.
- **`Path=/api/v1/auth/refresh`** — the browser attaches it to that one endpoint. It does not
  travel on `GET /api/v1/consents`, so it does not appear in proxy logs, traces or referers for
  ordinary traffic.
- **Distinct names per audience** (`ch_rt_cus`, `ch_rt_ops`) — both SPAs share one cookie jar
  for the API origin. One shared name would mean logging into the ops console silently destroys
  the customer session. Each refresh request declares its audience in the JSON body and the
  server reads only the matching cookie, so one person can be signed into both at once.

Refresh tokens **rotate on every use** (§4) — no refresh token is ever valid twice.

One client-side detail that is easy to lose: the cookie lives on the API origin while the SPAs
are separate origins, so the refresh call must be sent with credentials —
`credentials: 'include'` for `fetch`, `withCredentials: true` for axios. **The generated client
does not do this for you.** Generating from the current contract with orval produces a `refresh`
function with no `withCredentials` anywhere in it, so both SPAs must set it in their axios/fetch
mutator (issue #58) or the browser silently omits the cookie and every refresh looks like a
logged-out session.

### 4. Reuse detection — the explicit sequence

**Happy path** — `POST /api/v1/auth/refresh`:

1. Browser sends the request with `Content-Type: application/json`, body
   `{"audience": "customer-web"}`, and the `Path`-scoped cookie is attached automatically.
2. Server reads only the cookie matching `audience`, SHA-256-hashes the presented token, and
   looks up the row.
3. The row must satisfy **all** of: exists; `status = ACTIVE`; `expires_at > now`;
   `audience` matches; and the family's oldest `issued_at` is inside the absolute family cap
   (72 h customer / 8 h ops). Anything else is a plain `401 invalid_grant` — **an expired token
   is a normal idle timeout and raises no security event.**
4. In a single DB transaction: set the presented row to `ROTATED` with
   `replaced_by_hash = <new token>`; insert a new row with `generation + 1`, `status = ACTIVE`,
   a fresh TTL, and the caller's `source_ip` / `user_agent`.
5. Issue a new access token (300 s) and `Set-Cookie` the new refresh token with the same
   attributes. The presented token is now dead forever.

**Reuse path** — a token whose row is already `ROTATED` (or `REVOKED`) is presented. This is
the attack case: someone copied the token before rotation and is replaying it.

1. Client presents `T_n`. The server hashes it and finds a row with `status = ROTATED` —
   meaning `T_n` was already exchanged for `T_n+1` at some earlier time.
2. The server treats this as **token theft, not a retry**. There is no legitimate way to hold a
   rotated token, because the client that used it received its replacement.
3. The server revokes the **entire family** in one statement —
   `UPDATE refresh_token SET status = 'REVOKED' WHERE family_id = :familyId` — which kills
   `T_n+1` and every descendant, including the one the legitimate user is currently holding.
   We cannot tell which of the two parties is the thief, so both lose the session. That is the
   intended outcome: fail closed, and let the human re-authenticate.
4. The server pushes `sid:<familyId>` into the Redis deny-list with a **300 s** TTL, so access
   tokens already issued for that family stop working on their next request instead of living
   out their remaining five minutes.
5. The server appends a `SECURITY` event to the audit ledger, with the field names ADR-0003 §2–§4
   settled on: `event_type = SECURITY_REFRESH_TOKEN_REUSE`, `actor_type =` the role of the session
   (`CUSTOMER` / `AGENT` / `SUPERVISOR` / `ADMIN` — the ledger has no `USER` member),
   `actor_id = user_id`, `session_id = familyId`, `source_prefix` (the /24 or /48, not the full
   address), `client_agent` (the parsed family, not the raw string), and
   `metadata = {presentedGeneration, activeGeneration, audience, oldestIssuedAt}` — `sessionId` is a
   column, so it is not duplicated in the blob.
   Presenting an already-`REVOKED` token raises the same event — repeated probing is evidence,
   and an append-only ledger is the right place for duplicates.
6. The server answers `401` with a `Problem` (`type: .../problems/invalid-grant`) and a generic
   detail. It does **not** reveal that a family was revoked, which generation was replayed, or
   which audience — a refresh endpoint that answers differently for "stale" vs "stolen" is an
   oracle.
7. Consequences land within 300 s everywhere: the thief's stolen `T_n` is dead, the legitimate
   user's `T_n+1` is dead, and any live access token for the family is denied by the deny-list.
   Both parties must log in again.
8. The `SECURITY` event is visible in the ops console audit viewer (issue #73). Escalation from
   there — disabling the account — revokes every family the user owns (§5).

**Concurrency, stated rather than implied.** Because there is **no reuse grace window**, a
client that refreshes twice with the same token logs its own user out. That is enforced
client-side (issue #57) and it is a hard requirement on both SPAs:

- exactly **one** in-flight refresh at a time — concurrent `401`s share a single refresh promise
  and all replay against the same new token (no thundering herd);
- **no blind retry** of `POST /auth/refresh`. It is not idempotent; a retry after a timeout
  presents a rotated token and trips reuse detection. On a refresh failure the app logs out.
- **cross-tab coordination** via `BroadcastChannel`: tabs on the same origin elect one refresher,
  because two tabs refreshing independently is the same race as an attack.

We rejected a server-side grace window (honour a rotated token for ~10 s and return the current
pair). It would soften the multi-tab race, but it also puts a window on the exact detection we
are building, and issue #28's acceptance test — "refresh twice with the same token → second call
rejected and the whole family revoked" — would become timing-dependent. Strict detection plus a
correct client is cheaper to reason about.

### 5. Logout and revocation

**Deliberate logout** — `POST /api/v1/auth/logout` (Bearer-protected):

1. Revoke the caller's family: every row for that `family_id` → `REVOKED`.
2. Push `sid:<familyId>` to the Redis deny-list, TTL 300 s.
3. Expire the caller's audience cookie — `ch_rt_cus` or `ch_rt_ops`, never both:
   `Set-Cookie: <audience cookie>=; Max-Age=0; Path=/api/v1/auth/refresh; HttpOnly; Secure; SameSite=Strict`.
4. The SPA clears the in-memory access token, clears the TanStack Query cache (ADR-0004) and
   redirects to `/login`, preserving the intended destination.

**Tab closed / browser killed.** Nothing calls logout. The access token dies within 300 s; the
refresh cookie survives until its TTL — which is what "stay signed in" means. There is no
client-side state to clean up, because there is no token in storage.

**Revocation without a user action** — reuse detection (§4), account disable, password reset,
role removal, or an operator choosing "sign out everywhere":

1. Revoke every `ACTIVE` family belonging to the user (one query on `refresh_token.user_id`).
2. Push each revoked `family_id` to the deny-list.
3. Append a `SECURITY` event naming the reason and the actor who triggered it.

Effect: refresh is refused immediately, and any in-flight access token is refused on its next
request. We accept **one Redis `EXISTS` per authenticated request** in exchange for immediate
revocation. It is bounded (each entry lives 300 s), it self-cleans, and Redis is already in the
stack. We are *not* keeping sessions in Redis: the JWT still carries the authorisation payload,
and Redis holds only a deny-list of dead session ids. We also deliberately do **not** add a
per-user token-version claim — revoking families covers the same cases with one fewer stateful
check on the hot path.

**Session inventory.** `GET /api/v1/auth/sessions` (list the caller's live families: audience,
issued-at, last-used, IP, user agent) and `DELETE /api/v1/auth/sessions/{familyId}` (revoke one)
give customers and agents a visible session list. These two operations land with the full
contract draft in issue #26; the behaviour above is fixed now so they need no new mechanism.

### 6. Ops console specifics

The ops console holds a `SUPERVISOR` or `AGENT` principal that can read any customer's financial
data, so its session is deliberately shorter-lived than a customer's:

- **Idle timeout: 900 s (15 min)**, implemented as the refresh-token TTL. An idle agent's next
  silent refresh fails and the console returns to login.
- **Absolute session: 28 800 s (8 h)** from first login, even for an active agent. Shift
  boundaries and shared back-office terminals are the reason.
- **Idle warning at T-60 s** with an explicit *Stay signed in* action that performs a refresh.
  Automatic keep-alive pings are forbidden — an idle timeout that refreshes itself is not one.
- **No "remember me"** for any non-`CUSTOMER` role.
- **Step-up re-authentication** for destructive or irreversible actions — maker-checker
  approve/deny (issue #71), DSAR execution (issue #72), any purge. If the last credential entry
  is older than **300 s (5 min)**, the endpoint returns `428 Precondition Required` with a
  `Problem` pointing at `POST /api/v1/auth/step-up`, and the console shows a password prompt.
  Approving a consent on someone's behalf should require a password typed in the last five
  minutes, not a session started this morning.
- **Attribution.** Every agent request carries `sid`, and it is recorded on every audit row the
  request produces — as `consent_event.session_id`, the first-class column ADR-0003 §3 promoted it
  to (indexed by `idx_ce_session`, so "everything this session did" is one query). The
  `metadata.sessionId` workaround this ADR provisionally allowed is therefore never built. The audit
  viewer can show *which session* of *which supervisor* read a customer's data, and reading the audit
  log is itself audited (issues #46, #73).

### 7. Machine clients

The FIU service account uses OAuth2 **client credentials**: a client secret (mTLS is the upgrade
path) exchanged for a **900 s (15 min)** access token. No refresh token, no cookies, no family —
reuse detection does not apply because nothing rotates. The partner sandbox (mock FIU/FIP and
notification receiver, issues #74–#76) authenticates artefacts and notifications by **signature**,
not by user session, and is out of scope for this ADR.

### 8. Why the access token is never written to `localStorage`

`localStorage` is the default in SPA tutorials and the wrong choice here. Four reasons, in the
order they bite:

1. **Any XSS becomes a full, durable takeover.** Anything a script on the origin can read, it can
   `fetch()` to an attacker's domain. A token in storage is readable by *every* script on the
   origin, including anything a compromised dependency injects. `HttpOnly` removes the read path
   entirely: after an injection the attacker can *make requests* while the tab is open, but
   cannot steal the credential, cannot outlive the tab, and cannot replay the session from their
   own machine.
2. **A cookie is sent to one place; a stored token is sent wherever the attacker points.** The
   browser enforces the cookie's `Domain` and `Path`. A string in `localStorage` has no such
   binding — exfiltration is one line of code and leaves no server-side trace.
3. **It persists where we do not want it to.** `localStorage` survives tab close, browser restart
   and crash, as plaintext in a SQLite file on disk. On a shared or family machine a 12 h
   credential outlives the session it belongs to and is recoverable by anyone with file access.
   `sessionStorage` is rejected for the same read-path reason — being tab-scoped does not make it
   unreadable by scripts.
4. **The server cannot revoke what it cannot see.** A stored token is invisible to us; the only
   lever is expiry, and a 12 h exposure window is not acceptable for financial data. The
   httpOnly-cookie model gives us a server-side handle on every live session (§5).

What this costs, and what we accept: the access token must be **5 minutes**, because it is the
only credential an attacker can extract from a compromised renderer. Five minutes is short enough
that the damage is one request-batch, and the silent refresh on boot and on `401` means the user
never notices. We also accept one extra round trip on page load and a mandatory loading state.

The corollary, which issue #27 asks us to write down: **CSRF is disabled for the data endpoints
because they are not cookie-authenticated.** `Authorization: Bearer` cannot be attached by a
cross-site form. The one endpoint that *is* cookie-authenticated is `/api/v1/auth/refresh`, and it
is closed by three independent layers: `SameSite=Strict` (the cookie is not sent cross-site at
all), a required `application/json` body (a cross-site form can only send a CORS-simple content
type, which the endpoint rejects before it reads anything), and a CORS allowlist of our two SPA
origins with `Access-Control-Allow-Credentials: true` and an explicit origin — never `*`. In dev,
the SPA proxies to the API so the request is same-origin and the allowlist is not exercised
(issue #56: browser code uses relative URLs).

## Consequences

**Positive**

- **XSS does not yield a durable credential.** No token in storage means an injection is a
  5-minute, single-tab incident instead of a 12-hour account takeover from the attacker's laptop.
- **Stolen refresh tokens are detected, not just expired.** Rotation makes every token
  single-use, so a replay is proof of theft, and the response — revoke the family, raise a
  `SECURITY` event, force re-authentication — is written down as a sequence and is testable
  (issue #28's acceptance test is this sequence).
- **Immediate revocation without a session store.** One bounded Redis lookup per request buys
  "kill it now" for reuse, erasure, disablement and role removal, while the JWT stays the
  authorisation payload.
- **Sessions are first-class audit subjects.** `sid` on the token becomes the ledger's session
  identifier, so attribution survives a user with several devices.
- **Contract-enforced.** The bearer scheme and the auth operations live in the OpenAPI file, so
  both generated clients see them and a change is a reviewable diff (ADR-0001).
- **The ops console is not a customer portal with a different theme.** 15-minute idle, 8-hour
  absolute, 5-minute step-up: the privilege difference is expressed in numbers.

**Costs / trade-offs**

- **A page reload costs a round trip.** The token is gone on reload, so boot performs one silent
  refresh and must render a loading state. Accepted.
- **Redis is now on the auth hot path.** If Redis is unavailable we fail closed (deny) rather than
  skip the deny-list check. That makes Redis availability a security requirement, not just a
  caching one — it needs a healthcheck and an alert (issue #6).
- **Strict reuse detection is unforgiving of sloppy clients.** A second tab, or a blind retry of
  `/refresh`, logs the user out. This is fail-closed and visible, but it puts a real requirement
  on both SPAs: single-flight refresh, no retry, cross-tab coordination. Enforced by the tests in
  issue #57.
- **Reuse detection is a denial-of-service lever.** Anyone who obtains a copy of a refresh token
  can force the legitimate user out by replaying it. We accept this: forced re-authentication is
  cheaper than a silent compromise, and the `SECURITY` event turns each attempt into a signal.
- **Two cookie names, two audiences, one cookie jar.** More moving parts than a single
  `ch_rt`, but a single name would let an ops-console login kill a customer session in the same
  browser.
- **Role changes lag by up to 300 s.** Fine for grants; removals go through family revocation so
  they do not wait.

## Alternatives considered

### Server-side sessions with a session cookie — rejected

One `httpOnly` cookie, all state in MySQL/Redis. Revocation is trivially immediate and there is
nothing to steal from the renderer.

**Why it lost:** the backend still has to authenticate the FIU service account and the partner
sandbox, so a bearer-token validator is required regardless — we would run two auth systems.
Session state on every request means either sticky load balancing or a shared store hit for the
*whole* principal rather than a bounded deny-list. And the SPAs would depend on cookie semantics
end to end, which makes the SSE stream (issue #78) and the M2M callers special cases. We take the
property we want from this option — the long-lived credential is an httpOnly cookie — without
making every request stateful.

### Access token in `localStorage`, refresh in `httpOnly` — rejected

The common compromise: it survives reloads and needs no boot refresh.

**Why it lost:** it hands back everything §8 removes. The refresh token is protected but the
access token — five minutes of full-privilege API access — is readable by any script and
exfiltratable to any origin. On a compromised page the attacker does not even need the refresh
token: they can proxy the user's session through the victim's browser. Rejected outright.

### BFF-held session (the SPA never sees a token) — rejected, with respect

The BFF keeps the tokens server-side, the browser holds only a session cookie, and the BFF
forwards `Authorization: Bearer` upstream. This is a strong pattern and the closest real
competitor.

**Why it lost here (60-second version):** the BFF in ConsentHub is an aggregation and caching
layer for the customer portal (issues #77–#78), not a gateway for everything. The ops console
streams the audit log and exports CSV directly (issue #73), maker-checker decisions are
attributed to a specific supervisor session in the ledger (issue #71), and the backend must
authenticate M2M callers anyway — so a JWT validator exists regardless. Routing every ops-console
request through the BFF would double the auth surface and put a Node hop in front of the very
requests whose attribution we most need to be direct. We keep the BFF as a cache, and keep token
handling in the backend where the audit trail is written.

### Non-rotating refresh token with a long TTL — rejected

Simple, and no client coordination needed. **Why it lost:** a stolen token is silently valid
until it expires, and we would have nothing to detect. Rotation is what turns "the token was
copied" from an unobservable event into a `401` plus a `SECURITY` event.

### Refresh token in `localStorage`, access token in memory — rejected

Removes the boot round trip. **Why it lost:** it is the worst of both — a script-readable,
12-hour, revocable-only-by-us credential. §8 applies with more force the longer the TTL.

## Consistency with the contract

The contract is `contract/openapi/consenthub-api.yaml` (ADR-0001). The plan and this issue's
acceptance criteria call it `docs/openapi.yaml`; that path does not exist in the repo and
ADR-0001 deliberately made the contract a first-class root-level artifact instead, so
`contract/openapi/consenthub-api.yaml` is canonical and references to `docs/openapi.yaml` should
be read as that file. Issue #26 drafts the full v1 surface there.

Paths in the spec are relative to the server base `https://api.consenthub.example/api/v1`, so the
spec path `/auth/login` **is** `POST /api/v1/auth/login`. That prefix is also what issue #27's
`permitOnly` rule (`/api/v1/auth/**`) and the cookie `Path` above assume. Landing this ADR made
two edits to the contract: the server base moved from `/v1` to `/api/v1` so the deployed URLs
match those rules (no path template changed, so no generated client signature changed), and a
document-wide `bearerAuth` requirement was added. That second edit is also what turned the
contract's three `security-defined` lint errors into zero — the API is now deny-by-default in the
spec, as it is in the filter chain.

| ADR clause | Contract | Status |
|---|---|---|
| §1 login, BCrypt credential, audience, rate limit | `POST /auth/login` → `POST /api/v1/auth/login` | in the contract now |
| §3–4 rotating refresh, audience-scoped cookie | `POST /auth/refresh` → `POST /api/v1/auth/refresh` | in the contract now |
| §5 logout, family revocation, cookie expiry | `POST /auth/logout` → `POST /api/v1/auth/logout` | in the contract now |
| §2 access token in `Authorization: Bearer` | `securitySchemes.bearerAuth` (`http`/`bearer`, `bearerFormat: JWT`) applied document-wide, `security: []` on login and refresh only | in the contract now |
| §5 session inventory and revoke-one | `GET /auth/sessions`, `DELETE /auth/sessions/{familyId}` | lands with issue #26 |
| §6 step-up re-authentication | `POST /auth/step-up`, `428 Precondition Required` on sensitive operations | lands with issue #26 |
| §7 FIU client credentials | `POST /auth/token` (`grant_type=client_credentials`) | lands with issue #26 |
| §4 `Problem` bodies, `SECURITY` event | `Problem` schema in the contract; the ledger row is ADR-0003 | `Problem` in the contract now |

Implementation is tracked in issue #27 (filter chain, JWT issuer/validator, the CSRF reasoning in
§8), issue #28 (rotation and reuse detection — its acceptance test *is* the sequence in §4),
issue #20 (`app_user`, BCrypt, lockout fields) and issue #57 (in-memory token, single-flight
silent refresh, logout).

## References

- ADR-0001 — the contract is a root-level artifact consumed by both halves.
- ADR-0003 — where `SECURITY` events are written, and the record reuse detection relies on. It
  landed after this ADR and amended the provisional ledger spellings here: `SECURITY` → the canonical
  `SECURITY_REFRESH_TOKEN_REUSE` / `SECURITY_LOGIN_LOCKOUT` members, `actor_type = USER` → the
  session's role, and `metadata.sessionId` → the `session_id` column. The numbers in this document
  are unchanged; only the ledger's field names were, and ADR-0003 §4's table is the vocabulary.
- ADR-0004 — logout clears the TanStack Query cache; server state is not kept in a client store.
- RFC 9700 (OAuth 2.0 Security Best Current Practice) — sender-constrained refresh tokens,
  rotation and reuse detection.
- OWASP Session Management Cheat Sheet; OWASP HTML5 Security Cheat Sheet (web storage).
