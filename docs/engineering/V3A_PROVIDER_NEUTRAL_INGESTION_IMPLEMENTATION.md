# Money Moves V3A — Provider-Neutral Ingestion Implementation

Date: 2026-08-11
Status: CANDIDATE 1 REJECTED; NARROW REMEDIATION IMPLEMENTED / AWAITING INDEPENDENT RE-ACCEPTANCE
Domain schema: 10
Trusted parent: `5d2c44925931292724bc4a2d62cfade3c969f606` (`v3-plaid-architecture-accepted`)
Rejected candidate: `1b45e1c8b85789a3847b19afef6567a7dd4b2f3c` (`v3a-provider-neutral-ingestion-candidate`)
Remediation candidate tag: `v3a-provider-neutral-ingestion-candidate-2`

## Outcome and scope

V3A adds an offline, provider-neutral financial-ingestion boundary to the
authoritative encrypted local vault. Manual entries, generic CSV rows, and a
synthetic fixture adapter all produce the same closed mutation-batch contract.
One reconciler validates, normalizes, deduplicates by source identity, applies
source lifecycle changes, preserves user-authored meaning, and persists an
idempotency receipt.

This candidate does not contain live provider integration, credentials, token
exchange, hosted services, browser authorization, webhooks, cursors, network
requests, foreign-exchange conversion, a Reports UI, or V3B/V3C/V3D/V3R/V3E
behavior. The fixture adapter is test-only source behavior implemented without
network access. V3A is not accepted by this implementation report.

## Candidate 1 rejection and narrow remediation

Independent acceptance rejected Candidate 1 after reproducing four blockers:

1. CSV replay identity included `producedAt` and related observation times, so
   identical bytes/profile imported later collided with the original receipt.
2. Amount-change conflicts were gated by active allocations, allowing a
   classified or reviewed transaction without allocations to keep stale user
   meaning after an ordinary modification or pending-to-posted transition.
3. The allocation review workflow rewrote signed canonical `amountCents` to
   match a system classification instead of preserving the source movement.
4. Transaction source identity omitted source-account scope, so equal external
   transaction IDs in two CSV accounts collided.

Candidate 2 changes only those invariants and directly related regression
coverage. It does not reopen the accepted V3 architecture or add V3B, live
Plaid, backend/network behavior, Hosted Link, cursor/webhook code, FX, or a
Reports UI. Independent re-acceptance is still required in a separate review.

## Requirements affected

The implementation follows the PRD's provider-metadata, traceability,
supervised-automation, honest-uncertainty, and encrypted-local-authority
principles. It implements or strengthens the data/service foundations for:

- `TXN-002`: original source facts, normalized facts, source revisions, changed
  fields, and compact audit records are retained separately from user fields.
- `TXN-003`: manual and CSV records enter the canonical transaction model and
  remain visibly source-identified.
- `TXN-004`: only an explicit predecessor reference can reconcile pending to
  posted; local transaction and allocation identities are preserved.
- `SPL-001`: active allocations must still equal transaction magnitude; an
  incompatible source correction snapshots and supersedes them for resolution.
- `ACT-001`–`ACT-003`: stable local accounts are separate from source account
  references, and source changes do not replace friendly names or visibility.
- `LOC-001`–`LOC-002`: unknown location remains explicit and ordinary canonical
  fields retain only region, country, and provenance.
- `INF-001`–`INF-003` and `RMB-001`–`RMB-005`: ingestion never infers income,
  transfers, refunds, or reimbursements from provider categories; linked user
  evidence is retained and excluded from active totals while conflicted.
- PRD sections 13.3, 14, 15, and 16: adapters cannot write reporting state,
  source and user authority are separated, financial data stays encrypted at
  rest, and migration is clone-first and non-inventive.

The authoritative V3 canonical-ingestion contract, trust model, architecture
decisions, and architecture acceptance remain the controlling V3 documents.

## Schema 9 to 10 migration

