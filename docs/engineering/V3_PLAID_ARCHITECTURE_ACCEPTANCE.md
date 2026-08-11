# Money Moves V3 Plaid Architecture Acceptance

## Verdict

**ACCEPTED.** Candidate 2 is a coherent, secure, implementation-ready
architecture for provider-neutral ingestion, a minimal trusted backend,
pseudonymous device identity, Plaid Hosted Link and Item lifecycle, transaction
synchronization and reconciliation, cursor safety, webhook security,
backup/restore, bounded backend retention, and the V3A/V3B/V3C/V3D/V3R/V3E
implementation seams.

This acceptance changes architecture status only. It does not implement V3,
change product behavior or schema, add a migration or dependency, create a Plaid
Item, call Plaid, or handle credentials.

## Candidate and checkpoint integrity

- Candidate 2 commit:
  `24b8724d6ba4bae5e97c19c239799d6075c3464a`
  (`Incorporate V3 founder architecture decisions`).
- Candidate 2 tag: annotated `v3-plaid-architecture-candidate-2`, dereferencing
  to the exact Candidate 2 commit.
- Candidate 1 remains at
  `4ba0e65da73917d6a8b2b6d3fd20eb36a7dc641b` with the unchanged annotated tag
  `v3-plaid-architecture-candidate`.
- Candidate 2 directly descends from Candidate 1.
- The accepted V2D checkpoint remains at
  `12eed0a706c62598ed4f420a1ed12ea34bc38e8a` with the annotated tag
  `v2d-macos-release-accepted`; Candidate 2 descends from it.
- No `v3-plaid-architecture-accepted` tag existed before this review.

The Candidate 1-to-Candidate 2 diff changes only six Markdown files:
`ENGINEERING_HANDOFF.md`, `IMPLEMENTATION_STATUS.md`,
`V3_ARCHITECTURE_DECISIONS.md`, `V3_CANONICAL_INGESTION_CONTRACT.md`,
`V3_PLAID_ARCHITECTURE.md`, and `V3_SECURITY_TRUST_MODEL.md`. It contains no
product source, schema, migration, dependency, test, asset, build-output,
credential, or product-behavior change. Unrelated `.DS_Store` and pnpm
workspace-state worktree changes were left untouched and excluded.

## Requirements and accepted-product accuracy

The review covered the PRD principles and release boundaries in sections 4.3,
8, 10.2-10.9, 10.16, 10.18, and 11-17, including TXN-004, ACT-001 through
ACT-003, IMP-001 through IMP-003, AGT-001, AGT-002, SEC-001, SEC-002, and
SEC-004. It also applied the repository invariants for canonical ingestion,
source auditability, user-owned interpretation, exact allocations,
reimbursements, transfers, unknown data, supervised automation, and encrypted
financial storage.

Independent source inspection confirmed the architecture describes the
accepted application accurately:

- domain schema is 9;
- the renderer owns unlocked canonical state and the in-memory vault key;
- Electron main owns native dialogs and encrypted files, not vault plaintext;
- the encrypted version-2 vault uses AES-256-GCM and PBKDF2-SHA-256 at 600,000
  iterations;
- `active.mmvault`, `previous.mmvault`, and `pending.mmvault` use generation
  comparison, read-back verification, fsync, and atomic promotion;
- manual encrypted backup/restore is explicit, verified, and non-merging;
- canonical accounts, transactions, allocations, protected system
  classifications, reimbursement-service foundations, and explicit unknown
  account/location behavior exist;
- allocations use positive integer cents and must equal transaction magnitude;
- Income, Money Transfer, and Debt Payment semantics are reserved and are not
  inferred from user bucket names or provider categories;
- current narrow preload/main IPC and renderer-origin validation are suitable
  foundations for purpose-specific connection methods; and
- the current CSV compatibility path still uses JavaScript floating-point
  conversion and semantic fingerprints, which the architecture correctly
  identifies as V3A debt rather than a safe Plaid ingestion path.

