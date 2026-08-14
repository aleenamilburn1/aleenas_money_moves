# Money Moves V3A — Provider-Neutral Ingestion Acceptance

## 1. Verdict

**V3A CANDIDATE 7 — ACCEPTED**

Candidate 7 is the first independently accepted V3A implementation. The review
found no material financial-data-integrity blocker. This checkpoint accepts the
offline provider-neutral ingestion, identity, reconciliation, migration, and
persistence layer only. It does not begin V3B or add Plaid, network, backend,
credential, cursor, webhook, FX, Reports UI, or Windows behavior.

## 2. Executive summary

The review independently inspected Candidate 7 and its direct Candidate-6 diff,
read the authoritative PRD and V1 audit, reproduced the Candidate-6 trimming
collision, attacked compound indexes and semantic replay, exercised schema-9
migration and encrypted restore, and ran all required validation suites.

Candidate 7 fixes Candidate 6. Exact opaque identity payloads, including leading
and trailing ASCII spaces, non-breaking spaces, Unicode-space variants, case,
composed/decomposed Unicode, punctuation, namespace-looking prefixes, and JSON-
sensitive characters, remain distinct. Non-empty whitespace-only identities are
valid. Empty, non-string, ASCII-control-bearing, or over-limit identities fail
closed without authoritative mutation.

The affected compound keys now use ordered JSON arrays of already validated
scalar strings. Adversarial delimiter and JSON syntax did not create a collision.
Reads, writes, validation, migration counting, lineage, quarantine proof, and
legacy-effect proof use the same component order for their respective keys.
Historical rejection defects 1–9 remain fixed.

## 3. Repository identity

- Reviewed implementation commit:
  `a643675831bab3b640a127f3d6549cfcd502c31e`.
- Candidate tag: annotated `v3a-provider-neutral-ingestion-candidate-7`,
  dereferencing to the reviewed commit.
- Direct parent: `640ef416d3a1a90295fc5f71cf610b1122b7aabd`,
  Candidate 6 and tag `v3a-provider-neutral-ingestion-candidate-6`.
- Accepted architecture baseline:
  `5d2c44925931292724bc4a2d62cfade3c969f606`, tag
  `v3-plaid-architecture-accepted`.
- `v3a-provider-neutral-ingestion-accepted` did not exist before this review.
- Initial branch/HEAD: `main` at Candidate 7, 14 commits ahead of `origin/main`.
- Initial unrelated dirty files: `.DS_Store`, `docs/.DS_Store`, and
  `node_modules/.pnpm-workspace-state-v1.json`.
- Those three files were not modified, staged, restored, deleted, or committed
  by acceptance.

Candidate 6→7 changes 10 files: three engineering-status documents, six V3A
implementation files, and the focused V3A test file. The code change is limited
to exact identity preservation, tuple-key hardening, validation/migration
propagation, and related tests.

## 4. Candidate-6 blocker reproduction

An independent scratch harness imported exact external raw account IDs `foo`,
` foo`, `foo `, NBSP+`foo`, one ASCII space, two ASCII spaces, and EM SPACE+`foo`.
All are valid under Candidate 7.

- Accounts added: 7.
- Transactions added: 7.
- Canonical account references: 7 distinct.
- Every transaction used the same raw transaction ID.
- Local transaction account IDs: 7 distinct and each matched the account with
  the exact canonical source reference.
- Later replay with different observation/production timestamps returned
  `already_applied`, changed no state, and created no duplicates.

A separate one-account batch used transaction IDs `txn`, ` txn`, `txn `, one
space, two spaces, NBSP+`txn`, composed `é`, and decomposed `é`. It produced one
account and eight distinct canonical transactions.

## 5. Identity-domain analysis

The implemented account identity domains are `external`, `mapping`,
`migrated_local`, `direct`, and structural `unknown`
(`js/domain/ingestionContract.js:6-31`). Payload-bearing domains use the exact
input string with only a fixed structural domain prefix; no trim, Unicode
normalization, whitespace collapse, case fold, substring, or truncation occurs
(`js/domain/ingestionContract.js:56-98`). `unknown` accepts no payload and is
represented only as `unknown-account`.

Independent encoding covered 25 distinct payloads across all four payload-
bearing domains (100 domain/payload pairs). Every pair was distinct and
deterministic. Prefix-looking payloads such as `external:foo`, `mapping:foo`,
`direct:foo`, and `account:foo` stayed payload data and did not select a domain.

CSV external identity uses a dedicated opaque field reader
(`js/adapters/csvIngestionAdapter.js:53-58,127-135`). Mapping selector labels use
NFKC, trim, whitespace collapse, and case folding, while saved mapping identity
values pass unchanged into the mapping-domain encoder
(`js/adapters/csvIngestionAdapter.js:90-123`). A full-width/case/space-variant
lookup selected a mapping whose exact identity payload was `external:foo `; the
stored reference was exactly `mapping:external:foo `.

