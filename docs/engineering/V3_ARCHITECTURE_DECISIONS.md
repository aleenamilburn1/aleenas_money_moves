# Money Moves V3 Architecture Decisions

**Status:** Candidate decision register
**Decision date:** 2026-08-11
**Implementation effect:** None in this checkpoint

This register separates product-fixed constraints, architecture recommendations, Plaid-imposed behavior, founder-approved policy, and operational values that later phases may tune. The four founder decisions raised by Candidate 1 are approved and no longer block architecture acceptance.

## A. Fixed by accepted product architecture

### FIX-01 - Local vault authority

**Decision:** The encrypted local vault remains the durable authority for canonical financial history, user allocations/classifications, reimbursements/refunds/transfers, review state, notes, devotionals, and audit history. Plaid is an ingestion source, not a replacement ledger. Backend is not live vault sync or cloud backup.

**Source:** Product brief; PRD principles and canonical model; accepted desktop handoff.

**Consequence:** Backend may temporarily hold encrypted delivery batches but cannot offer reports, edit allocations, merge vaults, or decide “latest” user state.

### FIX-02 - Remote secret isolation

**Decision:** Plaid client secret and access tokens never enter Electron renderer, preload responses, encrypted local vault, or backups. Backend server credentials never enter the desktop. Access tokens live only encrypted in backend-controlled storage and decrypt only in a least-privilege Plaid worker.

**Consequence:** A trusted remote backend is required before Link. The PRD's former local-service/OS-Keychain Plaid-token design is not the V3 design.

### FIX-03 - Provider-neutral canonical model

**Decision:** Manual, CSV, Plaid, and future sources implement adapters into one mutation contract. Provider/Plaid categories are metadata and never control buckets, protected classifications, reimbursements, refunds, transfer links, or review completion.

**Consequence:** V3A contains no Plaid credentials, network, SDK, or provider-specific domain service.

### FIX-04 - Field ownership

**Decision:** Source facts may change; user meaning is separate and cannot be silently overwritten. Suggestions require approval. Unknown values remain unknown.

**Consequence:** Source amount conflicts create explicit interpretation-conflict state and preserve prior user work rather than mutating allocation cents.

### FIX-05 - Money and allocation invariants

**Decision:** Canonical signed integer cents use positive inflow and negative outflow. Active finalized allocations equal transaction magnitude. Reimbursements are not earned income; transfers are neither spending nor income.

**Consequence:** No floating-point domain calculations, silent currency rounding, residual allocations, or provider-category income inference.

### FIX-06 - Atomicity and recoverability

**Decision:** Financial mutations apply atomically through the accepted encrypted-vault repository and remain rollback-safe. Manual backup/restore remains explicit and encrypted; no automatic merge.

**Consequence:** Provider cursor acknowledgement occurs only after a validated atomic vault save.

### FIX-07 - Disconnect preserves local history

**Decision:** Disconnect Bank removes remote provider access but does not silently erase local transactions, allocations, claims, notes, or audit. Local deletion is a different, future confirmed operation.

### FIX-08 - Phased delivery

**Decision:** V3 Architecture -> V3A ingestion -> V3B backend/identity -> V3C Sandbox Link -> V3D sync -> V3E hardening. The phases are not collapsed.

### FIX-09 - USD-only first beta with explicit currency evidence

**Decision:** Only USD financial mutations enter active accounting in the first Plaid-enabled private beta. Non-USD/unknown currency remains explicit source evidence in deterministic quarantine and is never converted, rounded, or treated as USD.

**Consequence:** V3A preserves a future-compatible currency boundary. Full multi-currency behavior remains a separate product/schema decision.

### FIX-10 - Quarterly reporting retains local canonical history

**Decision:** Calendar quarters are a core local financial-review rhythm. Quarter close never deletes or replaces detailed encrypted-vault history. A future local Quarterly Financial Report remains derived from and traceable to canonical history.

**Consequence:** Backend cleanup is a privacy/security lifecycle, not a reporting operation. Temporary backend payload deletion cannot affect local transactions or report inputs.

## B. Plaid-imposed current behavior

These are external facts verified in current official Plaid documentation, not Money Moves product preferences. They must be re-verified at implementation time.

### PLAID-01 - Link tokens and token exchange