The architecture evolves those seams without silently rewriting accepted V2
semantics or depending on a capability that the current system lacks.

## Current official Plaid behavior validation

Plaid-imposed behavior was independently checked on 2026-08-11 against current
official Plaid documentation only:

- [Hosted Link](https://plaid.com/docs/link/hosted-link/) and the
  [Link API](https://plaid.com/docs/api/link/) confirm backend Link-token
  creation, `hosted_link_url`, `SESSION_FINISHED`, `/link/token/get`, backend
  public-token delivery, completion redirects, and update-mode support.
- [OAuth guidance](https://plaid.com/docs/link/oauth/) confirms OAuth support is
  required for relevant institutions and production redirect URIs are
  registered HTTPS endpoints.
- [Update mode](https://plaid.com/docs/link/update-mode/) confirms
  `ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT`, and `PENDING_EXPIRATION` repair
  through update mode, with the existing access token unchanged after normal
  success.
- [Duplicate Item guidance](https://plaid.com/docs/link/duplicate-items/)
  confirms Hosted Link metadata is available through `/link/token/get` before
  public-token exchange and duplicate Items should be detected before exchange.
- The [Items API](https://plaid.com/docs/api/items/) confirms public-token
  exchange, access-token/Item custody, `/item/remove`, billing implications,
  and the OAuth-permission-manager caveat after removal. Plaid's official
  [access-token guidance](https://support.plaid.com/hc/en-us/articles/14977184144023-Do-access-tokens-expire)
  confirms access tokens do not expire solely with time.
- The [Transactions API](https://plaid.com/docs/api/products/transactions/),
  [Transactions integration guide](https://plaid.com/docs/transactions/), and
  [sync migration guide](https://plaid.com/docs/transactions/sync-migration/)
  confirm added/modified/removed patches, cursor pagination, all-page
  application, `SYNC_UPDATES_AVAILABLE`, and full-loop restart from the original
  cursor after `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`.
- [Transaction states](https://plaid.com/docs/transactions/transactions-data/)
  confirms that a matched pending-to-posted transition is normally a pending
  removal plus a new posted addition whose `pending_transaction_id` references
  the predecessor; pages and facts may differ, matching is not guaranteed, and
  a pending authorization may disappear.
- Plaid Transactions amounts are positive when money leaves an account and
  negative when money enters for products other than Income; ISO currency is
  null when an unofficial currency is present. Candidate 2 reverses that sign
  into Money Moves positive-inflow/negative-outflow cents and quarantines
  unsupported currency instead of guessing.
- [Webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/)
  and [webhook operations](https://plaid.com/docs/api/webhooks/) confirm ES256
  JWT/JWK verification, a five-minute issued-time check, exact-body SHA-256,
  retries, duplicate/out-of-order tolerance, a ten-second delivery deadline,
  and the need for polling recovery after missed webhooks.
- [Sandbox guidance](https://plaid.com/docs/sandbox/) confirms Link bypass,
  login reset, dynamic pending/posted transaction testing, and on-demand
  webhook firing, while not reproducing every production institution behavior.

The external facts are accurately separated from Money Moves decisions. Hosted
Link in the system browser is supported and materially appropriate for the
locked renderer and token-isolation constraints; another supported Link form
does not offer a blocking safety or simplicity advantage under those same
constraints.

## Acceptance results

| Gate | Result | Independent finding |
|---|---|---|
| Hosted Link architecture | PASS | The complete initial, exit/cancel, OAuth, exchange, polling, update, error, disconnect, and reconnect lifecycles are defined. Redirect/focus is a hint; authenticated backend state is authoritative. |
| Trust and token isolation | PASS | Renderer and vault never receive Plaid/backend secrets or durable device credentials. Access tokens are backend-only, envelope-encrypted, least-privilege decrypted, and removed/revoked through a defined lifecycle. |
| Pseudonymous identity | PASS | Opaque user/device IDs, Keychain custody, short-lived sessions, rotation, revocation, reinstall/loss/restore/new-Mac behavior, and the disclosed no-hidden-recovery limitation are coherent. There is no arbitrary 90-day reconnection rule. |
| Backend minimization | PASS | Durable backend data is limited to pseudonymous identity, auth metadata, opaque mappings, encrypted token/cursor state, health, idempotency/security metadata, and bounded delivery state. It is not a cloud financial ledger. |
| Temporary payload retention | PASS | Exact prepared batches are encrypted, unavailable to reporting/support, retained only through local durable apply/ack plus a short bounded recovery window, and never held for quarterly reporting. |
| 90-day operational retention | PASS | Ninety days is an enforceable initial target for bounded operational/audit/idempotency data and can be tuned from evidence; it is not a connection lifetime. |
| Active connection lifecycle | PASS | Required token/mapping/cursor/health state remains while operationally necessary and has explicit retirement/removal behavior independent of quarters and 90 days. |
| USD-only and quarantine | PASS | Only explicit USD enters active beta accounting. Non-USD, unknown, unofficial, unsafe, or unsupported-minor-unit data retains source currency/decimal evidence in quarantine and never affects totals. |
| Multi-currency future safety | PASS | The backlog covers original currency/minor units, FX provenance and adjustments, home/reporting currency, travel, and cross-currency reports. Source identity, reconciliation, and adapter boundaries need no fundamental redesign. |
| Provider-neutral ingestion | PASS | Manual, CSV, Plaid, and future adapters converge through one closed mutation batch, validation, reconciliation, domain validation, and atomic vault save. V3A is offline and Plaid-free. |
| Canonical account model | PASS | Local identity, source namespace/connection, opaque source account reference, user display fields, provider facts, type/subtype/mask/currency/status, unknowns, and source metadata are separated. Duplicate namespaces never silently merge. |
| Canonical transaction model | PASS | Stable local identity, account/source identity, lifecycle, signed cents, currency, dates, description/metadata, provenance, predecessor aliases, tombstones, and conflict/review state are represented. |
| Field ownership | PASS | Source facts may update with audit. Buckets, allocations, classifications, notes, reimbursement/refund/transfer interpretation, and review history remain user-authoritative and are never silently overwritten. Derived values are reproducible. |
| Amount normalization | PASS | Lossless decimal-string parsing, `BigInt` cent conversion, safe-range checks, explicit Plaid sign reversal, no rounding/FX guessing, quarantine, and the legacy CSV floating-point remediation boundary are defined. |
| Pending to posted | PASS | Only explicit predecessor lineage retains local identity. User work survives; amount/currency conflicts snapshot prior interpretation, deactivate invalid allocations from reporting, and require review without rescaling. |
| Modified/removed/tombstone | PASS | Source-owned modifications apply atomically with user fields intact. Removals tombstone rather than hard-delete, exit active totals, and retain authored/audit history. |
| Idempotency and duplication | PASS | Batch/digest receipts, stable source keys, aliases, CAS, and tombstone replay cover sync, desktop/backend retry, webhook replay, CSV reimport, pending/posting, modification, removal, and duplicate Item override. Semantic facts alone never deduplicate. |
| Cursor and acknowledgement | PASS | The protocol starts from the committed cursor, fetches every page, restarts correctly on pagination mutation, persists one deterministic encrypted batch, applies locally atomically, acknowledges only after durable save, and advances by CAS. Every specified crash/retry/lost-response/restore case is defined. |
| Webhook security | PASS | Exact raw-body capture, ES256/JWK/signature/age/body-hash/environment/Item checks, strict limits, duplicate/replay tolerance, minimal queue work, and polling recovery are required. Webhooks trigger sync; they are not transaction authority. |
| Disconnect and reconnect | PASS | `/item/remove` and token retirement are distinct from encrypted local history. Reconnect uses a new namespace unless an explicit audited cutover is approved; update mode handles recoverable Item authentication. |
| Backup and restore | PASS | Backups contain no Plaid/backend secrets. Same-Mac identity may reconcile after checkpoint verification/full rescan; different-Mac restore keeps usable history and requires re-link without invented cloud token recovery. |
| Quarterly reports and V3R | PASS | Calendar-quarter reporting remains local and derived from detailed encrypted canonical history. Quarter close never purges details or active connection state. V3R is a clean post-V3D implementation and acceptance slice. |
| Privacy and logging | PASS | Tokens, credentials, account/routing numbers, full financial payloads, avoidable amounts/descriptions, vault secrets, allocations/notes, and devotional content are prohibited. Logs use opaque IDs, coarse types/status, timing/retries, and bounded codes. |
| Threat model | PASS | Renderer/IPC, stolen vault/Keychain, DB/backend compromise, token leak, spoof/replay, cursor desync, duplicate links, hostile payloads, disk full, crash, and stale restore each have mitigation and residual-risk treatment. |
| V3A/B/C/D/R/E boundaries | PASS | V3A is offline; V3B is minimal backend/identity; V3C is Sandbox Link/Item lifecycle; V3D is sync/reconciliation; V3R is reports; V3E is bounded private-beta hardening. Dependencies and independent gates are explicit. |
| Founder decisions | PASS | USD-only, multi-currency backlog, pseudonymous identity, duplicate warning/block plus explicit override, three retention classes, no 90-day connection expiry, local quarterly history, and V3R placement are locked. Remaining duration/retirement values are bounded operational tuning. |
| Internal consistency | PASS | Cross-document checks found no material contradiction in token location, renderer trust, vault authority, retention, cursor ownership, identity, amount signs, currency quarantine, lineage, ownership, tombstones, restore, duplicates, quarters, or phase boundaries. |

## Baseline validation

Fresh validation at Candidate 2 passed:

- `CI=true pnpm run check`: passed.
- `CI=true pnpm test`: **229/229** passed, 0 failed, 0 skipped.
- `CI=true pnpm run electron:test`: **38/38** passed, 0 failed, 0 skipped.
- `git diff --check`: passed.
- Candidate diff integrity and current acceptance-document diff integrity: passed.

No test was added or modified. No migration was added or required.

## Residual risks and implementation obligations

- A compromised trusted backend/Plaid worker can access active Plaid tokens and
  provider data; least privilege, KMS audit, incident response, and independent
  V3B/V3E review remain mandatory.
- A compromised unlocked renderer can read local financial data and request
  allowed IPC operations, although it cannot directly retrieve Plaid or backend
  secrets under this architecture.
- Loss of both the Keychain credential and revoke-only code can orphan an active
  remote connection until the explicit monitored retirement/security process
  acts. This limitation must be disclosed in the private beta.
- Plaid/provider retention gaps can make a same-Mac full restore reconciliation
  incomplete. The UI must preserve local history and display coverage gaps
  rather than manufacture completeness.
- Intentional duplicate-Item override can still create billing or OAuth
  side-effects; the separate namespace, explicit confirmation, and visible
  reconciliation requirements remain mandatory.
- Exact session, credential rotation/inactivity, prepared-batch recovery, and
  inactive-connection retirement durations remain bounded operational choices
  for the named phases, not unresolved architecture decisions.
- Plaid behavior is temporally unstable and must be re-verified from official
  documentation at V3C/V3D implementation and private-beta readiness.

## Acceptance checkpoint

The annotated tag `v3-plaid-architecture-accepted` identifies the
documentation-only acceptance commit containing this record. Its parent is
Candidate 2 `24b8724d6ba4bae5e97c19c239799d6075c3464a`. Candidate 1, Candidate 2,
and the accepted V2D tags remain unmoved.

## Recommended next task

Open a bounded V3A provider-neutral ingestion implementation task. It should
read the PRD and this acceptance first, preserve/migrate schema-9 data, add the
explicit V3A migration and offline adversarial fixtures, use no Plaid/network
dependency or credential, and receive independent acceptance before V3B.