Source namespace is included in persisted account and transaction identity.
Equal mapping values in distinct CSV profile namespaces remain separate. The
namespace comes from the explicit source namespace/profile ID, not account
display metadata.

## 6. Compound-key analysis

The old collision class was delimiter concatenation: component boundaries could
be confused when an accepted component contained the delimiter. Candidate 7
uses `JSON.stringify([component1, ...])` for:

- mutation/lineage validation (`js/domain/ingestionContract.js:447-489`);
- reconciliation account and transaction indexes
  (`js/services/ingestionService.js:41-82`);
- migration account/transaction occurrence counting
  (`js/domain/migrations.js:450-508`);
- persisted domain relationship validation (`js/domain/models.js:797-826`);
- legacy quarantine/effect evidence (`js/services/ingestionService.js:893-940`).

Independent reproductions used tuples containing `|`, colons, commas, quotes,
brackets, braces, backslashes, embedded JSON fragments, and namespace-looking
substrings. Three adversarial accounts and three adversarial transactions
remained distinct and passed full domain validation, including a pair whose old
`|` concatenation would have been ambiguous.

All valid tuple inputs cross closed-batch or model validation as scalar strings
before authoritative application. Independent mutations using `undefined`,
`null`, number, array, and object components were rejected with
`IngestionContractError`; none mutated the input state. Consequently
`undefined`, `null`, empty, and their string spellings cannot silently become
the same valid tuple.

## 7. Length and control-character analysis

The implemented account rule limits the **encoded canonical reference** to 256
JavaScript characters, including its domain prefix
(`js/domain/ingestionContract.js:13-22,56-87`). Therefore the maximum raw
payload varies by prefix: 247 characters for `external:`, 248 for `mapping:` and
`account:`, and 249 for `direct:`. Exact-boundary values passed in every domain;
one additional character produced a typed error. No truncation exists.

Standalone transaction/source-record references are limited to 256 characters.
An exact 256-character manual record ID applied; 257 characters failed closed.
Boundary whitespace contributes to length.

ASCII C0 controls plus DEL (`U+0000`–`U+001F`, `U+007F`) are rejected. Newline,
carriage return, tab, NUL, and DEL cases failed deterministically and without
mutation. Unicode spaces, including NBSP and EM SPACE, are not controls and
remain valid exact data. A schema-9 control-bearing external account ID failed
migration with `INVALID_SOURCE_ACCOUNT_REFERENCE`; it was not rewritten.

## 8. Migration and legacy analysis

A representative schema-9 CSV account used exact external identity
` schema|9 `; its transaction used ` tx|9 ` and retained a reviewed expense,
manual merchant override, user note, and exact allocation. Schema 9→10 produced
`external: schema|9 ` and `external: tx|9 `. Identical current CSV reimport in
`csv:legacy` added zero accounts and zero transactions, retained local IDs and
source cents, and preserved the allocation, classification, review state, note,
and override.

Migration uses structural source fields and stable external IDs, not labels,
institution, mask, type, merchant, or description
(`js/domain/migrations.js:395-550`). Prefix-looking and delimiter-containing IDs
use the same current-ingestion encoder.

Unreleased Candidate-4/5 schema-10 CSV state lacking identity-domain provenance
continues to fail closed with
`CSV_LEGACY_ACCOUNT_IDENTITY_DOMAIN_UNRESOLVED`; valid schema-9 and Candidate-7
states are not rejected.

Candidate-1 receipt compatibility remains strict. Committed and independently
reviewed cases require a valid outer/nested receipt, historical digest match,
namespace/account/domain/exact-reference correspondence, persisted current or
historical transaction effects, quarantine evidence, and exact audit/effect
counts (`js/services/ingestionService.js:815-970`). Missing, partial,
contradictory, effect-less, wrong-account, wrong-domain, changed-payload, and
boundary-whitespace-different states fail closed.

## 9. Historical rejection matrix

| Defect | Result | Independent evidence |
|---|---|---|
| 1. Later-time identical replay | PASS | Observation timestamps are excluded from semantic digest; later exact replay returned `already_applied` with no state change (`js/domain/ingestionContract.js:141-157`). |
| 2. Interpreted pending→posted amount change | PASS | Focused cases preserve allocations/user meaning and create `needs_resolution` conflict rather than rescaling or clearing. |
| 3. User action mutating source amount | PASS | Allocation, classification, reimbursement, and review suites confirm canonical signed `amountCents` is unchanged. |
| 4. Transaction identity not account-scoped | PASS | Seven boundary-distinct accounts accepted the same transaction ID as seven transactions with exact assignments. |
| 5. Unsafe Candidate-1 receipt compatibility | PASS | Structure/effect-proof matrix rejects malformed, partial, wrong, changed, and effect-less receipts. |
| 6. Display-label-derived account identity | PASS | CSV without external ID or explicit saved mapping returns `CSV_ACCOUNT_IDENTITY_AMBIGUOUS`; no label/institution/mask fallback exists. |
| 7. Schema-9/current external-ID mismatch | PASS | Exact whitespace/delimiter migration plus identical reimport added 0 accounts and 0 transactions and retained local IDs. |
| 8. External/mapping domain collision | PASS | Structural prefixes and explicit domain fields kept external ` mapping:foo` and mapping `external:foo ` separate; backup/reimport preserved them. |
| 9. Within-domain trimming collision | PASS | `foo`, boundary-space variants, NBSP variants, whitespace-only values, Unicode variants, case, and punctuation remained exact and distinct. |