`/link/token/create` is a backend call. Link produces an ephemeral public token; `/item/public_token/exchange` produces an access token and Item ID. Current access tokens do not expire by time and are invalidated through Item removal or rotation/invalidation mechanisms.

### PLAID-02 - Hosted Link backend completion

Hosted Link returns session results/public tokens through `SESSION_FINISHED` and `/link/token/get`, supports update mode, and can redirect to a completion URI. Money Moves can therefore keep the public token out of Electron.

### PLAID-03 - OAuth and update mode

OAuth support is required for relevant institutions. `ITEM_LOGIN_REQUIRED`, `PENDING_DISCONNECT`, and `PENDING_EXPIRATION` call for Link update mode. Normal update mode uses the existing access token to create a Link token; successful update does not exchange a new access token.

### PLAID-04 - Item removal

`/item/remove` invalidates the access token and associated tokens and is required to stop billing for Transactions unless permission was already revoked. Certain OAuth institution permission dashboards may still show the connection.

### PLAID-05 - Transactions Sync patches

`/transactions/sync` returns added, modified, and removed updates with cursor pagination. All pages must be fetched. Mutation during pagination requires restarting the loop from the original first-page cursor. A final cursor must not be committed from a partial sequence.

### PLAID-06 - Pending to posted

Plaid normally represents a matched transition as removal of the pending ID plus addition of a new posted ID whose `pending_transaction_id` references the pending record. The changes can be on different pages in one overall update. Details and amount may differ; a match is not guaranteed; pending records may simply disappear.

### PLAID-07 - Transaction signs and currency

Plaid Transactions amounts are positive when money leaves an account and negative when money enters (outside the Income product). ISO currency may be null when an unofficial currency is supplied.

### PLAID-08 - Webhooks are notifications

`SYNC_UPDATES_AVAILABLE` signals that sync data is available; it is not the ledger. Webhooks can be duplicated, out of order, retried, or missed. Plaid signs webhooks with an ES256 JWT containing issued time and exact-body SHA-256.

### PLAID-09 - Sandbox differs from production

Sandbox can bypass Link, reset login, create dynamic pending/posted updates, and fire webhooks. Automated build-blocking tests should bypass the changing Link UI. Sandbox does not reproduce every institution behavior and accepts configurations production will not.

## C. Architecture recommendations

### ADR-V3-001 - Hosted Link in the system browser

**Decision:** Use Hosted Link opened by Electron main in the system browser. Backend receives/verifies session completion and public token, performs duplicate check and exchange, and returns only opaque status to Electron.

**Why:** It gives the renderer neither Plaid script/network permissions nor Link/public/access tokens, aligns with current Hosted Link support, and lets the normal browser manage OAuth.

**Rejected:** Web Link in renderer; Electron webview/BrowserView; a custom Money Moves Web-Link wrapper without a proven need.

**Completion authority:** Browser redirect/focus is a hint only. Backend exchange/storage state is authoritative.

### ADR-V3-002 - Main-owned device identity and backend client

**Decision:** Electron main owns a pseudonymous installation credential in macOS Keychain, exchanges it for short-lived backend access, validates backend responses/Hosted Link URL, and exposes fixed opaque methods to renderer.

**Why:** Renderer is already trusted with unlocked local data but should not become the remote-secret boundary. Main can protect Keychain and route capability behind narrow IPC without seeing vault plaintext.

### ADR-V3-003 - Device-scoped pseudonymous identity for first beta

**Decision:** One random backend user, one random device, a 256-bit Keychain refresh credential, and a separately saved revoke-only recovery code. No email/password or Sign in with Apple in first beta. Loss of credential means new identity and re-link; there is no hidden account or Plaid-token recovery. Session duration, credential rotation/inactivity, and inactive-connection retirement thresholds are tunable operational controls, not a fixed 90-day reconnection lease.

**Compared alternatives:**

| Alternative | Benefit | Cost/risk | Result |
|---|---|---|---|
| Device pseudonym | Minimum PII/security/operations; clean vault separation | No cross-device identity recovery; user must retain revoke code or contact controlled beta support | Recommended for first beta. |
| Passwordless email | Familiar recovery/new-device access; remote device revocation | Stores PII; mail vendor/delivery/abuse/account-takeover/session recovery surface | Adopt only when recovery demand justifies it. |
| Sign in with Apple | Strong consumer identity, relay email/privacy features | Apple OAuth/service configuration, account-link/recovery complexity, external dependency | Premature for private beta. |

