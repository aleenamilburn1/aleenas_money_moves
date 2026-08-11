# Money Moves V3 Architecture Decisions

**Status:** Candidate decision register
**Decision date:** 2026-08-11
**Implementation effect:** None in this checkpoint

This register separates product-fixed constraints, architecture recommendations, Plaid-imposed behavior, and choices that genuinely require founder approval. Recommendations are complete enough for architecture acceptance; open founder policies use an explicit default and block only the named implementation phase.

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

**Decision:** One random backend user, one random device, a 256-bit Keychain refresh credential, a separately saved revoke-only recovery code, and a disclosed 90-day authenticated-device connection lease. No email/password or Sign in with Apple in first beta. Loss of credential means new identity and re-link; no hidden account recovery. If the recovery code is also lost, lease expiry triggers remote Item removal.

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

**Limits:** Not queryable for product use; no reporting; encrypted; immediate purge after acknowledgement safety window; recommended 24-hour delivery TTL.

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

### ADR-V3-011 - USD/two-minor-unit normalization boundary

**Decision:** The contract supports an explicit two-minor-unit ISO currency allowlist. Unsupported/unofficial/other-exponent currency blocks atomic import and is surfaced; no rounding.

**Why:** Existing canonical `amountCents` cannot truthfully represent every currency. An exponent-aware redesign is future work.

## D. Founder decisions requiring approval

These decisions do not block architecture acceptance because the recommended default is complete. They block the named implementation/release gate if not approved.

### FDR-V3-001 - First private-beta geography/currency

**Business question:** Should the first live-bank beta support only US institutions and USD accounts, or attempt multiple countries/currencies?

**Recommendation:** US institutions and USD only for the first private beta. V3A keeps a two-minor-unit allowlist so expansion is deliberate.

**Impact:**

- US/USD: smallest Link configuration, sign/currency/test matrix, consent/support surface; non-USD records are clearly unsupported, not rounded.
- Multi-country/two-decimal currencies: more institution/OAuth/consent/localization behavior and support burden.
- All ISO/unofficial currencies: requires an exponent-aware money model and new product/schema decision before ingestion.

**Blocks:** V3C configuration and V3E live scope. Does not block provider-neutral V3A if its allowlist is injectable.

### FDR-V3-002 - Device-loss and remote-revocation promise

**Business question:** Is “save a revoke-only recovery code; otherwise re-link after device loss” acceptable for friends/private beta, or is recoverable email identity required at launch?

**Recommendation:** Approve pseudonymous device identity for first beta with mandatory recovery-code acknowledgement, conspicuous disconnect guidance, and automatic remote removal after 90 days without authenticated device activity. Add passwordless email only after measured beta need.

**Impact:**

- Device-only: maximum privacy/minimum operations; lost Keychain credential cannot recover the old identity or connections. Revoke code removes them immediately; the 90-day lease bounds the remote orphan if that code is also lost, at the cost of disconnecting very inactive beta users.
- Passwordless email: smoother new-Mac recovery and remote device management, but adds PII, email vendor, anti-abuse, session/account recovery, and account-takeover risk.
- Sign in with Apple: polished Mac identity but larger implementation/operations commitment.

**Blocks:** V3B identity implementation. Does not block V3A.

### FDR-V3-003 - Duplicate connection override

**Business question:** When backend detects a likely duplicate Item before public-token exchange, may the user deliberately continue and create a separate connection?

**Recommendation:** First beta blocks likely duplicates and directs users to update/reconnect the existing connection. Support explicit separate connections only after a demonstrated joint-login/use case.

**Impact:**

- Block: avoids billing/confusion and OAuth invalidation risk; may reject legitimate different credentials/accounts at one institution until supported.
- Allow with confirmation: more flexible but requires separate namespaces, account-level preview, institution-specific failure handling, and stronger duplicate UX.

**Blocks:** V3C duplicate-flow acceptance. Does not block V3A/B.

### FDR-V3-004 - Local retention after provider consent revocation

**Business question:** What privacy/legal retention policy applies to previously imported local records after a user revokes provider consent or disconnects?

**Recommendation:** Preserve locally because it is required to provide the user's requested local finance product and because deletion would destroy allocations/history, while immediately ending remote access and providing a separately confirmed local-delete path later. Obtain privacy/legal review before live limited production.

**Impact:**

- Preserve: meets current product invariant and user continuity; requires clear disclosure and legal basis/documentation.
- Delete automatically: conflicts with accepted product behavior and would silently destroy user work; not recommended.
- Prompt at disconnect: can be future UX, but local deletion requires relationship previews and a separate design.

**Blocks:** V3E live-readiness/privacy gate, not Sandbox V3C or engineering V3D.

## E. Decisions intentionally deferred

- Email/Apple/multi-device account recovery beyond first beta.
- Phone app, shared vaults, cloud vault sync, or cloud allocation authority.
- Optional encrypted cloud backup and its identity/recovery model.
- Investment Transactions or unrelated Plaid products.
- Automatic transfer/refund/reimbursement classification.
- Full local financial-history deletion workflow.
- Exponent-aware multi-currency model beyond integer cents.
- OS deep-link return from Hosted Link; polling plus browser completion page is sufficient for beta.
- Backend/vendor/infrastructure/package selection; V3B chooses implementations under this trust contract.

## F. Readiness verdict

**READY FOR ARCHITECTURE ACCEPTANCE.** The fixed constraints and recommended defaults form one internally consistent architecture. Founder approvals are bounded product/operational policies with named phase gates; none requires changing the V3A provider-neutral contract or the core trust model.