## 10. Reconciliation and authority findings

- Money normalization remains exact integer minor units. Positive cents are
  inflow and negative cents are outflow; no floating-point normalization was
  introduced.
- Pending→posted retention requires explicit predecessor lineage. Merchant,
  date, amount, description, or other fuzzy metadata cannot reconcile records.
- Source fact updates preserve user classification, allocations, review state,
  notes, overrides, and reimbursement relationships. A meaningful amount change
  after user interpretation creates an explicit unresolved conflict.
- User allocation/review/classification operations do not rewrite source amount,
  sign, direction, account identity, or transaction identity.
- Removal creates retained tombstone/history evidence; active reporting excludes
  removed records. Revival is same-key deterministic. Boundary-distinct account
  identities did not cross-tombstone or cross-reactivate.
- Non-USD records preserve source decimal/currency evidence in quarantine,
  remain outside active USD transactions/totals, and are never converted.
- Detailed transactions, allocations, classifications, tombstones, conflicts,
  provenance, and historical modifications survive quarter boundaries. V3A
  adds no destructive close and no Reports implementation.

## 11. Atomicity and backup/restore

A mixed CSV input containing a valid external identity and a tab-bearing invalid
identity failed during batch construction with a typed error. The in-memory
state and exact encrypted backup bytes remained unchanged. Corrected retry added
two accounts and two transactions through the atomic state-service persistence
path.

Independent encrypted backup/restore preserved exact account and transaction
references, identity domain, namespace, local IDs, mapping values, transaction
assignment, allocation, classification, review, notes, overrides, and replay
behavior. Identical post-restore reimport added zero accounts and zero
transactions. Plaintext identity and note probes were absent from the encrypted
backup. No provider credential, token, or secret field is accepted at the
canonical metadata boundary.

## 12. Validation results

| Command | Result |
|---|---|
| `CI=true pnpm run check` | PASS — all listed JavaScript files parsed successfully. |
| `CI=true pnpm test` | PASS — 372 tests, 372 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled. |
| `CI=true node --test test/provider-neutral-ingestion.test.js` | PASS — 141 tests, 141 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled. |
| `CI=true pnpm run electron:test` | PASS — 38 tests, 38 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled. |
| `git diff --check` | PASS — no whitespace errors. |
| `node /private/tmp/v3a_candidate7_acceptance.mjs` | PASS — independent identity, tuple, migration, atomicity, and encrypted restore matrix. |

The 41-page authoritative PRD rendered successfully and was checked alongside
text extraction. The relevant requirements are PRD §§4.3, 8, 10.2–10.9, 10.16,
10.18, 11–17, and Appendix D: supervised/user-owned meaning, raw-source
auditability, account-scoped canonical transactions, exact allocations, explicit
unknowns, encrypted persistence, CSV import, versioned migration, reconciliation,
and future-Plaid separation.

## 13. Scope and security review

Candidate 6→7 contains no new Plaid integration, token/secret/credential,
backend or network call, Hosted Link, webhook, sync cursor, FX conversion,
Reports UI/schema/cache, Windows implementation, or V3B behavior. Canonical
metadata continues to reject credential-like and raw-payload fields. Financial
authority remains in the encrypted local vault.

## 14. Findings

**No material V3A acceptance blockers found.**

No acceptance finding required an architecture, implementation, migration, or
edge-case remediation. The only retained limitation is intentional and
fail-closed: ambiguous unreleased Candidate-4/5 schema-10 CSV identity state
cannot be reconstructed without provenance and requires controlled remediation.
This does not affect schema-9 migration or current Candidate-7 state.

## Acceptance checkpoint changes

- Files changed by acceptance: this acceptance report,
  `ENGINEERING_HANDOFF.md`, and `IMPLEMENTATION_STATUS.md`.
- Requirements accepted: provider-neutral exact-money ingestion, injective
  account/transaction identity, replay-safe reconciliation, user/source
  authority separation, schema-9 continuity, atomic encrypted persistence,
  backup/restore, USD quarantine, and history retention.
- Migrations added: none; schema remains 10.
- Tests added: none; acceptance used committed tests and an external temporary
  adversarial harness.
- Known limitations: ambiguous unreleased Candidate-4/5 schema-10 state remains
  intentionally fail-closed; no dedicated mapping UI or conflict-resolution UI
  is introduced by V3A.
- Recommended next task: preserve this checkpoint and require a separate,
  explicitly authorized gate before any later V3 phase. This acceptance does not
  begin or specify V3B implementation.