### ADR-V3-004 - Opaque local provider handles

**Decision:** Backend exposes Money Moves connection, account, and source-record handles. Raw Plaid Item/account/transaction IDs do not enter the local vault. Deterministic keyed mapping permits provider reconciliation.

**Why:** Reduces coupling and the value of copied local metadata while preserving exact source identity.

### ADR-V3-005 - Temporary prepared sync batch

**Decision:** Backend durably stores one encrypted, short-retention prepared transaction batch per connection/base cursor until local acknowledgement.

**Why:** Cursor-only storage cannot guarantee byte-identical replay after backend restart/provider mutation. Reliability outweighs absolute zero server-side transaction persistence.

**Limits:** Not queryable for product use; no reporting; encrypted; delete after durable local application, acknowledgement, and a short bounded recovery window. V3B/V3D select and test the exact window; it is unrelated to quarterly reporting or the 90-day operational-record target.

### ADR-V3-006 - Cursor acknowledgement barrier

**Decision:** Fetch all pages from committed cursor, prepare deterministic batch, apply/validate/save vault, then acknowledge with batch digest. Backend advances cursor through CAS only after acknowledgement.

**Why:** Prevents remote cursor from outrunning local authority and makes lost responses/retries safe.

### ADR-V3-007 - Explicit pending identity continuity

**Decision:** An explicit provider predecessor link preserves the pending transaction's local Money Moves ID through posting. Old/new provider refs become aliases/lineage. Fuzzy signals never establish the transition automatically.

**Why:** Preserves user work and prevents duplicate spending while respecting provider uncertainty.

### ADR-V3-008 - Interpretation conflict, not silent repair

**Decision:** If a source amount/currency update makes active allocations invalid, preserve the exact prior interpretation as immutable conflict evidence, update source facts, remove the old set from active reporting status, and require user resolution.

**Why:** Both source authority and allocation invariants stay truthful. Rescaling or residual allocations would invent user intent.

### ADR-V3-009 - Tombstones for removals

**Decision:** Provider removal produces a local tombstone and excludes the record from active totals. It never ingestion-hard-deletes user history.

**Why:** Auditability, backup consistency, links, and reviewed work survive provider churn.

### ADR-V3-010 - Same-Mac restore reconciliation; different-Mac relink

**Decision:** Same-Mac Keychain identity may reconcile a restored checkpoint through a full provider rescan; incremental sync pauses on mismatch. A different Mac has historical local data but must enroll/re-link.

**Why:** Avoids circular recovery and secret-bearing backups. Provider coverage gaps remain explicit rather than fabricated.

### ADR-V3-011 - USD-only active-accounting boundary

**Decision:** The first-beta active allowlist is exactly USD. Every adapter preserves explicit original currency/decimal/sign evidence. Non-USD, unknown, unofficial, unsafe, or unsupported-minor-unit mutations enter deterministic quarantine rather than active accounting; no conversion, default, or rounding.

**Why:** Existing canonical `amountCents` cannot truthfully represent every currency or foreign-exchange meaning. Explicit evidence and adapter isolation keep later multi-currency work possible without redesigning source identity or reconciliation.

### ADR-V3-012 - Dedicated local Quarterly Reports slice

**Decision:** V3A preserves report-sufficient canonical history; V3D completes the live history feed; a separate post-V3D **V3R** slice implements calendar-quarter reports. V3R may run alongside bounded V3E work but has separate product/calculation/schema-if-needed/UI/test acceptance.

**Why:** Reports require retained local history and careful calculation definitions but are not Plaid connectivity or backend retention. A separate slice prevents V3E from becoming an uncontrolled feature phase.

## D. Founder decisions - approved

The founder completed these decisions on 2026-08-11. They are locked architecture inputs for implementation prompts, not unresolved questions.

### FDR-V3-001 - First private-beta geography/currency

**Status:** **APPROVED - USD ONLY.** Only USD enters active first-beta accounting. Non-USD mutations retain explicit source-currency/amount evidence in quarantine and do not affect totals. V3A must not hard-code assumptions into source identity or reconciliation that prevent a later accepted multi-currency model.