`v3a-provider-neutral-ingestion` advances schema 9 to schema 10. The migration
is deterministic, clone-first, validates the schema-9 foundation before
conversion, validates the full schema-10 domain afterward, and is idempotent.

Schema 10 initializes these encrypted canonical collections:

- `ingestionReceipts` for durable batch and payload-digest idempotency;
- `sourceQuarantines` for unsupported or unsafe source evidence;
- `sourceTombstones` for removals observed before a local transaction exists;
- `interpretationConflicts` for source changes that invalidate user meaning;
- `sourceAuditEvents` for compact source-change provenance.

Existing account IDs, transaction IDs, allocation IDs, bucket classifications,
reimbursement relationships, devotional state, review state, preferences, and
other V1/V2 data remain unchanged. Existing manual and CSV records receive
deterministic provider-neutral source identities. Records without a trustworthy
external reference reuse their stable local ID; the migration does not invent a
provider connection, account mask, location, merchant, or reimbursement.

## Identity model

Local ownership and source identity are distinct:

```text
account source key     = sourceKind + sourceNamespace + sourceAccountRef
transaction source key = sourceKind + sourceNamespace + sourceAccountRef + sourceRecordRef
local account ID       = Money Moves-owned stable ID
local transaction ID   = Money Moves-owned stable ID
```

Source namespaces prevent collisions across separate imports or connections;
source-account scope permits two accounts to carry the same legitimate external
transaction reference without merging them. The same account/reference pair is
stable on reimport. Same-looking transactions and accounts remain separate when
source keys differ.
Semantic similarity—date, amount, merchant, description, or category—is never
used as an identity or automatic pending match. Pending aliases remain indexed
to the same local transaction after a valid posted replacement.

## Closed mutation-batch contract

`ingestionContract.js` defines the V1 contract version, recognized source and
adapter kinds, account and transaction mutations, observations, checkpoints,
warnings, quarantine evidence, and SHA-256 payload digest. Validation is closed
at every nested object: unknown fields, malformed dates or currencies, invalid
money evidence, duplicate terminal source references, lineage cycles,
cross-account predecessors, oversized counts/strings/payloads, and digest
mismatches fail before reconciliation.

The digest covers semantic source/content identity: contract version, stable
batch/source/adapter identity, checkpoint, ordered account and transaction
mutations, quarantine facts, and warnings. It intentionally excludes
`producedAt`, the observation envelope, and per-item `observedAt` fields. Those
timestamps remain validated and available for diagnostics and audit, but they
cannot turn identical source content into a conflicting receipt. A replayed
`batchId` with the same semantic digest returns its original receipt without a
write; changed account, amount, source reference, checkpoint, or ordering fails
closed.

Rejected Candidate 1 receipts used the former complete-envelope digest. Schema
10 retains a narrow compatibility check for those CSV receipts: only an exact
reconstruction of the Candidate 1 canonical envelope at the receipt's original
creation time is accepted as replay. Any changed semantic content still fails
as `BATCH_ID_COLLISION`.

## Exact money and currency policy

`exactMoney.js` accepts decimal strings only. It parses with string operations
and `BigInt`, validates at most two fractional digits, rejects exponential or
grouped forms, rejects values beyond JavaScript's safe-integer cents boundary,
and normalizes negative zero to zero. It does not parse source money with
`Number`, floating-point multiplication, or rounding.

The contract records both normalized signed cents and source evidence:
`decimal`, `currency`, and `signConvention`. Supported profiles map
Money-Moves-signed, positive-outflow, positive-inflow, and debit/credit inputs
to the invariant that inflows are positive and outflows are negative.

V3A active accounting is USD-only. Missing or invalid currency, non-USD
currency, malformed/over-precise/unsafe amounts, zero-value manual entries, and
ambiguous debit/credit rows become bounded quarantine evidence. EUR, GBP, and
JPY fixtures prove that no FX value or active non-USD transaction is invented.
If a later source observation makes an existing record unsupported, the record
is excluded from active reporting and its prior user interpretation is retained
for explicit resolution.

