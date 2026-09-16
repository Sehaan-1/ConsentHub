# ADR-0003: Append-only audit ledger

- **Status:** Accepted
- **Date:** 2026-09-15
- **Deciders:** ConsentHub engineering
- **Tags:** architecture, audit, append-only, persistence, data-retention, dpdp, rbi-aa, testing

## Context

ConsentHub's product claim is *proof of consent*. Everything the platform says — "the customer
agreed to this, on this day, to this FIU, for this purpose, and the FIU fetched exactly what was
granted" — is backed by rows in two tables. If those rows can be rewritten, the claim is a
process promise, not evidence. The plan's version of this is one line: `consent_event` and
`data_access_log` are INSERT ONLY, enforced with a DB grant and an ArchUnit test, **not a
comment**. This ADR decides what that means, because three of the decisions below are one-way
doors: they change what a row looks like, and retrofitting them after the table has rows means
either a backfill (which rewrites history) or two formats forever.

**Who we are defending the ledger against.** The threat model (issue #85) names four adversaries
and each one wants something different from the audit trail:

1. **Our own code, six months from now.** A stale object hits `saveAndFlush`; a backfill script
   "tidies" a test artefact; a well-meaning contributor adds `@Modifying` to fix a bug.
2. **An operator with a shell.** Anyone holding the application DB password can run
   `UPDATE consent_event SET ...`. A grant stops them; a comment does not.
3. **An insider with something to hide.** An agent who browsed a customer's data, or an engineer
   asked by a partner to "make that fetch entry disappear". This is the adversary an audit ledger
   exists for, and it is the one that has DBA-equivalent access.
4. **Whoever restores a snapshot.** Point-in-time recovery *un-writes* legitimately recorded rows
   and rolls the sequence back. It is not an attack; it is the failure mode nobody plans for.

Adversaries 1–3 mutate; adversary 4 deletes by forgetting. A grant stops 1 and 2 completely,
stops 3 completely *within the application role*, and does nothing about 4. That asymmetry is why
this ADR separates three properties that are usually conflated (§1), and why enforcement is
layered rather than singular.

**Constraints that shape the decision:**

- **The load-bearing row is mutable.** `consent_artefact` carries a `@Version` optimistic lock and a
  lifecycle status machine (issues #17 and #31). So "make the evidence immutable" cannot mean
  "make every table immutable" — it has to name the exact dimension in which mutation is allowed,
  and prove it. That is §8.
- **The same rows must survive an erasure right.** DPDP §8(7) and §12 require erasure when the
  purpose is spent or consent is withdrawn, "unless retention is necessary for compliance with
  law". A ledger that stores names and free text about a person cannot satisfy both that and a
  7-year consent-record obligation. The resolution has to be architectural, not an exception
  request — that is §10.
- **Migrations stay portable.** ADR-0005 bans MySQL-specific DDL (no `ENGINE=`, no
  `ON UPDATE CURRENT_TIMESTAMP`, no `JSON` columns, no `AUTO_INCREMENT`), so "a MySQL trigger
  that raises on UPDATE" is not available as the primary mechanism. The mechanism we do use —
  column-level grants — is legal in both engines (§5).
- **The ledger must not become a second source of truth that can disagree with the first.** Every
  write path in the system (`/approve`, `/deny`, `/pause`, `/resume`, `/revoke`, the expiry job,
  the fetch endpoint, the notification poller, the DSAR flow) has to append, so "append in the
  same transaction as the change" has to be a stated rule with a name and a test, not a habit —
  that is §12 and §13.
- **ADR-0002 §6 handed work here.** Session attribution "rides in `metadata.sessionId` until
  ADR-0003 promotes one". It is promoted now (§3), and ADR-0002's provisional event-type and
  actor-type spellings are corrected to the vocabulary in §4.
- **The retention clock needs an owner.** A purge is the one operation that can destroy evidence
  *lawfully*; it needs a period, an authority, and a procedure recorded before the first row is
  written — that is §11.

## Decision

**`consent_event` and `data_access_log` are append-only at three independent layers, and the
artefact row is mutable in exactly one dimension.**

1. **Prevention — a whitelist of grants.** The application role is granted `SELECT` and `INSERT`
   on the ledger tables and is never granted `UPDATE` or `DELETE`. Nothing is revoked, because in
   MySQL a revoke cannot undo a broader grant, so the wall only holds if it is built by omission
   (§5). The same grant narrows the artefact to a *column* whitelist: the app may update
   lifecycle state and nothing else.
2. **Prevention — an architecture test.** No update or delete path exists on either repository: the
   repository surface has no `save`, no `delete`, no `@Modifying`, and an ArchUnit rule fails the
   build if one appears (§6). A `@DataJpaTest` slice asserts that `UPDATE`/`DELETE` via native SQL
   raises `1142`, so the grant is tested, not assumed.
3. **Detection — hashes the ledger holds about other tables.** Every event row carries
   `artefact_sha256`, the hash of the artefact's non-lifecycle columns at that moment, and every
   artefact carries `notice_body_sha256`. A weekly `LedgerIntegrityJob` recomputes them (§7). This
   buys tamper-*evidence* against a privileged writer, which no grant can.
4. **Survival — erasure is shredding, not deletion.** The ledger holds no prose and no unmasked
   identifiers; a subject's rows are linked by `HMAC-SHA256(k_customer, customer_id)` and
   destroying `k_customer` makes the surviving rows anonymously provable, forever (§10). Retention
   (7 years) and erasure therefore stop competing.
5. **Order — the ledger keeps its own clock.** Every row carries a `ledger_seq` stamped in the
   same transaction from a per-subject watermark table, which gives erasure a bounded range to work
   on and makes a snapshot restore loudly detectable (§12.4).

And one rule that settles the artefact question:

> **Status changes in place. Substance changes by lineage.**

A column of `consent_artefact` may be `UPDATE`-able if and only if changing it does not change
what the customer agreed to. Everything else requires a new row and a `CONSENT_MIGRATED` event on
both.

The one-line property, stated so a reviewer can test it: **a ledger row is written once, by code
that has no way to un-write it, and its integrity does not depend on anyone believing that code.**

### 1. What the ledger is, and the three properties people conflate

The ledger is the record. The `consent_artefact` row is a *cache* of the current view, kept
because 30-day UIs and fetch-time validation should not re-derive state from an event stream. Any
field of a consent that a regulator or a customer needs is reconstructible from `consent_event` +
`data_access_log` + the pinned `notice_version`, and that is what makes the cache safe to hold.

Three properties, kept separate because they have different mechanisms and different costs:

| Property | Meaning | Mechanism | Status after this ADR |
|---|---|---|---|
| **Append-only** | No principal in the application's reach can mutate or delete a row | Grant (§5) + repository surface and ArchUnit (§6) | **Proven** — by tests in the suite |
| **Tamper-evident** | A mutation by a *privileged* principal can be detected | Per-event `artefact_sha256`, notice hashes, `LedgerIntegrityJob` (§7); external anchor (§16) | **Partly** — detects in-place edits; a splice of the tail needs the anchor |
| **Attributable** | Every row says who, in which session, for which reason, at which instant | `actor_type`/`actor_id`/`session_id`/`reason_code`/`occurred_at`/`correlation_id`, with `NOT NULL` and CHECKs (§3) | **Proven** — an unattributable row cannot be constructed |

Saying it the other way round: we do not claim "nobody can change the audit log". We claim "the
application cannot, the build forbids code that would try, and a DBA who does it leaves a mark".
That is the honest version of "enforced, not promised", and it is what §16 exists to complete.

Out of scope by decision: the ledger does **not** survive the loss of the database, and does not
claim to. Backups are encrypted (their keys follow the §11 clocks), restore is a documented
runbook procedure, and the watermark check (§12) turns a bad restore into a loud alert instead of
a silent edit to history. Full non-repudiation would need a second ledger the DBA cannot restore —
that is the §16 anchor, deliberately deferred with its columns reserved.

### 2. The two tables

Derived from issue #13's list plus what the layers above require. Column comments are normative:
issue #13 asks for "every RBI field present and justified in a comment or the ER notes", and the
justifications below are those comments. No `updated_at` anywhere; no `ON DELETE CASCADE` anywhere;
no foreign key from the ledger to `customer` or `app_user` (§10).

```sql
-- The ledger. One row per fact about a consent, an access, a security event or a decision.
-- Written exactly once, by LedgerWriter.append(...), inside the transaction that made it true.
CREATE TABLE consent_event (
  id                BINARY(16)   NOT NULL,   -- app-assigned UUIDv7 (§12); unguessable per issue #30
  artefact_id       BINARY(16)   NULL,       -- NULL only for platform-level families (SECURITY/AUDIT/POLICY/DSAR)
  event_type        VARCHAR(40)  NOT NULL,   -- ConsentEventType (§4); no CHECK on purpose (§4)
  actor_type        VARCHAR(16)  NOT NULL,   -- CUSTOMER|AGENT|SUPERVISOR|ADMIN|FIU|SYSTEM
  actor_id          BINARY(16)   NULL,       -- NULL iff actor_type = SYSTEM (§3)
  session_id        VARCHAR(64)  NULL,       -- ADR-0002 token-family id; for FIU callers the JWT jti (§3)
  subject_ref       BINARY(32)   NULL,       -- HMAC-SHA256(k_customer, customer_id) — unlinks on erasure (§10)
  reason_code       VARCHAR(32)  NOT NULL,   -- controlled vocabulary; the words are in the code, not the row (§3)
  source_prefix     VARBINARY(16) NULL,      -- /24 or /48, masked at WRITE time — masking later is impossible (§3)
  client_agent      VARCHAR(64)  NULL,       -- parsed "Chrome/126"; the raw UA lives in logs only (§3)
  artefact_sha256   CHAR(64)     NULL,       -- hash of the artefact's non-lifecycle columns, now (§7/§8)
  notice_body_sha256 CHAR(64)    NULL,       -- hash of the notice text in force at this moment (§9)
  corrects_event_id BINARY(16)   NULL,       -- a wrong row is answered by a new row (§14)
  correlation_id    VARCHAR(64)  NOT NULL,   -- joins the row to the log line (issue #50)
  occurred_at       DATETIME(6)  NOT NULL,   -- Clock.systemUTC(), microsecond, never DB-defaulted (§12)
  metadata          TEXT         NOT NULL,      -- canonical JSON, id/number/enum/timestamp values only (§3); `{}` beats NULL
  ledger_seq        BIGINT       NOT NULL,   -- this subject's watermark, written in the same tx (§12)
  -- reserved for the anchor (§16). Nullable now so enabling it later touches no old row.
  chain_seq         BIGINT       NULL,
  prev_hash         BINARY(32)   NULL,
  row_hash          BINARY(32)   NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_ce_actor      CHECK (actor_type = 'SYSTEM' OR actor_id IS NOT NULL),
  CONSTRAINT ck_ce_session    CHECK (actor_type = 'SYSTEM' OR session_id IS NOT NULL),
  CONSTRAINT ck_ce_about_something CHECK (artefact_id IS NOT NULL OR subject_ref IS NOT NULL),
  -- An event that names a person's artefact must name the person's shadow, or erasure cannot
  -- find its own rows. Enforced here because §10's erasure must not depend on a code path.
  CONSTRAINT ck_ce_subject    CHECK (artefact_id IS NULL OR subject_ref IS NOT NULL),
  CONSTRAINT fk_ce_artefact   FOREIGN KEY (artefact_id) REFERENCES consent_artefact (id)
                                                     ON DELETE RESTRICT
) /*!40101 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci */;

-- Issue #13's query path, plus attribution lookups ("what did this session do?").
CREATE INDEX idx_ce_artefact ON consent_event (artefact_id, occurred_at, id);
CREATE INDEX idx_ce_session  ON consent_event (session_id, occurred_at);
CREATE INDEX idx_ce_subject  ON consent_event (subject_ref, occurred_at);
CREATE INDEX idx_ce_type     ON consent_event (event_type, occurred_at);

-- The customer-readable "who got what" record. This table answers a question a human asks
-- ("who fetched my data?"), which is why it is its own table and not a JSON blob in the ledger.
CREATE TABLE data_access_log (
  id                 BINARY(16)  NOT NULL,
  event_id           BINARY(16)  NOT NULL,  -- the DATA_ACCESSED row; UNIQUE makes it exactly 1:1 (§13)
  artefact_id        BINARY(16)  NOT NULL,
  fiu_id             BINARY(16)  NOT NULL,
  actor_type         VARCHAR(16) NOT NULL,  -- FIU today; AGENT for an ops-console bulk export (future)
  actor_id           BINARY(16)  NOT NULL,
  session_id         VARCHAR(64) NULL,
  subject_ref        BINARY(32)  NOT NULL,
  purpose_code       VARCHAR(32) NOT NULL,
  requested          TEXT        NOT NULL,  -- canonical JSON: categories asked for
  served             TEXT        NOT NULL,  -- canonical JSON: categories actually served
  record_count       INT         NOT NULL,
  window_from        DATE        NULL,      -- the date range served, not merely consented to
  window_to          DATE        NULL,
  correlation_id     VARCHAR(64) NOT NULL,
  occurred_at        DATETIME(6) NOT NULL,
  ledger_seq         BIGINT      NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_dal_event UNIQUE (event_id),
  CONSTRAINT ck_dal_count  CHECK (record_count >= 0),
  CONSTRAINT fk_dal_event    FOREIGN KEY (event_id)    REFERENCES consent_event (id) ON DELETE RESTRICT,
  CONSTRAINT fk_dal_artefact FOREIGN KEY (artefact_id) REFERENCES consent_artefact (id) ON DELETE RESTRICT
) /*!40101 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci */;

CREATE INDEX idx_dal_artefact ON data_access_log (artefact_id, occurred_at);
CREATE INDEX idx_dal_fiu      ON data_access_log (fiu_id, occurred_at);
```

Two structural notes.

- **`requested` vs `served` are both stored.** The invariant "served ⊆ granted" cannot be written in
  SQL, so we store both sides and let the integrity job re-derive it from the artefact's category
  snapshot. That is the difference between "we enforce scope at fetch time" and "we can prove we
  enforced scope at fetch time, for any given fetch".
- **`notice_version` is append-only too** (it is the text the customer saw — evidence, not
  configuration), and that forces a schema change to what issues #14 and #17 currently describe.
  See §9.

### 3. Attribution: a row that cannot answer "who, when, why" is not an audit entry

Issue #18's acceptance criterion — "constructing an event requires actor, reason and timestamp; an
anonymous state change cannot be built" — is turned into columns, constraints and a factory:

- **`actor_type` ∈ {`CUSTOMER`, `AGENT`, `SUPERVISOR`, `ADMIN`, `FIU`, `SYSTEM`}.** There is no
  `USER` member: the actor type is the caller's *role*, so the ledger says which privilege was
  exercised, not merely that a person existed. ADR-0002's provisional `actor_type = USER` is
  corrected accordingly (see its amendment note).
- **`actor_id` is NULL only for `SYSTEM`** (the expiry job, the poller, the integrity job). The
  CHECK enforces it, and the factory refuses to build the rest, so "a state change happened and we
  do not know who did it" is not a representable state.
- **`session_id` is now a first-class column**, promoted from ADR-0002 §6's `metadata.sessionId`
  workaround. For a human it is the token-family id (the revocable unit); for an FIU machine token,
  which has no family, it is the JWT `jti` (a 15-minute, self-contained unit). `NOT NULL` except
  for `SYSTEM`. The index `idx_ce_session` makes "everything this session did" one query — which is
  the question an insider investigation actually asks, and the one ADR-0002 §4 step 8 points at.
- **`source_prefix`, not `source_ip`.** The ledger stores the network prefix (IPv4 `/24`,
  IPv6 `/48`) as bytes and never the full address. The full address is in the application logs for
  the DPDP Rule 6/8 one-year window and is reachable through `correlation_id`. The reason it has to
  be decided *here* rather than in a privacy review later: **an append-only row can never be
  cleaned up afterwards.** Whatever we write in year 1 is what we will still be storing in year 7,
  which is also why there is no free-text column in either table (§3, last bullet) and why masking
  happens on write, not on read.
- **`client_agent`, not `user_agent`.** A raw UA string is a device fingerprint and 500 characters
  of somebody's prose. We store the parsed family and major version (`curl/8.5`, `Chrome/126`) —
  enough to answer "was this a browser or a script?", which is the audit question — and the full
  string goes to logs. ADR-0002 §4 step 5's `source_ip` and `user_agent` are amended the same way,
  and its `metadata.sessionId` becomes the column instead of a key in the blob.
- **`reason_code` is a controlled vocabulary** (`NOT NULL`, `DUPLICATE_CONSENT_CATEGORY_REQUEST`,
  `SUPERVISOR_DIRECTED`, `CUSTOMER_WITHDRAWAL`, `RETENTION_EXPIRED`, …). The *sentence* a customer
  sees is produced by rendering the code through the versioned message catalogue (§13), so wording
  changes never rewrite history and no one can type a note about a person into the ledger.
- **`metadata` is canonical JSON with a type rule.** Keys are allowlisted per event type, and every
  leaf at every depth is a UUID, an integer, a boolean, an ISO-8601 timestamp or a
  `SCREAMING_SNAKE` code — never prose. `LedgerMetadataValidator` rejects anything else at the write
  path, and issue #18's test is
  `assertThatThrownBy(() -> event(CONSENT_APPROVED).metadata(Map.of("name", "Priya Sharma")))`
  → `InvalidLedgerPayloadException`. A name in an audit row would make the ledger a personal-data
  store, and §10's balance depends on it not being one.
- **`correlation_id` is `NOT NULL`.** One request, one id (issue #50), so a row can be read without
  log access but never *only* from the logs.

### 4. The event vocabulary, and why it is not a CHECK constraint

`ConsentEventType` (in `consenthub-domain`) is the single source. The table below is the union of
what the plan asked for and what the security/lifecycle tickets need. Prefix = family; `artefact_id`
is set for every family except those marked platform-level.

| Family | Members | Written by | On the customer timeline (#37) |
|---|---|---|---|
| `CONSENT_*` | `CREATED`, `APPROVED`, `DENIED`, `PAUSED`, `RESUMED`, `REVOKED`, `EXPIRED`, `MIGRATED`, `REINSTATED`, `CORRECTED` | consent service, state machine (#31), expiry job (#51) | yes |
| `DATA_*` / `ACCESS_*` | `DATA_ACCESSED`, `ACCESS_DENIED` | fetch endpoint (#41) | yes — this is the transparency view |
| `NOTIFY_*` | `NOTIFIED`, `NOTIFICATION_DEAD` | outbox poller (#48), notification callback (#49) | yes (`NOTIFIED`) |
| `SECURITY_*` | `REFRESH_TOKEN_REUSE`, `LOGIN_LOCKOUT`, `SESSION_REVOKED`, `LEDGER_DRIFT`, `WATERMARK_REGRESSION` | auth filter chain (#27, #28), integrity jobs | no — supervisor/admin only |
| `AUDIT_*` | `AUDIT_READ`, `AUDIT_EXPORTED` | audit endpoints (#46) | no |
| `APPROVAL_*` | `REQUESTED`, `GRANTED`, `REJECTED` | maker-checker (#43, #45) | no |
| `DSAR_*` | `RECEIVED`, `COMPLETED`, `REJECTED` (platform-level, `artefact_id` NULL) | DSAR service (#44) | as a summary row, yes |
| `NOTICE_*` | `PUBLISHED`, `SUPERSEDED` | notice publishing | referenced by artefact, not listed |
| `POLICY_*` | `CHANGED`, `LEGAL_HOLD_PLACED`, `LEGAL_HOLD_RELEASED`, `PURGE_AUTHORIZED`, `PURGE_COMPLETED`, `ANCHORED` (platform-level) | retention job (#86), anchor job (§16) | no |

Divergences from issue #18's draft list, and why they are not cosmetic:

- `ACCESSED` → `DATA_ACCESSED`, and `DENIED` is split: `CONSENT_DENIED` (a declined consent
  request, #35) vs `ACCESS_DENIED` (a refused fetch, #41). Two different questions get asked of
  them by two different readers.
- `MIGRATED` gains `REINSTATED` and `CORRECTED` because §8 and §14 both need a terminal-state
  exception and a wrong-row answer respectively.
- `CREATED` → `CONSENT_CREATED`: a family prefix makes the audit viewer's filter list
  self-documenting, and it keeps the CHECK-free vocabulary greppable.

**No `CHECK` constraint on `event_type`.** A vocabulary that requires a migration to grow gets a
`MISC` catch-all within a month, and a catch-all destroys the index that every investigation uses.
Instead: the enum is the type system, and a unit test asserts `ConsentEventType.values()` equals
the table above — so widening the vocabulary without amending this ADR fails the build. That test
is the mechanism; the ADR is the spec it checks against.

`SECURITY_LEDGER_DRIFT` and `WATERMARK_REGRESSION` are the only two event types whose *only*
producer is a scheduled job, and they are the two that make §7 and §12 real rather than
aspirational: an invariant that raises nothing is an invariant nobody believes.

### 5. Enforcement, layer 1 — the grant

**We never revoke; we only ever fail to grant.** MySQL's own words: privileges "are formed
additively as the logical OR of the account privileges at each of the privilege levels… **It is not
possible to deny a privilege granted at a higher level by absence of that privilege at a lower
level**." So `UPDATE ON consenthub.*` plus "no `UPDATE` on `consent_event`" is not a wall at all —
it is a comment with a `REVOKE` in front of it.

A caveat, because the docs have one and pretending otherwise is how this decision gets relitigated:
since 8.0.16 MySQL can deny a higher-level privilege at the *database* level via
`partial_revokes`. That variable is off by default, is runtime-settable by anyone holding
`SYSTEM_VARIABLES_ADMIN`, is not consistently exposed by managed offerings, and **does not reach
table or column granularity** — the level this design needs. A revoke-based ledger would therefore
be a design whose strength depends on a server flag staying off in every environment. A whitelist
depends on nothing. So the runtime role is built as a whitelist and *tested as a whitelist* (§5.4).

#### 5.1 Roles

Two roles, one user each, so the policy is one named object a reviewer can diff and ops can clone
without inheriting a side-effect: a list of grants attached to an account drifts; a role does not:

| Role | User | Holds |
|---|---|---|
| `consenthub_migrator` | `ch_migrate` | DDL + full DML on the schema, incl. `ALTER`, `DROP`, `CREATE ROUTINE`, `TRIGGER`, and the right to write `flyway_schema_history` |
| `consenthub_app` | `ch_app` | `SELECT` + `INSERT` on each table it needs, **named one at a time** (never `ON db.*`); `UPDATE` only on the columns §5.2 lists; `DELETE` only on the operational tables |

`ch_app` is granted no `TRIGGER`, no `CREATE ROUTINE`/`ALTER ROUTINE`, no `SUPER`, no
`SYSTEM_VARIABLES_ADMIN` (which is what would let a session flip `partial_revokes`, `read_only` or
`sql_mode` under us — see §5), and **owns no object**: a schema owner has implicit full privileges on
its own tables (hard requirement in the Oracle XE profile of ADR-0005; hygiene in MySQL), so the
runtime user must never be the schema owner. Nor may the runtime user create objects, since a
definer-owned object is the classic side door.

The same privilege list means **the application cannot migrate its own schema.** Deployed
environments run `spring.flyway.enabled=false` and the pipeline runs Flyway as `ch_migrate`; the
app starts with `ddl-auto=validate` (issue #13), which needs no DDL rights. The local dev compose
file may let the app run migrations, and the cost is recorded: **the grant is not in force in dev
unless the compose stack creates both roles** (issue #6 owns that file, not this ADR) — which is
exactly why the four failing SQL tests in §5.4 are Testcontainers tests that create the roles
themselves and do not care what dev is doing.

#### 5.2 The grant script

Lands as a Flyway migration — `V4__append_only_grants.sql` in the `mysql` vendor location of
`flyway.locations` (ADR-0005). Not an ops script: a wall that only exists where someone remembered
to run a script is a wall only in prod, and then only sometimes. (Same reasoning as issue #43's
"the DB constraint is in a Flyway migration, so it exists in every environment".)

One prerequisite that will bite whoever wires the pipeline, so it is recorded here: to `GRANT` a
privilege, the grantor must hold that privilege itself **`WITH GRANT OPTION`**, and creating a role
needs the global `CREATE ROLE` — a role is not a table-level object. So `ch_migrate` is provisioned
as `GRANT ALL PRIVILEGES ON consenthub.* TO ch_migrate WITH GRANT OPTION` plus `CREATE ROLE`. A
limited CI account cannot run `V4` at all: it fails with an access-denied error rather than silently
no-oping, which is the good outcome — the bad one is a pipeline that treats grant statements as
optional and ships an environment with no wall at all.

```sql
-- V4__append_only_grants.sql (mysql location, applied by ch_migrate)

-- The ledger: append and read. Forever. No UPDATE, no DELETE. REPLACE also needs DELETE (it
-- deletes then inserts) and an upsert needs UPDATE for its assignment clause; whether MySQL checks
-- those at parse time or at execution, the outcome here is identical: no grant, no write, 1142.
GRANT SELECT, INSERT ON consenthub.consent_event    TO 'consenthub_app';
GRANT SELECT, INSERT ON consenthub.data_access_log  TO 'consenthub_app';
GRANT SELECT, INSERT ON consenthub.notice_version   TO 'consenthub_app';   -- append-only too: §9

-- The consent artefact: the body is evidence, the lifecycle is state. Table-level UPDATE is
-- deliberately NOT granted; column-level UPDATE is the whole wall.
GRANT SELECT, INSERT ON consenthub.consent_artefact TO 'consenthub_app';
-- Note what is NOT here: consent_start and consent_expiry are part of what was agreed, so
-- correcting them is a new artefact row, not an edit (§8, §14). A legal hold extends retention of
-- our records, never the life of a permission (§11.1).
GRANT UPDATE (status, paused_at, revoked_at, version)
  ON consenthub.consent_artefact TO 'consenthub_app';

-- Erasure writes exactly three columns on exactly one table, and it is the only write path that
-- touches personal data in a row that the ledger references (§10).
GRANT UPDATE (redacted_at, redaction_dsar_id, subject_key_id)
  ON consenthub.consent_artefact TO 'consenthub_app';

-- Everything that is genuinely operational: full DML.
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.customer            TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.app_user            TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.refresh_token       TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.fiu                 TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.dsar_request        TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.notification_log    TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.outbox_message      TO 'consenthub_app';
GRANT SELECT, INSERT, UPDATE, DELETE ON consenthub.approval_task       TO 'consenthub_app';
-- §10's shred: the key material is written away and the row stays, so the destruction is a
-- queryable fact instead of an absence nobody can prove.
GRANT SELECT, INSERT ON consenthub.data_key            TO 'consenthub_app';
GRANT UPDATE (wrapped_key, shredded_at) ON consenthub.data_key TO 'consenthub_app';

-- Holds are append-only in the same spirit, with exactly one narrow exception: releasing one.
GRANT SELECT, INSERT ON consenthub.retention_hold      TO 'consenthub_app';
GRANT UPDATE (released_by, released_at) ON consenthub.retention_hold TO 'consenthub_app';
GRANT SELECT ON consenthub.retention_policy            TO 'consenthub_app';  -- policy edits: §11.3

-- Reference data: append-only in spirit, so append-only by grant.
GRANT SELECT, INSERT ON consenthub.purpose         TO 'consenthub_app';
GRANT SELECT, INSERT ON consenthub.data_category   TO 'consenthub_app';
GRANT SELECT, INSERT ON consenthub.message_catalog TO 'consenthub_app';

-- The watermark (§12) and the ledger's own counters. UPDATE here is *only* ever "advance forward",
-- which the domain method enforces and the migration's CHECK cannot — but note that a revoked
-- UPDATE on these two tables would also break the ledger's INSERT, so they are the exception.
GRANT SELECT, UPDATE ON consenthub.customer_ledger_seq TO 'consenthub_app';
GRANT SELECT, UPDATE ON consenthub.ledger_counters     TO 'consenthub_app';
```

`ch_app` gets no grant at all on `flyway_schema_history`, no `UPDATE` on `message_catalog` (wording
is never edited, only added — §13.3), and nothing beyond `SELECT`/`INSERT` on the two ledger tables.
Any table created later gets its grant in the same PR that creates it, or the application cannot
touch it; that failure mode (1142 on a new feature, in dev, immediately) is the acceptable price of
a whitelist, and it is why §5.2 is one file a reviewer can read in full.

#### 5.3 Why each layer is where it is

| Attempt | What stops it | Loud or quiet |
|---|---|---|
| `UPDATE consent_event SET …` (app, script, ORM bug reaching SQL) | MySQL privilege check | **Loud** — `ERROR 1142 (42000)` |
| `UPDATE consent_artefact SET data_categories = …` | Column-level privilege | **Loud** — `ERROR 1143 (42000) … for column` |
| `REPLACE INTO consent_event …` | Needs `DELETE` | Loud — 1142 |
| `INSERT … ON DUPLICATE KEY UPDATE …` on the ledger | Needs `UPDATE` | Loud — 1142 |
| `deleteById(id)` on a ledger repository | Method does not exist | Compile error |
| `em.merge(consentEvent)` outside `..audit..` | ArchUnit §6 | Loud, in CI, before merge |
| `@Modifying` on a ledger repository | ArchUnit §6 | Loud, in CI |
| Dirty-flush of a loaded `ConsentEvent` (e.g. via a JPA collection) | `@Column(updatable = false)` on every field → Hibernate emits no UPDATE | Quiet by design; §6's repository-surface and entity-shape tests are what make it loud *at review* |
| `ALTER TABLE consent_event …`, `DROP`, restore, edit as `ch_migrate` | **Not prevented** — §7 detection, §11 archive-before-purge, §16 anchor | Detected, not prevented |

Note the one row marked "quiet by design". A layered answer is not a list of alarms; some layers
exist to make the bad write not happen, and others to make someone notice it was attempted. What
we refuse is a layer that lets the row change and nobody see.

Two holes this closes that "just revoke UPDATE" does not:

- **Views.** MySQL views are `SQL SECURITY DEFINER` by default, so a report view over `consent_event`
  owned by a role that *can* update becomes a write path for `ch_app`. Rule: no view over a ledger
  table may be definer-owned by a principal with write rights; the audit viewer's queries go
  through `GET /api/v1/audit` instead, so we create no such views. Recorded because this is the
  hole most "append-only MySQL" write-ups leave open.
- **Triggers** are not used as enforcement at all (see Alternatives). A trigger on a ledger table
  would be the one thing that can mutate it, and the app role must not be able to create one.

#### 5.4 The grant is itself under test

Two tests, both in issue #25, both running against real MySQL in a container (issue #22 — an
`@DataJpaTest` slice on H2 has no privilege system, so it would *pass* the test that matters):

1. **The failing statements** — as `ch_app`, assert `SQLException` with vendor code 1142 for
   `UPDATE consent_event`, `DELETE FROM consent_event`, `REPLACE INTO consent_event`,
   `UPDATE consent_artefact SET consent_expiry = …`; and 1143 for
   `UPDATE consent_artefact SET status = 'ACTIVE', consent_expiry = … WHERE id = ?` — the
   *mixed* statement is the interesting one: the permitted column must not drag the forbidden one
   through.
2. **`GrantsGoldenTest`** — `SHOW GRANTS FOR CURRENT_USER()` as `ch_app`, normalised
   (upper-cased, column lists sorted) and compared to a committed
   `src/test/resources/db/grants-app.expected.sql`. Any grant broadened without an ADR amendment
   fails the build, which is the only thing that keeps a whitelist a whitelist after the first
   table is added for a new feature.

### 6. Enforcement, layer 2 — the mapping, the surface, and the ArchUnit test

#### 6.1 The entity

```java
@Entity
@Table(name = "consent_event")
@Getter                                    // no setters: an event is complete at construction
@Builder(access = AccessLevel.PUBLIC)       // LedgerWriter and the factories are the only callers
public class ConsentEvent {

  @Id
  // assigned by LedgerIdGenerator: insertable (we supply it), updatable = false (nobody changes it)
  @Column(name = "id", nullable = false, updatable = false)
  private UUID id;

  @Column(name = "artefact_id", updatable = false)          private UUID artefactId;
  @Enumerated(EnumType.STRING)
  @Column(name = "event_type", nullable = false, updatable = false) private ConsentEventType eventType;
  @Enumerated(EnumType.STRING)
  @Column(name = "actor_type", nullable = false, updatable = false) private ActorType actorType;
  @Column(name = "actor_id",        updatable = false)      private UUID actorId;
  @Column(name = "session_id",      updatable = false)      private String sessionId;
  @Column(name = "subject_ref",     updatable = false)      private byte[] subjectRef;
  @Column(name = "reason_code",     nullable = false, updatable = false) private String reasonCode;
  @Column(name = "source_prefix",   updatable = false)      private byte[] sourcePrefix;
  @Column(name = "client_agent",    updatable = false)      private String clientAgent;
  @Column(name = "artefact_sha256", updatable = false)      private String artefactSha256;
  @Column(name = "notice_body_sha256", updatable = false)   private String noticeBodySha256;
  @Column(name = "corrects_event_id", updatable = false)    private UUID correctsEventId;
  @Column(name = "correlation_id",   nullable = false, updatable = false) private String correlationId;
  @Column(name = "occurred_at",     nullable = false, updatable = false) private LocalDateTime occurredAt;
  @Column(name = "metadata",        nullable = false, updatable = false) private String metadata;
  @Column(name = "ledger_seq",      nullable = false, updatable = false) private long ledgerSeq;
  @Column(name = "chain_seq",       updatable = false)      private Long chainSeq;
  @Column(name = "prev_hash",       updatable = false)     private byte[] prevHash;
  @Column(name = "row_hash",        updatable = false)     private byte[] rowHash;
}
```

`updatable = false` on **every** field, asserted by a test rather than by convention, because the
convention is invisible: a future "just add `remark`" column that forgets the flag reopens the
mutation path with no reviewer looking. Deliberately **not** `@Immutable` (see Alternatives).

`id` carries `updatable = false` but deliberately *not* `insertable = false`: the application assigns
it (UUIDv7, §12.3), so an id excluded from the INSERT would be generated and then lost. Knowing the
id before the insert is what lets `data_access_log.event_id` reference a ledger row created in the
same transaction, and what will let §16's chain be filled without a second write.

#### 6.2 The repository surface

```java
@NoRepositoryBean
public interface InsertOnlyRepository<T> {
  <S extends T> S insert(S entity);        // fragment impl: em.persist(entity); never merge
}

public interface ConsentEventRepository
    extends Repository<ConsentEvent, UUID>, InsertOnlyRepository<ConsentEvent> {

  List<ConsentEvent> findByArtefactIdOrderByOccurredAtAscIdAsc(UUID artefactId);
  Page<ConsentEvent> findBySessionId(String sessionId, Pageable pageable);
  // and nothing else. No save, no saveAll, no delete, no @Modifying, no @Query with a verb.
}
```

Spring Data is not used as a base here on purpose: `JpaRepository` hands a repository `delete`,
`deleteById`, `deleteAllInBatch` and `saveAndFlush` *without declaring them*, and `save()` on an
entity whose id is already assigned calls `merge` — which is an UPDATE attempt with a friendly
name. A derived test (issue #21) asserts on `RepositoryInformation` and the interface's effective
method set — inherited methods included — so the guarantee is about the surface, not the source.

#### 6.3 The ArchUnit rules

Lands as `AppendOnlyLedgerRulesTest` in `consenthub-domain` (issue #25), beside the layering rules
of issue #23. The constructs below were checked against ArchUnit 1.4's public API — which is why
`R4`/`R5` are `noClasses()` rules (`callMethodWhere` lives on the class side, not the method side),
why the owner predicate is `assignableTo(...)` rather than a "is exactly this type" helper, and why
`R6` is two rules instead of one chained `orShould()`: the `noX().should().A().orShould().B()`
reading is ambiguous enough that a rule you have to think about is a rule someone will weaken.

```java
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import jakarta.persistence.EntityManager;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.transaction.annotation.Transactional;

import static com.tngtech.archunit.core.domain.JavaCall.Predicates.target;
import static com.tngtech.archunit.core.domain.JavaClass.Predicates.assignableTo;
import static com.tngtech.archunit.core.domain.properties.HasName.Predicates.nameMatching;
import static com.tngtech.archunit.core.domain.properties.HasOwner.Predicates.With.owner;
import static com.tngtech.archunit.lang.conditions.ArchConditions.callMethodWhere;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noMethods;

@AnalyzeClasses(packages = "com.consenthub",
                importOptions = ImportOption.DoNotIncludeTests.class)
class AppendOnlyLedgerRulesTest {

  static final String AUDIT = "com.consenthub.domain.audit..";
  static final String AUDIT_PERSISTENCE = "com.consenthub.infra.repository.audit..";

  // R1 — the ledger entities are reachable only from the audit slice. This is what forbids a
  // cascade/collection mapping from the aggregate, which is the sneaky mutation path in JPA.
  @ArchTest
  static final ArchRule ledger_types_are_audit_slice_only = noClasses()
      .that().resideOutsideOfPackages(AUDIT, AUDIT_PERSISTENCE)
      .should().dependOnClassesThat(
          assignableTo(ConsentEvent.class).or(assignableTo(DataAccessLog.class)))
      .because("consent_event and data_access_log are append-only (ADR-0003 §6); owning them in a "
          + "mutable aggregate would hand every aggregate root a delete path");

  // R2 — a ledger repository may expose insert/find/count/exists only. Names are the API here, so
  // the rule is about what callers can reach, not about what a file happens to contain.
  @ArchTest
  static final ArchRule ledger_repositories_are_insert_only = noMethods()
      .that().areDeclaredInClassesThat().haveSimpleNameEndingWith("Repository")
      .and().areDeclaredInClassesThat().resideInAnyPackage(AUDIT, AUDIT_PERSISTENCE)
      .and().arePublic()
      .should().haveNameNotMatching("(insert|find|count|exists|read)[A-Za-z0-9]*")
      .because("no save, no update*, no delete*, no @Modifying-flavoured mutator (ADR-0003 §6.2)");

  // R3 — no bulk statements against the ledger at all.
  @ArchTest
  static final ArchRule no_modifying_queries_on_ledger = noMethods()
      .that().areDeclaredInClassesThat().resideInAnyPackage(AUDIT, AUDIT_PERSISTENCE)
      .should().beAnnotatedWith(Modifying.class)
      .because("a JPQL update/delete string is invisible to every other rule in this class");

  // R4 — inside the audit slice, the only EntityManager verbs are persist and flush.
  @ArchTest
  static final ArchRule audit_slice_may_only_persist = noClasses()
      .that().resideInAnyPackage(AUDIT, AUDIT_PERSISTENCE)
      .should(callMethodWhere(
          target(owner(assignableTo(EntityManager.class)))
              .and(target(nameMatching("(merge|remove|lock|refresh|clear|detach|createQuery|"
                  + "createNativeQuery|setFlushMode|unwrap)")))))
      .allowEmptyShould(true)
      .because("merge is an UPDATE with a friendly name; remove is a DELETE (ADR-0003 §6.2)");

  // R5 — nothing anywhere may bypass the ORM into the ledger tables. Blunt on purpose: the ledger
  // has to survive a contributor who does not know they are touching it.
  @ArchTest
  static final ArchRule no_raw_sql_write_paths = noClasses()
      .that().resideOutsideOfPackage(AUDIT_PERSISTENCE)
      .should(callMethodWhere(
          target(owner(assignableTo(JdbcTemplate.class)))
              .and(target(nameMatching("(update|delete|execute|executeWithFlags|batchUpdate)")))))
      .allowEmptyShould(true)
      .because("JdbcTemplate.update('UPDATE consent_event …') is the one call ArchUnit cannot "
          + "police by type — so the method-name set is closed instead");

  // R6 — the ledger never opens its own transaction, and never runs off-thread: the caller's
  // transaction is the only one (§12.2). Two rules, not one, so each failure names its own cause.
  @ArchTest
  static final ArchRule ledger_writer_adds_no_transaction = noMethods()
      .that().areDeclaredInClassesThat().resideInAnyPackage(AUDIT, AUDIT_PERSISTENCE)
      .should().beAnnotatedWith(Transactional.class)
      .because("REQUIRES_NEW would let a rolled-back change leave a committed event behind");

  @ArchTest
  static final ArchRule ledger_writer_is_not_async = noMethods()
      .that().areDeclaredInClassesThat().resideInAnyPackage(AUDIT, AUDIT_PERSISTENCE)
      .should().beAnnotatedWith(Async.class)
      .because("an async auditor writes events for changes that may never have committed");
}
```

Two mechanical notes #25 has to handle, both of which are about the day the entities do not exist
yet:

- `ImportOption.DoNotIncludeTests` is what keeps the negative-control fixtures out of this import —
  they live under `src/test/java`, so the exclusion is a one-liner rather than a package convention.
- Since 0.23 ArchUnit **fails** a `noX()` rule whose filtered set is empty (`failOnEmptyShould`), so
  in week 1 every rule above is red for the wrong reason: not "someone wrote an update path" but
  "there is no ledger code yet". Hence `allowEmptyShould(true)` on the rules that are waiting for
  `LedgerWriter`, removed rule by rule as the code lands. That is a deliberate tightening sequence —
  a rule that starts permissive and ends strict, in commits you can see — and the moment the last
  one is removed is the moment §5's "enforced, not promised" becomes true in the build. A rule left
  permanently permissive is a rule that has already been weakened; #25 should not merge with
  `allowEmptyShould` still on a rule whose code exists.

R1 is the load-bearing one. Without it, someone puts
`@OneToMany(cascade = ALL) private List<ConsentEvent> events` on the aggregate for convenience, and
then removing an element from the list is a DELETE and changing one is an UPDATE — through a mapping
that no reviewer thought about as a write path. R1 also keeps JPQL entity names out of unrelated
`@Query` strings.

R3 leaves exactly one place in the codebase allowed to declare a bulk write:
`ArtefactRedactionRepository`, whose single `@Modifying UPDATE` sets the three §10 columns and nothing
else. So "how many statements in this system can mutate a row the ledger points at" answers back
*one, in one class* — a fact a reviewer can check in a minute, with tests proving the statement only
ever narrows a row.

**The negative control.** A rule that cannot fail proves nothing, so the suite ships the violation:
`AppendOnlyLedgerRulesViolationTest` runs `R2`/`R4` against a fixture package
(`com.consenthub.testsupport.appendonlyfixtures`, excluded from the main import above) containing a
deliberate `delete(UUID id)` on a ledger repository and an `em.merge(event)` in a fake writer, and
asserts the rule **evaluates to a violation**. That is what issue #23's "prove the rule bites"
criterion looks like for these rules: a red-rule test that is green because the red is expected, and
which goes properly red when someone "fixes" it by weakening the rule.

**And the DB is still the boss.** ArchUnit cannot see
`em.createQuery("update ConsentEvent set reasonCode = 'x' where id = :id")` — a string. The grant
can, and does. Conversely the grant cannot see `ALTER TABLE`, `DROP TABLE`, a restore, or an
administrator with `ch_migrate`; the tests and the hashes can. Two mechanisms, two blind spots,
each covering the other's — which is the whole reason the plan asks for both.

### 7. Enforcement, layer 3 — detection, because a grant proves nothing about the DBA

Everything in §5 and §6 protects the ledger from the application. None of it protects the ledger
from someone who can write it as `ch_migrate`, restore a snapshot, or edit a data file. For that
class we do not prevent, we **detect** — and detection has to be a value the ledger holds, not a
promise about its write path.

- **`consent_event.artefact_sha256`** = SHA-256 over the RFC 8785 (JCS) canonicalisation of every
  column of `consent_artefact` **except** the five the state machine owns (`status`, `paused_at`,
  `revoked_at`, `version`) and the three the erasure path owns (`redacted_at`,
  `redaction_dsar_id`, `subject_key_id`). So the hash covers *everything the lifecycle does not
  own*, including `consent_expiry`, the category snapshot and `signature` — which is why a
  privileged edit of the signature column is as detectable as an edit of the scope.
- **`consent_artefact.notice_body_sha256`** and **`notice_render_sha256`** pin the text (§9).
- **`LedgerIntegrityJob`**, weekly, `actor_type = SYSTEM`, raising `SECURITY_LEDGER_DRIFT`:
  1. for every artefact with ≥ 1 event, recompute the hash and compare with the newest event's;
  2. recompute every pinned notice body hash against `notice_version`;
  3. `DATA_ACCESSED` ↔ `data_access_log`: exactly 1:1 both directions (§13);
  4. every artefact has a `CONSENT_CREATED` row, and its terminal event is consistent with
     `status` (`ACTIVE` ⇒ no `CONSENT_REVOKED`/`EXPIRED`; `REVOKED` ⇒ a `CONSENT_REVOKED` exists);
  5. `served ⊆ granted` recomputed from the artefact's category snapshot for every access row;
  6. when §16's chain is enabled: continuity of `chain_seq`/`prev_hash` per artefact.
  A mismatch is a `SECURITY_LEDGER_DRIFT` row **and a page** — an invariant job whose only output is
  a log line is a rumour. Its schedule, batch size and the alert route are documented in the runbook
  (issue #86), alongside the FIU-key rotation and notification-replay procedures.
- **The grant is checked continuously**, not once: §5.4's golden test runs in CI, so "someone
  widened a grant" is a build failure rather than a discovery during an audit.

What detection cannot do, stated plainly: it proves a row was changed *against the values the ledger
itself holds*. An attacker with `ch_migrate` who edits an artefact **and** the `artefact_sha256` on
every event that references it leaves no mark inside this database. Only a value stored *outside*
it does, which is §16 — and why §1 calls the property "partly" true today.

### 8. Consent-artefact immutability: status in place, substance by lineage

The question issue #3 asks is *versioned-in-place vs strictly-immutable rows with lineage*, and the
honest answer is that the two are answers to two different questions.

**The rule: a column of `consent_artefact` may be `UPDATE`-able if and only if changing it does not
change what the customer agreed to.** The set is therefore exactly:

| Column | Why mutable in place |
|---|---|
| `status` | Lifecycle state, and the state machine (#31) is its only writer |
| `paused_at`, `revoked_at` | Timestamps *of* a transition; recording when something stopped is the point |
| `version` | Hibernate's optimistic lock; it exists to make in-place writes safe |
| `redacted_at`, `redaction_dsar_id`, `subject_key_id` | Erasure (§10) — they *reduce* information, and each write is itself a ledger row |

Everything else — `customer_id`, `fiu_id`, `purpose_code`, the category snapshot, `date_from`,
`date_to`, `consent_start`, `consent_expiry`, `fetch_type`, `frequency`, `data_life_days`,
`notice_version_id`, the notice hashes, `signature`, `sig_algorithm`, `signer_key_id` — is
**not** `UPDATE`-able, at three levels: `@Column(updatable = false)` on the entity, no method that
could try in the repository, and no privilege in the database.

**Changing substance means a new row.** `supersedes_id BINARY(16) NULL` and `migrated_from_id`
(the latter for #43's bulk migrations) carry lineage; `CONSENT_MIGRATED` is written on **both** rows
(so a reader of either timeline finds the other), and the old row's `status` becomes `REVOKED` with
`reason_code = SUPERSEDED_BY_NEW_ARTEFACT`. Notably absent from the mutable set:
`consent_start`/`consent_expiry`. A consent's validity window is part of what was agreed — under the
AA model an extension is a fresh artefact, not an edit — and so **a legal hold extends retention of
our records, never the life of a permission** (§11).

Why this hybrid rather than one of the two pure positions:

- **Pure versioned-in-place** (what a naive `@Version` + setters implementation gives you) makes the
  row a *running summary*. It loses the answer to "what did the row say before lunch", makes the
  signature unverifiable (a re-signed row is indistinguishable from an edited one), and turns every
  future dispute into "trust our process".
- **Pure immutable rows with lineage** for the whole artefact is the more principled design and it
  costs more than this project can pay for the same assurance: every other table's FK would need to
  name an artefact *version* (or a logical id plus a "which row is current" pointer — which is
  itself a mutable row, i.e. the thing we were trying to avoid); "exactly one `ACTIVE` row per
  logical consent" needs a partial unique index, which MySQL does not have and Oracle spells
  differently (ADR-0005 portability); the fetch path gains a hop for the single most latency-sensitive
  query in the system; and `@Version`'s optimistic-lock translation disappears (issue #17's
  acceptance test wants `OptimisticLockingFailureException`, which JPA raises for a managed versioned
  entity, not for an insert-or-fail protocol we would have to write ourselves).
- The hybrid keeps the *evidence* immutable (body, hash, signature, notice, ledger) and the
  *convenience* mutable (status), and then makes the mutable part reconstructible: the artefact row
  is a cache, and §7's per-event hash means an in-place edit of anything else is detectable.

A corollary worth writing down because it comes up in review: **`@Version` is on the artefact and is
deliberately absent from the ledger rows.** An append-only row needs no lock — nothing contends to
change it, and a version column on the ledger would be a mutable column in the one table where
mutation is the crime we are preventing.

### 9. The notice is pinned, hashed, and reconstructible without trusting anyone

"Proof of consent" is meaningless if we can only show that a customer clicked *something*. The
decision: **the artefact pins the notice version, and the pin is a hash as well as a foreign key.**

```sql
-- The text, published as immutable rows. This table is evidence, not configuration.
CREATE TABLE notice_version (
  id            BINARY(16)  NOT NULL,
  purpose_code  VARCHAR(32) NOT NULL,
  label         VARCHAR(16) NOT NULL,          -- 'v3' — what a human and a screenshot both read
  body_md       TEXT        NOT NULL,          -- Markdown; the portal sanitises on render (#64)
  body_sha256   CHAR(64)    NOT NULL,          -- of body_md, as inserted; the pin target
  effective_from DATETIME(6) NOT NULL,
  supersedes_id BINARY(16)  NULL,              -- the lineage that makes effective_to unnecessary
  published_by  BINARY(16)  NOT NULL,
  published_at  DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_notice_purpose_effective UNIQUE (purpose_code, effective_from)
) /*!40101 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci */;

-- consent_artefact gains exactly these:
--   notice_version_id   BINARY(16) NOT NULL      -- the pin
--   notice_body_sha256  CHAR(64)   NOT NULL      -- the pin, verified
--   notice_render_sha256 CHAR(64)  NOT NULL      -- the render the customer was actually shown
--   notice_render_version SMALLINT NOT NULL      -- which renderer produced it
```

Four decisions inside that shape:

- **`consent_event.notice_body_sha256` repeats the hash on every event**, so the timeline answers
  "what were they told *at that moment*", not just at approval. A `CONSENT_REVOKED` row whose notice
  hash differs from the `CONSENT_APPROVED` row's is a bug we want to see.
- **`effective_to` is dropped from the table, contradicting issues #14 and #17, on purpose.** Those
  tickets describe `notice_version` as "immutable rows" *and* set `effective_to` when a version is
  superseded — an `UPDATE` on an append-only table, which §5.2's grant refuses and §6's rule
  forbids. The fix is **not** a column-level exception for `effective_to`: a version's validity
  window is itself a fact about what a customer agreed to, and moving it quietly moves the ground
  under every artefact pinned to that version. Instead the window is *derived* —
  `effective_to = successor.effective_from − 1µs` via `supersedes_id` — and exposed as a read-only
  field on the entity (a `LEFT JOIN` in the audit query). Two properties fall out: a back-dated
  publish is impossible by construction, and a published notice can never be edited, so a typo in a
  live notice is answered by **a new version** (`NOTICE_SUPERSEDED`, `effective_from` strictly later)
  and — when the flaw is material — a re-consent campaign. A wrong notice is a compliance incident,
  not a data-entry bug, and this schema refuses to let it be either quietly.
- **`body_sha256` makes reconstruction verifiable.** The artefact says "the customer saw version 3
  of the KYC notice" and the hash says "and this text". If anyone ever edits a notice row — a
  well-meaning typo fix, which the grant forbids but `ch_migrate` can do — §7 step 2 catches it and
  every pinned artefact becomes an exact list of what was affected.
- **`notice_render_sha256` + `notice_render_version`** pin the *rendered* text, not just the source.
  The render is `body_md` + substitutions (FIU display name, purpose description, date range,
  category list) and it will change over time — a template tweak, an emoji fix, a locale. Without a
  render *version*, re-rendering an old artefact and comparing hashes cannot distinguish "the text
  was tampered with" from "we edited the template in 2027". With it, the answer is exact. The
  renderer's own git tag is recorded in `message_catalog` alongside the reason-code wording (§3),
  so "what did the screen look like" has a version number at every layer: notice body, render,
  wording.

**Reconstruction, end to end** (`GET /api/v1/consents/{id}/notice`, issue #26/#36; the UI is #64):
read the pin → verify `body_sha256` → render with the `notice_render_version` renderer (kept
available for every version the table can reference; retiring a renderer is a §11-documented
change, not a deletion) → compare `notice_render_sha256` → show it with the version label, its
`effective_from`/derived `effective_to`, and the hash prefix. The response carries
`isCurrentVersion: false` whenever the pin lags the purpose's newest version, because the customer
must be able to tell "this is what you agreed to" from "this is what we would show you today".
**The text shown for an old consent is always the pinned one** — #64's acceptance criterion,
discharged by a column.

And the honest limit: the notice bodies are ours (published text, not personal data), so they are
**never erased** and reconstruction survives §10. The per-customer *substitutions* (FIU name,
purpose wording) live on the artefact row, whose non-personal columns survive too. A shredded
customer's consent is still reconstructible as "the notice for `KYC_VERIFY`, version 3,
sha256 3f9a…, effective 2026-07-01" — which is exactly the answer the regulator wants and is not
about anyone.

### 10. Erasure deletes personal data. It does not delete the audit trail.

This is the section a regulator reads first, so it is written as an explicit rule with a procedure,
not as a comment near a `@DeleteMapping`.

> **A data principal's erasure right reaches personal data. It does not reach the record that
> consent existed.** Between now and the end of the §11 retention clock, the ledger keeps the fact
> and loses the ability to link it to a person.

The tension is real and not resolvable by picking a side: DPDP §8(7) and §12 require erasure when
the purpose is spent or consent is withdrawn, **unless retention is necessary for compliance with a
legal obligation**; the consent-record obligation in the DPDP Rules (First Schedule, Part B —
records of consents, notices and sharing, retained **seven years**, in tamper-proof, machine-readable
form) is precisely such an obligation. Deleting the ledger to honour an erasure would breach the
other half of the same law, and — worse — would destroy the evidence that the erasure itself was
lawful.

**The mechanism that makes both true is that the ledger holds no personal data to delete.** Direct
identifiers are never written into it (§3: reason *codes*, masked prefixes, parsed agents, a
type-validated `metadata`); the only thing tying rows to a person is
`subject_ref = HMAC-SHA256(k_customer, customer_id)`. So erasure is a **key operation**, not a
`DELETE`:

1. **Gate.** `POST /api/v1/dsar` (#44) raises `type = ERASURE`, `due_at` from the SLA policy. A
   `SUPERVISOR` executes by creating an `ApprovalTask(ERASURE_EXECUTION)` — four-eyes per #43,
   maker ≠ checker, and step-up re-authentication inside 300 s per ADR-0002 §6. Erasure never
   executes without an approved task; the endpoint rejects it (that is #44's second AC).
2. **48-hour notice to the data principal** before the destructive step, with a documented way to
   say "keep my data". (The Rules require this notice for Third-Schedule platforms; we adopt it for
   every erasure, because the awkward question — "you deleted my records while I was mid-dispute" —
   deserves an answer that is not "we are legally exempt".)
3. **Personal payload → shredded.** The DEK for that customer is destroyed in place:
   `data_key.wrapped_key = NULL`, `shredded_at = now` — the two columns §5.2 grants for exactly
   this, and the only way that row may ever change, so the destruction itself stays queryable.
   Everything encrypted under `k_customer` —
   `customer` contact fields, the DSAR export bundle, notification payloads still in
   `outbox_message` — becomes unrecoverable ciphertext. The backup-residue question that
   DPDP-style deletion always raises ("no residual data in backups or DR archives") is answered by
   the design rather than by a promise: the ciphertext in the backup is worthless without the key,
   and key rotation is a runbook procedure (issue #86) whose failure mode is loud.
4. **Business rows → redacted in place.** `customer`'s personal columns are set to `REDACTED`
   (that table has full DML; it is a service row, not evidence). On `consent_artefact` the three
   §8 columns are written (`redacted_at`, `redaction_dsar_id`, `subject_key_id = NULL`), which
   *narrows* the row and is the only write the erasure path may make there. `subject_key_id` names
   the `data_key` row whose key produced that artefact's `subject_ref`: set at creation, nulled at
   shred, so "which key hashed this" is answerable while the key lives and permanently unanswerable
   after — which is why the table needs exactly the two §5.2 columns and nothing more:

   ```sql
   CREATE TABLE data_key (                   -- one row per customer; k_customer lives here
     id BINARY(16) NOT NULL, customer_id BINARY(16) NOT NULL,
     wrapped_key VARBINARY(512) NULL,        -- DEK wrapped by the platform KEK; NULL once shredded
     created_at DATETIME(6) NOT NULL, shredded_at DATETIME(6) NULL,
     PRIMARY KEY (id), CONSTRAINT uq_dk_customer UNIQUE (customer_id)
   );
   ```

   `app_user` for the `CUSTOMER` role is **deleted** — it is pure service data, and the ledger keeps
   no FK to it (§2), so the deletion strands nothing. That is the only `DELETE` in the erasure path,
   and it is allowed precisely because `app_user` is service data rather than evidence.
5. **Ledger rows → untouched, and unlinkable.** `consent_event`/`data_access_log` keep every row,
   including the ones whose `subject_ref` can no longer be tied to a person by anyone holding our
   database. `k_customer` never existed in the ledger, so the ledger's `subject_ref` values cannot
   be re-derived by a future attacker.
6. **The erasure is itself an event**: `DSAR_COMPLETED`, `actor_type = SUPERVISOR`, with
   `artefact_id = NULL` (the erasure is about the person, not one consent) and
   `metadata = {dsarId, keysDestroyed: 1, rowsRedacted: {customer: 1, artefact: 7, appUser: 1},
   ledgerRowsRetained: 214, retainedUntil: 2033-09-15,
   legalBasis: DPDP-RULES-SCH1-B-CONSENT-RECORDS, noticeSentAt}`. Every leaf is an id, a count or a
   date, so the row passes §3's validator — which is the point: the explanation of why the ledger
   survived is *legible data*, not a paragraph someone could have typed differently.
7. **The customer receives an erasure certificate** (machine-readable, from the DSAR export
   endpoint): what was deleted, what was destroyed, and *what was retained, under which legal
   obligation, until when, and how to complain to the Board*. The uncomfortable answer is stated in
   the response instead of being left for the auditor to find. `GET /api/v1/consents/{id}/events`
   for a redacted artefact returns the timeline with `subjectRef` present and `customer: null`, plus
   `redacted: true`.
8. **Sessions die.** Every token family for that user is revoked (ADR-0002 §5), which pushes each
   `family_id` onto the Redis deny-list and writes a `SECURITY_SESSION_REVOKED` row — so "the
   erasure cut them off" is provable and not merely asserted.

Order matters, and it is worth a sentence: the key is destroyed **after** the redactions and
**before** the `DSAR_COMPLETED` row, so a crash mid-procedure leaves a redacted row with a live key
(recoverable, alarm-worthy) rather than an unredacted row with no key. A rollback of the whole
transaction (including the §12 watermark) restores every step, and #44's erasure flow is therefore
one transaction.

**Who may be forgotten, and who may not** — recorded because the question will be asked about
agents, not just customers:

| Actor | On their own erasure request | Why |
|---|---|---|
| `CUSTOMER` | Identity and personal payload deleted; consent records retained under §11 | The consent record is the platform's legal obligation, not the customer's service data |
| `AGENT`, `SUPERVISOR` | Personal columns (`email`, `phone`, `display_name`) redacted; `id`, `username`, role history retained 7 years | Their *acts* are the regulated record — an audit trail that forgets which supervisor approved an erasure is not an audit trail. Their identity is recoverable from their employer's HR records, which are a different controller's business |
| `FIU` (service account) | Credentials rotated and revoked immediately; the FIU's identity retained | The counterparty to a data-sharing arrangement is the point of the record |
| `SYSTEM` | n/a | Not a person |

The last column is the one that makes this defensible rather than merely convenient: erasure is not
a right to destroy *someone else's* evidence about you, and for a consent platform the identity of
the party that approved a disclosure is exactly that.

### 11. Retention, archiving, and who may purge

Numbers, because a policy without a number is an intention.

| Data class | Online (queryable) | Total retention | Clock starts | Deletion method |
|---|---|---|---|---|
| `consent_event`, `data_access_log` | **24 months** | **7 years** | the artefact's terminal event (`CONSENT_REVOKED` / `CONSENT_EXPIRED` / `CONSENT_DENIED`); for artefacts linked to a sanctioned facility, **10 years** per the PMLA maintenance-of-records rule — take the longest applicable | archive-then-purge, §11.3 |
| `notice_version`, `message_catalog` | indefinitely | same as the ledger | — | never purged while any artefact pins them (checked by the job, §11.2) |
| `consent_artefact` (redacted row) | indefinitely | same as the ledger | terminal event | kept as the ledger's join target; §10 step 4 |
| `customer`, `app_user` | account lifetime | erasure + purpose-based | — | §10 |
| `dsar_request` | 7 years | 7 years | completion | with the ledger (it *is* ledger-adjacent evidence) |
| `notification_log` | 24 months | 7 years | last attempt | with the ledger |
| `outbox_message` | until `SENT` + 30 days | — | `SENT` | plain `DELETE` (it is a queue, not evidence; #19) |
| `refresh_token` rows | per ADR-0002 §1 (hourly cleanup of rows expired > 24 h) | — | — | `DELETE` |
| Structured app logs | 400 days | **1 year minimum** | date of processing | log retention (§3 depends on it: the unmasked IP and raw UA live only here) |
| Backups + binlog | 35 days rolling | personal data: shredded by key loss (§10) | — | key rotation makes old backups unreadable; the ledger's backups stay restorable for its own clock |

The 7-year figure is the DPDP Rules' consent-record floor for a consent manager
(First Schedule, Part B: records of consents given/denied/withdrawn, the notices accompanying them,
and data-sharing activity, at least seven years, in tamper-proof machine-readable form). It is also
comfortably longer than the three-year civil limitation baseline, which is the second reason a
consent platform's ledger exists. It is **not** "forever" — indefinite retention is the answer DPDP
rejects, and an unbounded retention claim is what makes a regulator suspicious rather than reassured.

#### 11.1 Legal holds, which cannot live on a row

A hold cannot be a column on `consent_event`: setting `on_hold = true` is an `UPDATE`, and the whole
point of §5 is that the application cannot write that table twice. So holds are a separate, small,
mutable table the purge consults:

```sql
CREATE TABLE retention_hold (
  id BINARY(16) NOT NULL, artefact_id BINARY(16) NULL, subject_ref BINARY(32) NULL,
  reason_code VARCHAR(32) NOT NULL, authority_ref VARCHAR(64) NOT NULL,   -- matter / order number
  placed_by BINARY(16) NOT NULL, placed_at DATETIME(6) NOT NULL,
  released_by BINARY(16) NULL, released_at DATETIME(6) NULL,
  PRIMARY KEY (id), CONSTRAINT ck_hold_shape CHECK ((artefact_id IS NULL) <> (subject_ref IS NULL))
);
```

Placing or releasing a hold writes `POLICY_LEGAL_HOLD_PLACED` / `_RELEASED` into the ledger, so the
hold has its own audit trail and the release is attributable. A held range is excluded from every
purge, and a hold cannot be released by the person who placed it (four-eyes, #43). The table follows
the ledger's own discipline — `INSERT`-only plus exactly two `released_*` columns (§5.2), which is
why "was this hold ever quietly dropped?" is answerable from the rows rather than from git blame.

#### 11.2 The purge is not automatic

The retention job **reports; it does not delete.** A bug in a scheduler must not be able to destroy
evidence, so the weekly job writes a candidate report (ranges, counts, the notices that would become
unreferenced) and an operator decides. The runbook (issue #86) owns the procedure. Two extra rules:
a notice version or a message-catalogue row still pinned by any artefact inside a retained range is
never eligible; and a purge whose range contains an artefact with an open DSAR or an active hold is
skipped with a logged reason.

#### 11.3 Purge authority, and the archive-before-delete rule

| Step | Who | Mechanism |
|---|---|---|
| Propose a purge range | `ADMIN` (compliance), from the job's report | out of band, recorded in the task |
| Authorise | `ApprovalTask(LEDGER_PURGE)`: maker and checker both `ADMIN`, **distinct**, checker ≠ maker enforced at service and DB level (same shape as #43) | four-eyes |
| Fresh credential | Step-up re-authentication within 300 s (ADR-0002 §6) | a purge is destructive enough to deserve a typed password |
| Prove it is copied first | `ledger_archive_verify`: downloads the range, recomputes the row hashes, verifies the manifest signature and the Merkle root against the object store's version id | **no archive manifest, no purge** |
| Delete | only `ch_migrate`, via a reviewed stored procedure that takes a range and writes its own `POLICY_PURGE_COMPLETED` row into the *surviving* range first | the app role physically cannot; that is the point |
| Certify | a signed purge manifest (range, counts, row-hash Merkle root, approvers, legal basis, expiry date) is written to the external store and **must not be in the range being purged** | the ledger cannot record its own deletion; the certificate is outside |

The archive-before-verify step is worth its cost because it inverts the usual failure: an early
purge that destroyed records was unrecoverable, whereas a refused purge merely leaves rows a quarter
too long. A range whose manifest signature does not verify is not eligible, no matter who asks.

Retention *policy* is data, not code: a `retention_policy` table (per data class, `years`,
`legal_basis_code`) read by the job. That is not a loophole — the ledger is the proof of policy
*compliance*, not of policy *content*, and a policy change writes `POLICY_CHANGED` with old and new
values, so "who shortened the clock, when, and under what argument" is itself an answerable query.
`retention_policy` is `UPDATE`-able by `ch_migrate` only, and its write path is an admin service with
the same four-eyes gate as §11.3.

### 12. Writes: one path, one transaction, and a ledger that keeps its own clock

#### 12.1 One door in

`LedgerWriter.append(eventType, artefactId?, actor, reasonCode, metadata)` is the **only** code path
that writes either table. It is the single point where §3's checks happen (required actor/reason/
timestamp, the `metadata` allowlist), where `occurred_at` and `ledger_seq` are stamped, where
`artefact_sha256`/`notice_body_sha256` are computed, and where the §7 hash is verified against the
artefact before insert. ArchUnit R1 plus `InsertOnlyRepository` (no `save`) plus the R5 ban on raw
`JdbcTemplate` make "we wrote it through the writer" a structural fact rather than a convention.
`LedgerWriter` does **not** swallow exceptions, and it is not `@Async` — see §12.2.

#### 12.2 The invariant, and why the writer never commits on its own

> **No state change without its ledger row, in the same transaction. The transaction fails if the
> row cannot be written.**

Consequences, all accepted deliberately:

- A `CONSENT_EXPIRED`-without-an-event or an event-without-a-transition is not expressible: the row
  is rolled back with the change. A rollback can therefore leave a gap in `id`/`ledger_seq`, and
  gaps are **not** tamper evidence — which is why §7 verifies hashes over rows, not ids.
- An audit-store outage is an outage of consent *changes*. We accept that: an event log that can
  silently drop entries is worthless, and the alternative (append best-effort) optimises the wrong
  side of the trade.
- **`REQUIRES_NEW` and `@Async` are forbidden on the writer** (ArchUnit R6), because they let a
  rolled-back business change leave a committed event behind — a ledger row claiming something that
  never happened is worse than no row.
- Conversely: an access **refusal** is recorded (ACCESS_DENIED) in its own transaction, because the
  refusal is the fact and there is no state change to be faithful to. #41's
  "access row + outbox row in the same transaction" is the same rule, not a second one.
- This is also why the ledger is not a Kafka topic or a separate audit microservice (§Alternatives):
  an event stream cannot be in the database's transaction, so "the transition happened but the event
  was lost" becomes a real state, and a `SELECT` on the timeline becomes a cross-service read of a
  projection that may lag. A consent platform's audit trail has to be *read-your-write* consistent or
  it is a metric, not evidence.

#### 12.3 Ids and ordering

- `id` is an **application-assigned UUIDv7** (RFC 9562), stored `BINARY(16)`. Four reasons: no
  `AUTO_INCREMENT` (ADR-0005 bans it, and Oracle spells sequences differently); unguessable
  identifiers, which is the IDOR posture issue #30 asks for; time-ordered, so a B-tree primary key
  does not fragment the way a random UUIDv4 does; and known *before* insert, which is what lets
  `data_access_log.event_id` reference a row created in the same transaction and what will let §16's
  chain be filled without a second write. Mapping note for #18: the column is `updatable = false` but
  **not** `insertable = false` — the id has to reach the INSERT precisely because we assign it, and an
  `insertable = false` id is the classic way to generate a value and then silently drop it.
- **Clock discipline.** `occurred_at DATETIME(6)` comes from an injected `Clock.systemUTC()` (a
  controllable clock in tests, per #51's AC), never from a DB default — a vendor-specific
  `CURRENT_TIMESTAMP` default is banned by ADR-0005, and DB-clock-defaulted rows cannot be tested
  with a fake clock. Instances run under NTP with a monitoring alert at **2 s** of skew; at
  microsecond precision, uncoordinated clocks *will* otherwise produce visibly out-of-order audit
  rows, which is the kind of detail that costs credibility in a demo.
- **Canonical order for humans is `(occurred_at, id)`** — #37's stated order, and correct: two
  events in the same transaction commit in `id` order, and cross-instance skew can misorder
  *display* rows without changing what happened. Canonical order for the §16 chain is
  `ledger_seq`, then `id`. The API always returns both fields, so a consumer never has to guess
  which ordering a screen used.
- `record_count` and `metadata` are the only quantitative fields; nothing in the ledger is a
  `DECIMAL` (money is not this table's business) and every timestamp is `DATETIME(6)` in UTC with
  `utf8mb4` on text columns, per #13.

#### 12.4 The watermark, and what it proves

Two small mutable tables carry per-key counters that can only move forward —
`customer_ledger_seq(customer_id, last_seq)` for rows with a `subject_ref`, and
`ledger_counters(scope_key, last_seq)` (one per `fiu_id`, one `GLOBAL`) otherwise. Every
`LedgerWriter.append` takes the row `FOR UPDATE` (a single lock, no deadlock cycle, since no code
path takes two of them) and stamps `ledger_seq = last_seq + 1` in the same transaction as the insert
and the business change.

That gives three things a grant cannot:

1. **Erasure is a range statement.** "Everything of this subject with `ledger_seq ≤ the current
   watermark`" is finite, bounded and crash-restartable; the DSAR job can checkpoint progress
   against the watermark. `WHERE subject_ref IN (...)` over an unbounded, still-growing set is
   none of those, and would become the worst query in the system by year two.
2. **A snapshot restore becomes loud.** After a restore, the DBA raises
   `last_seq` to the last row present; every append of that subject then gets `ledger_seq ≤` the
   raised value → `WATERMARK_REGRESSION`, which writes no ledger row (the watermark is exactly
   what is in doubt) and only alerts. Note that `MAX(ledger_seq)` gives the same detection and *no*
   erasure bound; the counter earns its two extra writes by being both.
3. **`POLICY_LEGAL_HOLD_RELEASED` is answerable** — the sequence is contiguous per key within an
   archive range, so "which rows were purged and when" is a lookup.

A legal hold that spans months freezes the range but not the counter; the counter is per-subject
bookkeeping, not a lock on the data. The write amplification (one extra row lock per ledger append)
is the cost, and it is small: contended only for one subject's own events.

### 13. The read side, and auditing the reading of the ledger

#### 13.1 Two access tables on purpose

`consent_event` (`DATA_ACCESSED`) and `data_access_log` overlap, and that is a decision rather than
an accident:

| | `consent_event` `DATA_ACCESSED` | `data_access_log` |
|---|---|---|
| Answers | "this artefact was used, by whom, when, from where" | "what data left the platform for you, and how much of it" |
| Reader | ops, investigators, the state machine | the customer's transparency timeline (#40), the FIU's own reconciliation |
| Shape | one row per event of any kind; joins the whole lifecycle | wide, flat, self-contained — shaped for a timeline that must not `JOIN` to render |
| Masking | `source_prefix`, `client_agent`, `actor_id` masked for `CUSTOMER` (#37) | no secrets in it at all; `fiu_id` renders to a display name |

The alternative was one table with a `kind` discriminator (uniform queries, one index set) or
`data_access_log` as a pure projection of the events (no duplication). We keep both tables because
they are read by adversaries of each other — the log is customer-facing and must be provably a
*subset* view of the ledger, and a projection you cannot `SELECT` without `SELECT` on the ledger
gives the customer's screen the same permissions as an investigation. #40's AC
("the log matches the audit ledger exactly, cross-checked in one integration test") is only
meaningful if there are two things to compare. The duplication is made safe by `UNIQUE (event_id)`
plus the same transaction: an access row that exists without its event, or the reverse, is a
§7 finding, not a possible state. **One ledger row per successful fetch, one access row per
successful fetch.** A batch fetch serving three FIUs from one artefact writes one access row per FIU
plus one `DATA_ACCESSED` — the count is `record_count` on the access rows, so the arithmetic works.
Denied fetches write only an event (there was no access); the *decision* is customer-visible, the
refusal is not a data movement.

#### 13.2 Reads are audited, with a stopping rule

`GET /api/v1/audit` writes an `AUDIT_READ` row; `GET /api/v1/audit/export.csv` writes
`AUDIT_EXPORTED`. This is not decoration: the ability to ask "who looked at this customer, and when"
is what makes an insider detectable, and #46 lists it as an acceptance criterion. Three rules keep
it sane:

1. **The recursion terminates at depth one.** Writing an `AUDIT_READ` row does not itself produce
   one (the writer checks `eventType` before appending; the read path for `AUDIT_*` rows is not
   audited). An admin browsing the audit viewer generates exactly one row per query, not one per
   row browsed, and not a self-sustaining loop.
2. **The filter is stored as ids and codes, never as prose** — `{customerId, purposeCode,
   eventTypes, rangeFrom, rangeTo, rows, page}`. That is both §3's rule and the answer to "does
   auditing reads create a record about the *reader* that is itself personal data?" — yes, and it is
   attributed, minimised and retained on the same clock as everything else, which is the honest
   position: an agent's searches are the regulated record.
3. **The export is pinned.** `AUDIT_EXPORTED.metadata` carries `rowCount`, `filterSha256` and the
   `sha256` of the CSV bytes. A spreadsheet an auditor emailed in 2029 can be checked against the
   ledger — which also means the *stable column order* and the documented row cap in #46 become part
   of a hash, so they cannot be changed casually. (CSV formula-injection escaping is #46's own
   criterion; it changes the bytes, and that is fine, since the hash is of what we sent.)

Reads of the ledger by `SYSTEM` jobs (§7, the retention report) are **not** audited — they would add
noise without attribution value, and every job already writes its own outcome rows.

#### 13.3 The customer timeline is rendered from the ledger, not stored in it

The ledger's wording will change; the data will not. `message_catalog(code, version, locale, text)`
maps a `reason_code` to a sentence, is versioned, and the *version used* at render time is recorded
in the API response as a debug field (`messageVersion: 2026-09-01`) so a screenshot from 2027 can be
reproduced. `GET /api/v1/consents/{id}/events` (#37) therefore returns:
`{id, occurredAt, eventType, actorType, actorDisplay, sessionId?, reasonCode, reasonText,
reasonTextVersion, maskedFields[], verification: {artefactSha256, noticeBodySha256, match}}`
— with `actorDisplay` produced by the server under the caller's authorisation (masked for
`CUSTOMER`, full for `SUPERVISOR`/`ADMIN`) and `match` computed live by §7 step 1. Showing a
customer the hash prefix of the text they agreed to is the cheapest credibility move in the product,
and it is free once §9 exists.

### 14. Corrections: a wrong row is answered with a new row

A regulator, an FIU or a customer will occasionally establish that a ledger row is wrong — a fetch
attributed to the wrong `fiu_id`, a `CONSENT_EXPIRED` the job stamped twice before #51's idempotency
test existed. The temptation is to `UPDATE` it, and that is the moment the append-only claim is
actually tested.

Decision: **append, reference, display both.** `corrects_event_id` points at the row being
corrected; `CONSENT_CORRECTED` (or `POLICY_CHANGED` for a metadata-only fix) carries the new facts in
`metadata`. The corrected row is *never* hidden: the API returns both, the UI renders the original
struck through with a tooltip naming the correcting row, and `GET /api/v1/audit` filters on
`isCorrected=true` so an investigation sees the corrections first. Rationale: an audit trail whose
errors are invisible is not an audit trail, and "we edited it" is a survivable finding while
"we edited it and hid the edit" is a career-ending one. Two related rules:

- A correction may not change the *facts of an access*. If the ledger says FIU X received data and
  they did not, the correction is a `DSAR_*`/`POLICY_*` row plus an out-of-band reconciliation with
  the FIU — not a claim that the bytes did not move. We record what we know, not what we would prefer.
- `REINSTATED` exists for a revoked consent restored by `ApprovalTask(CONSENT_REINSTATEMENT)`
  (four-eyes, #43), on a new artefact row (§8's lineage rule) with `supersedes_id` pointing at the
  revoked one and `CONSENT_MIGRATED` on both. There is no `UPDATE ... SET status = 'ACTIVE'` path for
  a revoked consent: the state machine's terminal states stay terminal (#31), and a reversal is a
  new artefact, because a permission the customer withdrew is not the same permission.

### 15. Explicitly not in scope

Named, so the next engineer does not have to re-decide them under deadline pressure:

- **No GDPR-fidelity features.** No per-row lawful-basis column, no records-of-processing export
  beyond §13's CSV, no DPO approval workflow UI. `retention_policy.legal_basis_code` is the extent of
  it.
- **No PII scrubbing of historic rows.** The masking decision is made at write time (§3), because a
  ledger that can be edited later is not one. A row written before this ADR (i.e. before the first
  migration, so: none) is not our problem, and a row written *after* is permanent. If we decide the
  raw UA was a mistake, the fix is a new event type plus a §7 note, never a rewrite.
- **No general data lineage, no CDC, no analytics mirror of the ledger.** The archive (§11.3) is the
  only export path. A read replica is acceptable; a *writable* replica or a BI warehouse that can
  feed back into the platform is not.
- **No per-user "who saw what screen" telemetry.** We audit API reads of the ledger, not UI events.
- **No signature on ledger rows** — §16 is the cheap version of that, and #91 signs artefacts.
- **Not covered here: outbox, notification delivery, and the expiry job's correctness.** They are
  §12's *producers*, and their own tickets (#48, #51) own their semantics.

### 16. The anchor, staged

The one property §5–§7 cannot deliver is proof against a privileged writer who edits rows *and*
their hashes. The fix is a value that lives outside the database, and it is staged rather than
promised:

| Stage | What ships | When |
|---|---|---|
| 0 (now) | Columns `chain_seq`, `prev_hash`, `row_hash` exist, nullable, unused | with #13, this sprint |
| 1 | `LedgerWriter` fills them: per-key `chain_seq` from §12's counter; `row_hash = SHA-256(JCS(canonical row) ‖ prev_hash)` | with #18/#31, when the writer exists |
| 2 | `LedgerIntegrityJob` verifies chain continuity per key and writes `SECURITY_LEDGER_DRIFT` on any break | with #25's harness |
| 3 | Nightly **anchor**: for a closed date window, `{firstId, lastId, count, merkleRoot, prevAnchorHash}` is signed (Ed25519, key shared with #91's signing service), written to append-only object storage **with versioning + object lock**, and a `POLICY_ANCHORED` row is appended to the ledger itself | stretch — the only *new* ticket this ADR asks anyone to file |

Why stage 0 is the only part that is actually urgent: **the chain cannot be backfilled without
rewriting history.** Adding `prev_hash` to a table whose premise is that nobody can rewrite it is
self-refuting, so a chain either starts with the first row or it never proves anything about the
rows before it. Reserved nullable columns cost ~96 bytes a row and buy a future; retrofitting them
after year one costs a migration that is itself an act against the ledger. Everything in stage 3 is
an engineering decision we can make later without weakening an earlier one — which is the definition
of a properly staged one-way door.

Stage 3 also fixes the property §7 leaves open, in the only way that works: an anchor *outside* the
database cannot be rolled back with it, so a snapshot restore either matches a published root or it
does not. That is when §1's middle row stops saying "partly".

## Consequences

**Positive**

- **"Append-only" becomes a testable property instead of a comment.** `ERROR 1142` on four
  statements, a golden `SHOW GRANTS` file, six ArchUnit rules with a negative control, and a
  repository surface with no method to call. Every one of them is in the build, so the claim
  survives a contributor who never read this document.
- **The whitelist outlives the feature churn.** Because nothing is granted at schema level, a new
  table cannot accidentally inherit write access to the ledger, and a forgotten grant fails loudly
  in dev on first use rather than silently weakening a guarantee nobody notices until an audit.
- **The artefact's mutability stops being an embarrassment.** §8's "status in place, substance by
  lineage" gives a reviewer a one-sentence test for any new column, and §7's per-event hash means
  the mutable head can be verified against the immutable record instead of trusted.
- **Erasure and retention stop fighting.** The ledger holds no prose, no names and no unmasked
  network identifiers, so honouring §12 destroys a key and redacts three columns while the
  evidence survives — and the erasure's own row states the retention basis and end date, so the
  exception is documented in the artifact rather than in an email.
- **Attribution is finally concrete.** `session_id` as a column with an index (the thing ADR-0002
  §6 asked for) turns "which supervisor's session, from which /24, using a script, read this
  customer, and exported what" into one query — and reading the answer is itself recorded.
- **The customer-facing claims become cheap.** #40's "who fetched what, when, for what purpose" and
  #64's "this is the text you saw, version 3, sha256 3f9a…" are reads of rows we are already
  writing.
- **Rollback consistency for free.** App-assigned UUIDv7s and same-transaction writes mean a
  rolled-back change leaves no orphan event, and a restored snapshot is caught by §12.4's watermark
  instead of quietly becoming the truth.
- **The one-way doors are shut now** (§16's reserved columns, `subject_ref`, the mask-at-write rule,
  the drop of `effective_to`), which is the entire reason this ADR is a Week-0 artifact and not a
  Week-5 cleanup.

**Costs / trade-offs**

- **An audit failure now fails the business write.** If `consent_event` is unwritable, consent
  changes fail — deliberately (§12.2). Capacity, an index bloat, a locked table: all of them now
  affect availability, so the ledger's indexes have to be reviewed like a hot path, because they are
  one.
- **Two DB roles, forever.** Every environment needs `ch_migrate` and `ch_app`, the compose stack has
  to create both, and a developer who runs the app as root has *no wall at all* — the golden test is
  what makes that visible, and the Testcontainers harness is what makes it irrelevant to CI.
- **Column-level grants are an unusual tool.** They are supported by MySQL and Oracle for
  `SELECT`/`INSERT`/`UPDATE`/`REFERENCES` — and **not** for `DELETE`, which is why the ledger gets no
  delete at all rather than a "delete nothing" trick. Some connection poolers and dump/restore
  tooling handle column grants poorly; the escape hatch is recorded in Alternatives (a separate
  audit schema), which costs the shared transaction and is therefore not taken.
- **Dev ergonomics get worse in one specific way.** Seeding, truncating and repairing fixtures must
  run as `ch_migrate`, and `@DataJpaTest` cannot test the grant at all (H2 has no privilege system) —
  so the tests that matter are Testcontainers tests, which are the slow ones. Accepted: issue #22's
  container reuse keeps the suite inside its 3-minute budget.
- **Erasure is cryptographic, so it is irreversible in a new way.** Losing `data_key` material
  destroys the DSAR export bundle *and* the personal payload for that subject permanently; there is
  no "restore from backup and re-run it". Key custody and the rotation runbook become compliance
  infrastructure, and the 48-hour pre-erasure notice exists partly because of that.
- **Two mutable counter tables sit next to an immutable one.** `customer_ledger_seq` and
  `ledger_counters` are the only tables the ledger design makes mutable, and their sole purpose is
  ordering; §12.4 is required reading for whoever touches them.
- **`metadata` needs a validator and a key allowlist per event type**, which is about a day of work
  that a plain JSON column would let us skip — the price of §3's "no prose in the ledger".
- **The chain columns are dead weight until stage 1.** ~96 bytes a row for something that verifies
  nothing yet, and a reviewer is entitled to ask why. §16's answer — a chain cannot be backfilled —
  is the whole justification.
- **`consent_expiry` cannot be corrected in place** (§8), so a wrong window is answered by a new
  artefact row and two events. More ceremony for a rare case, chosen because the alternative is a
  mutable field inside the signed payload.
- **Reads of the ledger grow the ledger.** A busy audit viewer is a write path; hence §13.2's
  depth-one stopping rule, and hence the 24-month online window in §11.

## Alternatives considered

### A DB trigger that raises on `UPDATE`/`DELETE` — rejected

Portable in spirit (MySQL fires the trigger before the statement), and it can carry an
`ORA_SQL_ERR`-style message that a comment cannot.

**Why it lost:** ADR-0005 bans vendor-specific DDL, so it is either two implementations (one per
engine, one of them wrong by the time it matters) or a shared subset that does not exist —
`BEFORE UPDATE … SIGNAL SQLSTATE` is MySQL syntax and Oracle needs a compound trigger. Worse, it
hides the rule from the only place reviewers look: a trigger is invisible in a PR, and the guarantee
would then be enforceable only by someone remembering to query `information_schema`. And a trigger
owns its table's write path, which makes it the natural home for the business logic that belongs in
the state machine. We take the property we wanted from it — a refusal *inside* the database — from
the grant instead, which is data in `mysql.tables_priv` and portable to both engines.

### Hibernate `@Immutable` on the ledger entities — rejected

One annotation, and Hibernate stops dirty-checking the entity entirely.

**Why it lost:** it converts an attempted mutation into a **silent no-op**, which is the worst
failure mode of the three layers: a developer adds `event.setReasonCode(…)`, nothing throws, the test
passes, and the behaviour they wanted is quietly absent. `@Column(updatable = false)` gives the same
storage guarantee and is standard JPA, and the *loudness* is supplied where a developer can hear it —
the repository has no method, ArchUnit fails the build, and a raw SQL attempt returns `1142`.
(`@Immutable` is also unenforceable in tests, since it is a Hibernate annotation and a
`@DataJpaTest` slice has neither the privilege system nor the same flush semantics.)

### `save()` on a `JpaRepository`, with `updatable = false` as the safety net — rejected

The path of least resistance: Spring Data gives us `save`, and the mapping prevents harm.

**Why it lost:** `save()` on an entity with an assigned id is a `merge`, i.e. an UPDATE attempt in
disguise, and `JpaRepository` also hands us `delete`, `deleteById`, `deleteAllInBatch` and
`saveAndFlush` for free — an API surface whose names advertise exactly the operations the product
promise forbids. The insert-only fragment (§6.2) costs ~20 lines. This is the "promise vs mechanism"
difference at its most concrete: a reviewer cannot see a privilege, but they can see a method.

### Explicit mutation gateway for every artefact write (no JPA flush at all) — rejected, with respect

`@Modifying UPDATE … WHERE id = :id AND version = :v` in one repository, for everything: status,
timestamps, redaction. Then "how many code paths mutate the artefact" is literally one class.

**Why it lost here:** it duplicates what the grant already enforces, and it costs the
`OptimisticLockingFailureException` translation issue #17 requires (0 rows affected becomes an
exception we throw and translate ourselves, with our own mapping to `409`). It also makes the entity
`@Immutable`-adjacent, which drags in the silent-no-op problem above for the *mutable* columns.
Revisit if a third mutable subsystem appears; until then the column-level grant is a smaller wall in
exactly the right place.

### Audit from a JPA `Interceptor`/`FlushEventListener` — rejected as primary, kept as a dev belt

Intercepting the flush and refusing to write a dirty ledger entity catches everything, including
code nobody remembered to review.

**Why it lost as the mechanism:** it fires at flush time, which is after the business logic has
already decided, so its diagnostics are a stack trace through Hibernate; it cannot enforce the
*absence* of an update path, only its failure; it does nothing for the grant's cases (a rogue
`nativeQuery` never touches the entity model); and its behaviour differs enough across ORM versions
to be a liability in a portability-committed build (ADR-0005). We do keep the cheap version:
a `@Profile("dev")` event listener that throws early with a readable message, because failing fast
in an IDE is worth ~30 lines and no production semantics change.

### Separate audit schema (or service), written by a role with no grant on the main schema — rejected

The textbook answer, and the only one of these that also defeats adversary 3 properly.

**Why it lost for now:** two datasources means either a second transaction (and "the transition
happened but the audit row didn't" becomes a real state, which §12.2 exists to forbid) or an outbox
(auditing the ledger *through* a queue whose own delivery needs auditing). It also splits the query
path #37/#40/#46 all need. Reserved as the growth path: at the volume where the ledger's indexes
hurt the OLTP plan, this becomes right — with the anchor (§16) as the cheaper interim.

### WORM object storage as the ledger of record — rejected

S3 Object Lock (compliance mode) is genuinely non-rewritable, cheap, and durable.

**Why it lost:** the ledger's job is not archival, it is *queryable*: filter by actor + type + date
range, paged, joined to artefacts for the customer timeline. Object storage has no such query path,
and building one means a secondary index store — i.e. the mutable database again, which is the thing
under suspicion. Adopted for exactly the slice where it is unbeatable: the §16 anchor manifest and
the §11.3 archive, both of which are read rarely, must survive the database, and are useless if the
database is the only place their integrity is recorded.

### A permissioned-chain / external notary service — deferred

Third-party timestamping of a digest (an RFC 3161 authority, or the eIDAS-style trusted-list
pattern) is stronger evidence than our own signature, because the witness is not us.

**Why deferred:** an external notariser is a vendor dependency for a system whose audit trail is
*already* append-only, and the marginal value over a self-signed, publicly re-verifiable Merkle root
is mostly about *who* is accusing us. §16 keeps the door open: `prevAnchorHash` is exactly the
value an external service would countersign. Recorded as a residual risk in issue #90's register
rather than as a promise here.

## Ticket contract — how this lands in week 1, and what proves it

This ADR is decision-complete on purpose: the implementing tickets should be transcriptions, not
decisions. The acceptance criteria of issue #3 are discharged by the artifacts in the right column.

Cost, stated rather than hidden: this ADR adds **six tables** to issue #13's list (`retention_hold`,
`retention_policy`, `customer_ledger_seq`, `ledger_counters`, `data_key`, `message_catalog`) and
reshapes a seventh (`notice_version`). That is roughly 30 extra minutes on #13 and a sizeable chunk
of #14's seed. The alternative — deferring them so week 1 ships the original 13 tables — is what
turns a one-way door into a migration over rows that were written under a different premise, which
is precisely the thing this ADR exists to prevent. If #13 must be cut, cut `retention_policy` and
read the periods from config; do **not** cut `customer_ledger_seq`, `subject_ref`, the mask-at-write
columns, or `notice_version`'s immutability.

| Ticket | Must contain, from this ADR | The check that proves it |
|---|---|---|
| **#13** `V1__init.sql` | `consent_event` and `data_access_log` as §2, `notice_version` as §9, `retention_hold`/`customer_ledger_seq`/`ledger_counters`/`data_key`/`message_catalog`/`retention_policy` as named here; `artefact_sha256`-related columns; no `updated_at`, no `ON DELETE CASCADE` on history, `utf8mb4`, UTC `DATETIME(6)` | `flyway:migrate` + `validate` on an empty DB; a schema test asserting every column comment of the two ledger tables is non-empty |
| **#14** reference data | `message_catalog` seed (§13.3); **no `effective_to` on `notice_version`** (§9) | idempotent, versioned seed |
| **#17** artefact + notice entities | pin columns `notice_version_id` + `notice_body_sha256` + `render_sha256` + `render_version`; `effective_to` as a derived read-only field; `@Version` on the artefact only (§8) | `ddl-auto=validate`; the optimistic-lock test #17 already names; a test asserting no `@Version` on any ledger entity |
| **#18** ledger entities | §6.1 shape — `updatable = false` everywhere, no setters, app-assigned id (`updatable=false`, insertable); `ConsentEventType` == §4's table | metamodel test that every column is non-updatable (incl. inherited); the enum-vs-ADR test; the "anonymous event cannot be built" test |
| **#21** repositories | `InsertOnlyRepository` (§6.2), no `save`/`delete*` on ledger repos | `RepositoryInformation` assertion over the *effective* (inherited) method set |
| **#22** Testcontainers | the harness must create `ch_migrate` **and** `ch_app`, migrate as the former and run tests as the latter; `@DirtiesContext` per grant test class | the §5.4 tests are impossible otherwise; this is the ticket that makes the grant testable at all |
| **#24** grants | `V4__append_only_grants.sql` exactly as §5.2; both roles in compose; the README line #24 asks for — "the audit ledger is append-only — enforced, not promised", pointing at §5/§6 and the two tests; runbook purge path (§11.3) | the four failing statements + `GrantsGoldenTest`; "app still functions end to end under the restricted user" is the whole suite under `ch_app` |
| **#25** ArchUnit | R1–R6 (§6.3), the fixture negative control, `@Modifying` allowed only in the redaction repository | a red-rule test that asserts violation; a CI run where adding `delete(UUID)` fails the build |
| **#26** contract | `GET /api/v1/consents/{id}/events`, `/access-log`, `/notice`, `GET /api/v1/audit` (+`/export.csv`) — all read-only | see "Consistency with the contract" |
| **#31** state machine | transitions are the *only* writers of `status`; every transition appends in-transaction (§12.2) | its existing "every transition produces an audit event" test, now backed by a column-level grant |
| **#41** fetch | one `data_access_log` + one `DATA_ACCESSED` + outbox row, same transaction; `ACCESS_DENIED` in its own transaction (§13.1) | #41's existing AC, plus §7 step 3's 1:1 invariant test |
| **#43** maker-checker | reuse `ApprovalTask` for `LEDGER_PURGE` (§11.3); `REINSTATED` needs `CONSENT_REINSTATEMENT` (§14) | its existing two-layer test |
| **#44** DSAR | §10's steps 2–8, in that order; the certificate; the erasure-vs-audit assertions | its existing "leaves `consent_event` and `data_access_log` intact" test, extended to "and `subject_ref` no longer resolves" |
| **#46** audit endpoints | §13.2's rules; §13.3's response shape; `reasonTextVersion` in the payload | its existing "audit reads are themselves recorded" test + a test that `AUDIT_READ` reads do not recurse |
| **#64** notice viewer | §9's reconstruction path, including `isCurrentVersion` and the hash prefix | its existing "the old consent shows the version in force at approval" test |
| **#86** runbook | "the audit ledger is append-only — enforced, not promised", with the *commands*: `SHOW GRANTS FOR 'ch_app'@'%'`, `SELECT * FROM mysql.tables_priv WHERE Table_name IN ('consent_event','data_access_log','consent_artefact')` **and** `SELECT * FROM mysql.columns_priv WHERE Table_name = 'consent_artefact'` — column grants appear only in `columns_priv`, so an operator who checks `tables_priv` alone will conclude the artefact has no UPDATE path at all and phone the wrong team — plus how to run `LedgerIntegrityJob`, how to execute §11.3's purge, and how to reconcile a `WATERMARK_REGRESSION` | each procedure states who is authorised; each is copy-pasteable |
| **#85** threat model | the "tampered audit row" row gets a real control pointer (§5, §6, §7) and an honest residual (§16) | its AC that every threat maps to existing code or is marked a gap |
| **#90** risk register | "ledger rewritten by a privileged operator" → likelihood low, mitigation = hashes + external anchor, **residual = no anchor until §16 stage 3** | the residual column is the point |
| **#91** artefact signatures | signs the §8 canonical body (which already includes `notice_body_sha256`); §7 step 1 recomputes `artefact_sha256` over the same payload | its existing tamper test, plus "signature survives a status transition" |
| **#92** Oracle XE | `V4__grants_oracle.sql` as §5.2's Oracle phrasing, incl. the schema-ownership trap from §5.1 and the column-list syntax | `GrantsGoldenTest` must pass on both profiles — the portability test that keeps ADR-0005 honest |

Stretch items *not* required by any of the above: `GET /api/v1/consents/{id}/events/{eventId}`
(a single event's canonical payload, so an FIU can independently re-verify `artefact_sha256` —
~30 minutes and the cheapest thing that makes §7 checkable by someone who does not work here).

## Consistency with the contract

Per ADR-0001 the contract is `contract/openapi/consenthub-api.yaml`. Nothing in this ADR needs a new
contract element *today*, and nothing in the current contract contradicts it — the ledger tables have
no contract surface yet, so there is nothing to drift. What the contract must eventually say is
listed for issue #26 (and §13.3 for the shape):

| ADR clause | Contract element | Status |
|---|---|---|
| §1 "the ledger is append-only" | `GET /consents/{id}/events`, `GET /consents/{id}/access-log`, `GET /audit`, `GET /audit/export.csv` — **read-only; no `PUT`/`PATCH`/`DELETE` on any of them** | lands with #26 (#37, #40, #46) |
| §3 attribution | `ConsentEvent.sessionId`, `actorType`, `reasonCode`, `correlationId` | lands with #26 |
| §9 the pinned text | `GET /consents/{id}/notice` → `{label, effectiveFrom, effectiveTo, bodyMd, bodySha256, isCurrentVersion}` | lands with #26 (#64 consumes it) |
| §10 the retention explanation | `GET /api/v1/dsar/{id}/certificate` (what was erased, what was retained, under which basis, until when) | lands with #26 (#44 produces it) |
| §12.1 no client-supplied ids | ledger POST paths do not exist at all — there is nothing to omit | by construction |
| §13.3 wording is not stored | `reasonText` + `reasonTextVersion` on the timeline DTO | lands with #26 |

One contract change is *implied* by this ADR and should be taken by #26, not assumed by it: the
existing `Consent.status` enum is `granted | revoked | expired`, while issue #17 and #31's state
machine are `PENDING | ACTIVE | PAUSED | REVOKED | EXPIRED`. The ledger cannot be the evidence for a
state machine the contract does not have five states, so the contract's enum follows this ADR's
§8/§14 vocabulary. ADR-0002 hit the same class of drift and fixed it in place; here the fix belongs
to the ticket that writes the endpoints, and this line is where the disagreement is recorded.

## Legal posture

These periods and procedures are the engineering contract, written from the sources below. They are
not legal advice, and the compliance claims in the README must not exceed what §1 actually calls
"proven". The list a reviewer should check against the code:

- **DPDP Act 2023 §8(7)** — erasure when the purpose is spent or consent is withdrawn, whichever is
  earlier, *unless retention is necessary for compliance with a law in force*: the clause §10 and
  §11's 7-year clock rest on.
- **DPDP Act 2023 §12** — right to erasure, subject to the same carve-out; §10 step 7's certificate
  is the "tell them what you kept and why" answer.
- **DPDP Rules 2025, Rule 6 + Rule 8(3)** — reasonable safeguards incl. access control, logging and
  monitoring; retention of traffic/processing logs for **at least one year**, which §3's "full IP is
  in the logs, the ledger keeps a /24" and §11's 400-day log row implement; and the 48-hour
  pre-erasure notice, adopted voluntarily for every erasure (§10 step 2).
- **DPDP Rules 2025, First Schedule Part B** — a consent manager keeps records of consents given,
  denied and withdrawn, the notices accompanying them, and data-sharing activity, for **at least 7
  years**, in tamper-proof form, made available in machine-readable form: §11's number, §9's pinning,
  §4's vocabulary and #46's CSV export.
- **DPDP Act 2023 §8(6) + Rules Rule 7** — breach intimation to the Board and affected principals,
  with the detailed report within 72 hours: the ledger is the evidence source for that report, which
  is why §7's drift events and #50's correlation ids exist.
- **RBI/ReBIT AA model** — the consent artefact as a signed, machine-readable object with a fixed
  purpose/scope/window, `logged, audited and verified`, a notification to the registered URL on
  every use, and a fresh artefact on revocation or change: §8's "substance by lineage", §13.1's
  access row, #41's outbox row in the same transaction.
- **PMLA maintenance-of-records rules (Rule 6)** — transaction records for ten years from the
  transaction: §11's 10-year row for artefacts linked to a sanctioned facility, and the "take the
  longest applicable period" rule.

Before any of this is claimed to a customer or a regulator: confirm the current text of the DPDP
Rules' schedules with counsel (the phased commencement means the applicable clause depends on the
date), and confirm which ConsentHub deployment is acting as data fiduciary versus consent manager —
§11's floor differs between the two.

## References

- Issue #3 — this ADR's task list; issues #13, #14, #17, #18, #21, #22, #24, #25, #26 — the week-1
  and week-2 tickets that implement it (see the ticket contract).
- Downstream consumers: #37 (timeline), #40 (transparency view), #41 (fetch + notification), #43 and
  #45 (four-eyes, including §11.3's purge gate), #44 (DSAR/erasure), #46 (audit query + CSV),
  #51 (expiry job as a `SYSTEM` actor), #64 (versioned notice viewer), #73 (ops console audit
  viewer), #85 (threat model), #86 (runbook), #90 (risk register), #91 (artefact signatures),
  #92 (the Oracle profile that must not become an exception to the grant).
- ADR-0001 — the contract is a root-level artifact; the ledger's read surface must be in it.
- ADR-0002 — §4 (reuse detection writes `SECURITY_REFRESH_TOKEN_REUSE`), §6 (step-up before an
  erasure or a purge), and the session identifier this ADR promotes to `session_id`. Amended by this
  ADR: `event_type = REFRESH_TOKEN_REUSE` → `SECURITY_REFRESH_TOKEN_REUSE`, `actor_type = USER` →
  the session's role, `user_agent` → `client_agent`, and the `metadata.sessionId` workaround is not
  built.
- ADR-0005 — the portability rules §2, §5.2 and §12.3 are written inside (no `JSON` columns, no
  `AUTO_INCREMENT`, no vendor DDL defaults, per-table charset comment).
- ADR-0006 (outbox, #47) — §12.2's boundary is the line between the two: an `OUTBOX_SENT` transition
  is not a ledger event, but the `NOTIFIED` row it produces is.
- RFC 9562 (UUIDv7), RFC 8785 (JCS canonical JSON), RFC 6962 (Merkle tree anchoring) — §12.3, §7, §16.
- OWASP Logging Cheat Sheet (log what matters, never secrets); OWASP ASVS V7 (verification of
  log integrity); NIST SP 800-92 (log management, the §11 log clock).
- Data Protection Board of India, *DPDP Rules 2025* (notified 13 November 2025) and *DPDP Act 2023*;
  RBI Master Direction – NBFC-Account Aggregators and the ReBIT AA API specification, as summarised
  in the sources cited in the Legal posture section. Regulatory text governs over this summary.