**Backlog:** `MULTI-CURRENCY SUPPORT` covers original currency, minor units, FX provenance, card-network/bank adjustments, home/reporting currency, and cross-currency travel reporting. It is not part of V3A-D.

### FDR-V3-002 - Device-loss and remote-revocation promise

**Status:** **APPROVED - PSEUDONYMOUS DEVICE/BACKEND IDENTITY.** Backend user/device IDs are opaque; the strong durable device credential lives in macOS Keychain and never reaches renderer/vault/backup. Main derives short-lived sessions. Credentials are rotatable/revocable; a revoke-only code cannot authenticate or read data.

**Device loss/new Mac:** Restored local history remains usable, but inability to prove the old identity requires a new pseudonymous identity and re-link. Plaid tokens are never restored or silently recovered. There is no arbitrary 90-day bank-reconnection rule; exact session, rotation/inactivity, and retirement thresholds are V3B/V3E tuning.

### FDR-V3-003 - Duplicate connection override

**Status:** **APPROVED - WARNING/BLOCK BY DEFAULT WITH EXPLICIT OVERRIDE.** Likely duplicates warn and stop automatic continuation. The user may intentionally override when appropriate. Every override retains an independently auditable connection namespace; reconciliation is explicit and deterministic.

**Prohibited identity signals:** Institution name, account name, mask, merchant/transaction similarity, and heuristic resemblance never merge Items, accounts, or histories by themselves.

### FDR-V3-004 - Minimal backend retention

**Status:** **APPROVED - THREE RETENTION CLASSES.** Temporary financial sync payloads are deleted after durable local apply, acknowledgement, and a short recovery window. Bounded operational records start with a 90-day retention target. Active connection state remains only while operationally required and is not purged because a quarter or 90 days elapsed.

**Permanent removal:** Disable use, destroy token ciphertext/key association, remove mappings/cursor when no longer required, purge temporary payloads, and retain only a bounded minimal removal/security receipt before deletion/anonymization. Local encrypted financial history is separate and remains until a future explicit local-delete workflow.

## E. Locked policy versus operational tuning

### Locked architectural policy

- Active first-beta accounting is USD only; unsupported currency evidence remains explicit.
- Pseudonymous user/device identity and Keychain credential custody are mandatory; renderer/vault never receive the durable credential.
- Duplicate connections warn/block by default and require intentional override into a separate namespace.
- Temporary financial payloads are not durable backend history or reporting data.
- Active connections are not killed because 90 days or a calendar quarter elapsed.
- Operational data is bounded; its initial retention target is 90 days.
- Quarter close preserves detailed canonical local history; backend cleanup and reporting are independent.

### V3B/V3D/V3E operational tuning

- Exact short-lived backend API-session duration.
- Exact temporary sync-payload recovery/retry window.
- Exact device-credential rotation and inactivity thresholds.
- Exact inactive/orphan connection retirement process, notice, and security threshold without creating a quarterly reconnection policy.
- Whether bounded operational-record retention remains 90 days after private-beta evidence and privacy/legal review.

## F. Decisions intentionally deferred

- Email/Apple/multi-device account recovery beyond first beta.
- Phone app, shared vaults, cloud vault sync, or cloud allocation authority.
- Optional encrypted cloud backup and its identity/recovery model.
- Investment Transactions or unrelated Plaid products.
- Automatic transfer/refund/reimbursement classification.
- Full local financial-history deletion workflow.
- Full `MULTI-CURRENCY SUPPORT`: original currency/minor units, FX provenance and adjustments, home/reporting currency, and cross-currency reporting.
- V3R Quarterly Reports calculations, local snapshot/cache schema if needed, Reports UI, and comparison views.
- OS deep-link return from Hosted Link; polling plus browser completion page is sufficient for beta.
- Backend/vendor/infrastructure/package selection; V3B chooses implementations under this trust contract.

## G. Readiness verdict

**READY FOR ARCHITECTURE ACCEPTANCE.** All four Candidate 1 founder decisions are approved and incorporated. No unresolved founder decision blocks V3A or independent architecture acceptance. Remaining duration values are bounded operational tuning under locked policy, not open product architecture.