## Field ownership

Adapters may change source-owned facts such as official names, balances,
descriptions, dates, lifecycle, location provenance, and provider category
metadata. They cannot set or overwrite friendly account names, enabled/hidden
choices, movement type, review status, notes, manual overrides, bucket
allocations, claim relationships, or other user-owned meaning.

New imported transactions begin `unclassified` and `pending` review regardless
of provider category metadata. Category data is preserved only as secondary
reference metadata. Automation does not silently review a transaction.

## Reconciliation behavior

### Adds and modifications

New source keys create one local record. Exact replays are no-ops. Modifications
append the prior source facts to `sourceHistory`, update source-owned fields,
and append a compact source audit event. User-owned fields remain unchanged.

One shared predicate determines whether an amount/currency change conflicts
with meaningful user interpretation. Classification, any non-pending review
state, allocations, notes, manual overrides, and reimbursement-payment use all
count as authored interpretation. If none exists, an otherwise valid source
amount change stays clean. If it exists, both ordinary modifications and
pending-to-posted transitions snapshot prior review state, movement type,
active allocations, claim IDs, notes, and manual overrides in one unresolved
interpretation conflict. Active allocations are marked superseded and excluded
from reporting until resolution. Description/date/category-only source changes
do not create a false amount conflict.

### Pending to posted

A posted add may replace a pending record only when it names exactly one
predecessor in the same source namespace and account. The local transaction ID,
allocations, and user work remain stable. The pending source reference becomes
an auditable alias. Missing, ambiguous, cross-account, colliding, or non-pending
predecessors fail closed. An unlinked posted lookalike remains a separate record.

### Removals and revival

Known removals change source lifecycle to `removed`, retain the canonical row,
history, notes, allocations, claims, and a tombstone, and exclude it from active
spending/income totals. User-authored work produces a resolution conflict rather
than deletion. Unknown removals create source tombstone evidence. Replays are
idempotent. A later add with the exact same source key revives the same local
record and resolves only its removal conflict; no generic resurrection or fuzzy
merge exists.

## Atomicity and persistence

Reconciliation operates on a deep clone, validates the complete domain, and
advances `stateRevision` once. `StateService.applyIngestionBatch` passes only
the validated clone to the existing encrypted repository with its expected
vault generation. A validation or reconciliation error changes neither the
caller's state nor the vault. A persistence error leaves the prior encrypted
authority intact; retrying the same batch applies it once. Receipt replay does
not rewrite the vault.

## Manual and CSV adapters

The manual adapter requires explicit source references, account references,
currency, direction, and decimal amount. The generic CSV adapter derives a file
digest, stable row identity, import-profile namespace, stable source-account
reference, and explicit sign profile. It supports signed amount columns or
mutually exclusive debit/credit columns. A supplied external transaction ID is
used with account scope; otherwise the accepted file-digest/row-ordinal fallback
also participates in the account-scoped canonical source key.

The existing CSV button now submits the canonical batch through StateService.
Its legacy review-card projection remains a compatibility view, not an
independent financial source of truth. The older CSV helper no longer uses
floating-point source-money parsing or provider-category classification, and
the legacy direct-add helper no longer removes semantic lookalikes.

## Backup and future report safety

All schema-10 source identities, receipts, quarantine evidence, tombstones,
aliases, source history, conflicts, audit facts, allocations, classifications,
and devotional state live inside the authenticated encrypted vault. Encrypted
backup/restore round-trips these records and validates them before replacement.

Quarter boundaries do not roll up, truncate, or delete canonical history.
Posted corrections, tombstones, and interpretation evidence remain available
for a future local V3R implementation. V3A adds no report table, cached report,
snapshot, report calculation, or Reports UI.

## Files changed

- `js/domain/constants.js`, `js/domain/migrations.js`, `js/domain/models.js` —
  schema 10, migration, validation, relationships, active/conflicted semantics.
- `js/domain/exactMoney.js`, `js/domain/ingestionContract.js` — exact cents and
  the closed canonical mutation-batch contract.
- `js/adapters/adapterUtils.js`, `manualIngestionAdapter.js`,
  `csvIngestionAdapter.js`, `fixtureIngestionAdapter.js` — offline adapters.
- `js/services/ingestionService.js`, `js/services/stateService.js` — pure
  reconciliation and encrypted atomic persistence boundary.
- `js/services/allocationService.js`, `bucketService.js`, and
  `reimbursementService.js` — active-source/conflict filtering and resolution.
- `js/app.js`, `js/csv.js`, `js/state.js` — canonical CSV routing and removal of
  legacy floating-point/semantic-dedup behavior.
- `test/fixtures/v3a-ingestion.js`, `test/provider-neutral-ingestion.test.js`,
  and migration expectation updates — synthetic V3A coverage.
- `package.json` — syntax-check coverage for the new production modules.
- This report, `IMPLEMENTATION_STATUS.md`, and `ENGINEERING_HANDOFF.md`.

Candidate 2 specifically changes `ingestionContract.js`, `models.js`, the
schema-9→10 identity initialization in `migrations.js`, `ingestionService.js`,
`allocationService.js`, the two focused test files, and these three engineering
documents. There are no dependency or migration-file additions.

## Tests and fixtures

The 40 V3A tests use only synthetic manual, CSV, and fixture-provider values.
They cover exact cents and sign matrices; malformed, huge, zero, missing,
invalid, and foreign-currency values; closed contract limits; account and
transaction identity collisions; account ownership; source/user metadata
attacks; add/modify/replay; allocation and reimbursement conflicts; explicit
pending lineage; no fuzzy matching; tombstones and revival; atomic validation
and persistence failure/retry; empty and populated schema-9 migration;
encrypted backup/restore; quarter boundaries; semantic batch-digest collisions;
account-scoped CSV identity; Candidate 1 receipt compatibility;
classified/reviewed no-allocation amount conflicts; signed-source-cents
immutability; combined two-account replay, classification, modification,
conflict, and replay; and static absence of network/provider-product runtime
capability.

Full remediation validation records 271 unit tests and 38 Electron-focused tests,
all passing with zero failures, skips, or todos. No dependency was added.

## Schema decision

The schema remains 10. The remediation changes no persisted entity shape and
uses `sourceAccountRef`, which schema 10 already stores on every canonical
transaction, as the missing identity component. The unaccepted schema-9→10
migration is corrected in place so account-distinct equal external IDs remain
external IDs instead of being replaced by local fallback references. Existing
Candidate 1 CSV receipts receive the exact fail-closed compatibility treatment
described above. A schema 11 migration would add no necessary field and would
not improve safety.

## Security and scope review

The canonical domain, reconciler, and adapters contain no fetch call, HTTP URL,
provider-product-specific runtime terminology, credential, secret, token,
hosted endpoint, or remote persistence. Quarantine/audit records contain bounded
facts and safe codes rather than full raw payloads. Financial records and user
interpretation continue to persist only through the existing encrypted vault.

## Known limitations

- Candidate 1 was rejected; Candidate 2 awaits independent re-acceptance.
- USD is the only active accounting currency; unsupported source values are
  quarantined without conversion.
- The current product exposes canonical CSV ingestion through the existing CSV
  entry point; no new transaction-detail, quarantine, or conflict-resolution UI
  was added in this bounded phase.
- The fixture-provider adapter proves the offline seam only. It is not a live
  institution connector and holds no cursor or credential.
- V3R must define report calculations and UI in its own post-V3D phase using the
  retained canonical history.

## Recommended next task

Run an independent V3A re-acceptance review from
`v3a-provider-neutral-ingestion-candidate-2`. Re-read the
five authoritative V3 documents, audit schema-9 migration and field ownership,
repeat the 271-unit/38-Electron validation gate, add adversarial cases if any
gap is found, and issue a separate acceptance or rejection record. Do not begin
V3B from this implementation report alone.
