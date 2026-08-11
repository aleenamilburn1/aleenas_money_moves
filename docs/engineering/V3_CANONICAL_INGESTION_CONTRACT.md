# Money Moves V3 Canonical Ingestion Contract

**Status:** Architecture contract; proposed for V3A implementation
**Implementation state:** Not implemented; schema remains 9 and no migration exists in this checkpoint

## 1. Contract goals

Every source adapter—manual, CSV, Plaid, or future provider—must emit one provider-neutral mutation batch. Only the reconciliation engine may turn that batch into canonical local records. Adapters cannot write vault state, create allocations, classify movement, create reimbursement/refund links, mark review complete, or calculate reports.

```text
source bytes/API records
  -> source adapter (lossless parse + allowlisted normalization)
  -> normalized source mutation batch
  -> structural/monetary/provenance validation
  -> canonical account and transaction reconciliation
  -> domain-wide invariant validation
  -> one atomic encrypted-vault save
  -> user-domain interpretation (separate workflow)
```

The contract satisfies PRD TXN-004, ACT-001, IMP-001 through IMP-003, AGT-001, AGT-002, canonical model sections 11-12, and the invariants that source facts are auditable, provider categories are metadata, user overrides persist, and active allocations reconcile exactly.

## 2. Vocabulary and identity

- **Source kind:** `manual`, `csv`, or `provider`. `provider` is deliberately not `plaid`.
- **Adapter kind:** an implementation identifier such as `manual.v1`, `csv.generic.v1`, or a provider adapter name. It is ingestion metadata, not a domain type switch.
- **Source namespace:** stable opaque local identifier defining the collision boundary. Manual uses one vault namespace; CSV uses an import-profile/account namespace; a live provider uses the opaque Money Moves connection ID.
- **Source record reference:** opaque stable identifier within a namespace. For a provider, backend derives a Money Moves handle from the provider record ID. The raw provider ID is not required locally.
- **Source key:** `(sourceKind, sourceNamespace, sourceRecordRef)`. This is the only automatic transaction identity/deduplication key.
- **Local identity:** random stable Money Moves account or transaction ID. It does not change when source keys or source metadata evolve through an explicitly linked lifecycle transition.
- **Batch receipt:** provider-neutral record proving a particular batch digest was durably applied. It is safe for the encrypted vault and backup.
- **Interpretation:** user-owned movement type, review status, allocations, claims/refunds/transfers, notes, and rules. It is outside the source mutation payload.

Source refs, batch IDs, connection IDs, and account handles are case-sensitive opaque strings. Code must compare exact bytes after contract validation and must not parse provider semantics from them.

## 3. Contract shape

Illustrative TypeScript is normative for field meaning, not a commitment to TypeScript implementation.

```ts
type SourceKind = 'manual' | 'csv' | 'provider';
type MutationKind = 'add' | 'modify' | 'remove';

interface SourceMutationBatchV1 {
  contractVersion: 1;
  batchId: string;                 // opaque, stable for an exact payload
  sourceKind: SourceKind;
  adapterKind: string;
  sourceNamespace: string;
  producedAt: string;              // ISO instant
  observation: {
    startedAt: string;
    completedAt: string;
    environment: 'local' | 'sandbox' | 'production' | 'unknown';
    requestRef: string | null;      // safe opaque support reference
  };
  checkpoint: {
    baseRef: string | null;         // opaque; never interpreted by domain
    proposedRef: string | null;
    generation: number | null;
  } | null;
  accountMutations: AccountMutationV1[];
  transactionMutations: TransactionMutationV1[];
  quarantinedRecords: SourceQuarantineV1[];
  sourceWarnings: SourceWarningV1[];
  payloadDigest: string;            // digest of canonical batch encoding
}

interface AccountMutationV1 {
  kind: 'add' | 'modify' | 'disconnect';
  sourceAccountRef: string;
  observedAt: string;
  account: NormalizedSourceAccountV1 | null; // null only for disconnect
}

interface NormalizedSourceAccountV1 {
  officialName: string | null;
  providerDisplayName: string | null;
  institution: {
    sourceInstitutionRef: string | null;
    name: string | null;
  };
  type: 'cash' | 'depository' | 'credit' | 'loan' | 'savings' |
        'investment' | 'other' | 'unknown';
  subtype: string | null;
  mask: string | null;
  currency: string | null;
  sourceStatus: 'active' | 'disconnected' | 'closed' | 'unknown';
  balances: {
    currentCents: number | null;
    availableCents: number | null;
    limitCents: number | null;
    observedAt: string | null;
  } | null;
  metadata: Record<string, string | number | boolean | null>;
}

interface TransactionMutationV1 {
  kind: MutationKind;
  sourceRecordRef: string;
  sourceAccountRef: string;
  observedAt: string;
  record: NormalizedSourceTransactionV1 | null; // null only for remove
  removal: {
    reason: 'source_removed' | 'pending_expired' | 'account_disconnected' | 'unknown';
    predecessorOfRef: string | null;
  } | null;
}

interface NormalizedSourceTransactionV1 {
  lifecycle: 'pending' | 'posted' | 'unknown';
  predecessorSourceRef: string | null;
  amountCents: number;              // non-zero safe integer, Money Moves sign
  currency: string;                 // uppercase ISO 4217; V3 beta allowlist applies
  sourceAmount: {
    decimal: string;                // lossless source decimal text
    currency: string | null;
    signConvention: 'money_moves_signed' | 'positive_outflow' |
                    'positive_inflow' | 'debit_credit';
  };
  sourceDate: string;               // YYYY-MM-DD
  authorizedDate: string | null;    // YYYY-MM-DD
  authorizedAt: string | null;      // ISO instant only when source supplies time
  postedDate: string | null;        // YYYY-MM-DD
  postedAt: string | null;
  rawDescription: string | null;
  displayDescription: string | null;
  merchant: {
    name: string | null;
    sourceEntityRef: string | null;
    websiteHost: string | null;
  } | null;
  providerCategory: {
    primary: string | null;
    detailed: string | null;
    confidence: string | null;
    taxonomyVersion: string | null;
  } | null;
  paymentChannel: string | null;
  location: {
    region: string | null;
    country: string | null;
    source: 'provider' | 'import' | 'unavailable';
  };
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

interface SourceQuarantineV1 {
  sourceRecordRef: string;
  sourceAccountRef: string | null;
  observedAt: string;
  reason: 'unsupported_currency' | 'unsafe_amount' | 'missing_account' |
          'invalid_source_record';
  rawAmountDecimal: string | null;
  sourceCurrency: string | null;
  safeDetailCode: string;
}

interface SourceWarningV1 {
  code: string;
  count: number;
  safeMessage: string;
}
```

### 3.1 Closed and bounded data

- Unknown contract fields fail validation; provider additions cannot silently infect the vault.
- `metadata` has an adapter-specific allowlist, key count, key length, string length, nesting prohibition, and encoded-size cap. Unknown upstream fields are discarded and counted in a warning, not copied.
- Descriptions, merchant names, masks, categories, and refs have explicit length limits in V3A. Batch arrays, total encoded bytes, and per-account/per-transaction counts are bounded before allocation.
- Duplicate terminal mutations for the same account or source key in one batch are invalid. The adapter must deterministically compact all provider pages to one terminal account mutation and one terminal transaction mutation per source ref.
- A removed predecessor and a distinct added posted record may coexist. Relationship resolution occurs after all batch records are indexed, so page order is irrelevant.
- `checkpoint.baseRef` and `proposedRef` are Money Moves opaque checkpoint handles. A backend adapter never puts a raw Plaid cursor in this contract or the vault.
- A quarantine record is a minimized, non-financial-domain source receipt. It lets the vault acknowledge that an unsupported upstream record was observed without inventing a canonical amount or silently dropping it.

## 4. Canonical local account

The V3A target account shape evolves the existing canonical account; exact persistence syntax is chosen in the V3A migration.

| Field | Ownership | Rule |
|---|---|---|
| `id` | Local system | Stable random Money Moves account ID. Never derived from name/mask. |
| `sourceKind` | Source identity | `manual`, `csv`, or `provider`. |
| `sourceNamespace` | Source identity | Opaque connection/import/manual namespace. |
| `sourceAccountRef` | Source identity | Opaque stable account handle; unique with namespace. |
| `connectionId` | Operational source | Opaque Money Moves connection ID or null. Never a Plaid Item ID. |
| `friendlyName` | User | User display name; initially copied as a suggestion but thereafter never overwritten. |
| `officialName` | Source | Latest official/source name or null. |
| `institutionName` | Source | Display metadata or null. |
| `type` / `subtype` | Source | Provider-neutral enum plus raw subtype metadata if useful. Unknown remains `unknown`/null. |
| `mask` | Source | Last displayed mask when supplied; null otherwise. Never treated as globally unique. |
| `currency` | Source | Supported ISO code or null. Do not default when not guaranteed. |
| `enabled` / `hidden` | User | Controls local import/display. Source cannot change it. |
| `sourceStatus` | Source | Active/disconnected/closed/unknown. |
| `connectionStatus` | Operational/derived | Healthy, attention, disconnected, relink-required, etc.; not a provider field. |
| `balance facts` | Source | Optional timestamped metadata; does not manufacture transaction totals. |
| `sourceMetadata` | Source | Minimal allowlisted audit facts. |
| timestamps | Mixed | Source observation and local create/update are distinct. |

The backend exposes opaque account handles. Raw Plaid account IDs do not enter the renderer or vault. Backend stores the provider mapping encrypted or keyed for webhook/API reconciliation.

An account source key uniquely maps to one local account. A new source namespace never automatically maps to an old local account even if institution, name, type, or mask match. A new account ref inside an existing namespace is also not auto-merged by mutable metadata; without an explicit provider-neutral predecessor relationship it becomes a new/disconnected candidate. Duplicate candidates may be suggested, but only explicit user confirmation creates an audited mapping or cutover.

## 5. Canonical source transaction

The transaction record must keep source facts separate from interpretation.

| Field | Requirement |
|---|---|
| `id` | Stable local random ID. Explicit pending→posted transition may retain it. |
| `accountId` | Valid local account ID or explicit Unknown account. |
| `sourceKind`, `sourceNamespace`, `sourceRecordRef` | Required stable source identity. Previous source refs may remain as aliases after lifecycle replacement. |
| `sourceLifecycle` | Pending, posted, removed/tombstoned, or unknown. Removed is not hard delete. |
| `amountCents` | Non-zero safe integer, positive inflow/negative outflow. Source-authoritative. |
| `currency` | Supported uppercase ISO code. Never invented from locale or account. |
| source/authorized/posted/display dates | Source fields remain distinct. Display date is derived by policy: posted date when known, otherwise source/authorized date. |
| raw/display description | Raw is minimized source evidence; display is source-authoritative normalized evidence until a separate user display override exists. |
| merchant/category/channel/location | Optional source metadata. Category never drives bucket/classification. Only region/country are retained for ordinary location use. |
| `sourceRevision`, `sourceUpdatedAt`, observations | Sync provenance used for audit and deterministic modification. |
| `predecessorTransactionId` and ref aliases | Explicit pending/posted lineage; no fuzzy matching. |
| tombstone fields | Removal observation, reason, prior source facts digest/snapshot, and possible successor link. |
| local timestamps | Created/updated/tombstoned timestamps separate from source dates. |
| interpretation reference/state | User-owned movement, review, allocation set, notes, links, and conflict state live separately or in explicitly owned fields. |

The vault retains a minimized source snapshot sufficient to explain the current facts and the previous source value when changed: source decimal/sign evidence, dates, descriptions, lifecycle, account handle, region/country, category metadata, revision/observation, and adapter kind. It does not retain the full Plaid response, street address, coordinates, routing/account numbers, URLs with query strings, or unknown upstream objects.

## 6. Amount and currency normalization

### 6.1 Canonical rule

All domain arithmetic uses `Number.isSafeInteger(amountCents)` and never floating point. Positive means money entering an owned account; negative means money leaving. Zero source transactions are quarantined unless a future non-transaction tombstone contract explicitly permits them.

Adapters accept a lossless decimal string plus declared source sign convention. Parsing algorithm:

1. Trim only contract-approved whitespace; reject thousands separators unless the CSV profile explicitly defines them.
2. Parse sign, whole digits, and fractional digits as strings.
3. Currency must be in the approved two-minor-unit allowlist. Pad one fractional digit; reject more than two rather than round.
4. Convert with `BigInt(whole) * 100n + BigInt(fraction)` and apply sign mapping.
5. Reject zero, values outside JavaScript safe-integer range, scientific notation, `NaN`, infinity, parentheses unless profile-declared, and ambiguous currency.
6. Only after range validation convert to JavaScript number.

V3's canonical field is cents, so currencies with zero, three, or variable minor units and unofficial currencies are not safely representable. The adapter emits a bounded `SourceQuarantineV1`; the batch atomically persists that quarantine alongside valid records and may then be acknowledged, so one unsupported record does not permanently stall the cursor. The quarantine is excluded from cash flow, spending, and income and is visible as an import/connection issue. If malformed input reaches a supposedly valid transaction mutation instead of an explicit quarantine, the entire batch fails and the cursor does not advance. A future exponent-aware model requires a separate product/schema decision; it may not silently reinterpret cents.

### 6.2 Exact source mappings

| Adapter | Source convention | Money Moves mapping |
|---|---|---|
| Manual | UI requires explicit `inflow` or `outflow` and unsigned decimal magnitude | inflow `+parsedCents`; outflow `-parsedCents` |
| CSV signed cash-flow profile | Positive is inflow, negative is outflow | `parsedSignedCents` |
| CSV bank/debit profile | Positive is outflow, negative is inflow | `-parsedSignedCents` |
| CSV debit/credit columns | Exactly one non-zero column | debit `-abs(cents)`; credit `+abs(cents)` |
| Provider adapter for Plaid Transactions | Official Plaid Transactions amount: positive out of account, negative into account | `-plaidAmountInCents` |

CSV sign profile is explicit in preview and saved import mapping. Provider category must not infer sign. Existing legacy records produced by old float/round behavior are preserved as migration history; V3A does not rewrite their amounts silently.

## 7. Field ownership matrix

| Field or relationship | Owner | Source-update behavior |
|---|---|---|
| Source key/account handle | Source/system | Immutable except explicit predecessor/alias transition. |
| Source amount/currency | Source | Update with audit; conflict if active user interpretation no longer reconciles. |
| Source lifecycle/pending/removed | Source | Update/tombstone; never hard-delete user work. |
| Source dates/descriptions/merchant/location/category/channel | Source | Update with prior fact in audit. Manual location/display overrides remain separate. |
| Provider category/confidence/taxonomy | Source metadata | Never maps or overwrites bucket, movement, review, or rule. |
| Account official name/type/mask/status | Source | Update source facts only. |
| Account friendly name/enabled/hidden/manual mapping | User | Never overwritten. |
| Movement/classification | User | Initial state is unclassified/suggested; adapter cannot finalize it. |
| Buckets and allocation cents/ownership/notes | User | Never overwritten or automatically rescaled. |
| Reimbursement claims/payments/write-offs | User/domain | Adapter cannot create/change. Source inflow may become a candidate only. |
| Refund and transfer links | User/domain | Suggestions only; never automatic authority. |
| Review/defer status and user transaction notes | User | Never overwritten. A source conflict may add `needs_resolution` without erasing prior status history. |
| Display date/month grouping, totals, balance state | Derived | Recompute from current active source facts and valid active interpretation. |
| Connection health/sync receipt | Operational | Does not change financial meaning. |

If date or description changes after review, update source facts, preserve interpretation, write audit provenance, and recompute derived period/search data. A material date move is surfaced in activity history. If account identity changes, require a valid deterministic source-account mapping; otherwise quarantine.

If amount or currency changes after finalized allocations:

- if the active allocation set still equals the new magnitude and currency matches, preserve it and record the source update;
- otherwise atomically update the source facts, snapshot the entire prior interpretation/allocation set as a user-authored conflict artifact, remove that set from active reporting status without deleting it, mark the transaction `needs_resolution`, and require explicit user confirmation/edit;
- never manufacture a residual allocation, proportionally scale cents, change ownership, or silently mark reviewed;
- cash-flow views may use the current source movement with a coverage warning; allocation-derived spending excludes the unresolved amount until the user creates a new exact active allocation set.

The exact V3A schema may use versioned allocation sets or an interpretation-conflict entity. In either representation, only an **active finalized** allocation set is an `Allocation` for the equality invariant; superseded snapshots are immutable audit evidence, not active allocations.

## 8. Batch validation and atomic reconciliation

### 8.1 Preflight

Before cloning or mutating vault state:

1. Enforce byte/count/string/depth limits.
2. Verify contract version, canonical encoding, payload digest, source namespace, adapter allowlist, and timestamps.
3. Verify one terminal mutation per source key and account key.
4. Verify all non-disconnect transactions reference a batch account mutation or an existing local source-account mapping.
5. Validate dates, currencies, cents, lossless source-amount evidence, quarantines, enums, metadata allowlist, and predecessor refs.
6. Reject a predecessor relation across source namespace/account, a cycle, a self-reference, or multiple posted successors for one pending source record in the same batch.
7. Check `batchId` against the local receipt table. Matching digest is replay; same ID/different digest is a security error.

### 8.2 Deterministic apply order

Apply against an in-memory clone:

1. Account adds/modifications.
2. Transaction adds/modifications indexed by source key.
3. Explicit pending→posted replacements using predecessor refs.
4. Remaining removals/tombstones.
5. Account disconnects/source-status changes.
6. Quarantine/source-issue records.
7. Audit events, conflicts, aliases, and one batch receipt.
8. Domain-wide relationship, amount, allocation, claim, and uniqueness validation.
9. Exactly one repository save using expected vault generation.

Any error restores/discards the clone; no partial account, transaction, tombstone, receipt, or audit mutation survives. A vault-generation conflict repeats preflight/reconciliation against freshly unlocked/reloaded authority; it never blindly reapplies a stale draft.

## 9. Mutation rules

### 9.1 Added

- Unknown source key: create a new local transaction with unclassified/pending-review interpretation; provider metadata remains reference only.
- Existing key with byte-equivalent current source snapshot: idempotent no-op plus observation/receipt handling.
- Existing tombstoned key: revive the same local ID only when source namespace/account match. Re-evaluate interpretation conflict if amount/currency differ.
- Existing active key with different facts delivered as `add`: treat as adapter/protocol error, not an implicit modify.

### 9.2 Modified

- Source key must resolve to an existing current or tombstoned transaction; otherwise quarantine or request rebaseline, never silently add.
- Update only source-authoritative fields and append a compact before/after audit fact set.
- Preserve local ID, user interpretation, stable allocations, claims, refund/transfer links, and notes when they remain valid.
- Amount/currency/account changes run the conflict rules above. Description/category/date changes do not reopen review automatically unless a configured materiality policy produces a visible, non-destructive review suggestion.
- Exact replay of the same source revision/snapshot is a no-op.

### 9.3 Removed/tombstoned

- Never hard-delete a canonical transaction through ingestion.
- Set source lifecycle to removed, record removal observation/reason, retain last useful minimized source snapshot, and exclude it from active cash-flow and allocation-derived totals.
- Keep local transaction ID, review/audit history, user notes, claims/links, and prior allocation interpretation visible as historical evidence.
- If no user interaction exists and the record was an unmatched pending authorization, hide it from default views after tombstoning but keep it available in source history.
- If reviewed, allocated, linked, or noted, mark it visibly removed/needs-resolution. Do not destroy user work.
- Replay of removal is idempotent. A later source add with the same key may revive it under the added rule.

## 10. Pending to posted

Current Plaid behavior delivers the pending ID in `removed`, the posted transaction with a different ID in `added`, and, when matched, the pending ID in the posted record's `pending_transaction_id`. Those arrays may be on different pages within one overall update. Some pending records disappear, and some posted records have no match.

Provider-neutral rule for an **explicit match**:

1. Added record is posted and its `predecessorSourceRef` resolves to exactly one current pending transaction in the same namespace and account.
2. The adapter batch contains or is compatible with the predecessor removal.
3. Reconciler keeps the pending transaction's local Money Moves ID.
4. Old pending source ref becomes an immutable alias/tombstone linked to the new posted source ref; the current source key becomes the posted ref.
5. Source-authoritative fields become the posted facts and prior pending facts remain in audit history.
6. User interpretation, notes, review history, and allocation IDs remain when still valid.
7. If amount/currency breaks the active allocation invariant, preserve the old interpretation as conflict evidence and require review; do not alter user cents.

An existing transaction for the posted source key plus the predecessor local transaction is a collision requiring deterministic repair; never merge based on amount/name/date.

For an **unmatched posted record**, create a new local transaction. For an **unmatched pending removal**, tombstone the pending record under removal rules. No fuzzy match is promoted automatically. A later user-approved reconciliation may join candidates through an audited domain command, not the ingestion adapter.

## 11. Idempotency and duplicate rules

| Scenario | Stable key/response |
|---|---|
| Repeated provider batch | `batchId + payloadDigest`; receipt returns applied result. |
| Provider/desktop/backend retry | Same prepared payload and source keys; reconcile/ack are idempotent. |
| Duplicate webhook | Signature/body digest only raises sync-needed generation once; next sync remains cursor-authoritative. |
| Out-of-order webhook | Health/sync-needed fields use monotonic observations and provider recheck; webhook order never applies transactions. |
| Same provider transaction again | Exact source key maps to the same local ID. |
| Modified replay | Same source key + source revision/snapshot digest is no-op. |
| Removed replay | Existing tombstone update is no-op except safe observation metadata. |
| Pending→posted replay | Posted ref and predecessor alias resolve to one retained local ID. |
| Same bank linked twice | Different connection namespaces; no automatic account/transaction merge. |
| CSV with reliable external ID | `(csv, importProfile/account namespace, externalId)` when mapping explicitly declares uniqueness. |
| CSV without external ID | Exact file digest + row ordinal is the source ref; reimport of identical bytes is idempotent. |
| Reordered/edited CSV | New import identity unless explicit stable IDs exist; surface duplicate candidates only. |
| Identical repeated purchases | Remain distinct because semantic facts are never an identity key. |
| Manual entry | Generated manual source ref; a user-confirmed duplicate command is required to delete/merge. |

Amount, merchant, date, description, institution name, account name, and mask are candidate signals only. They never establish identity or authorize merging.

## 12. CSV evolution

V3A replaces direct `rowsToTransactions -> addTransactions` commits with:

1. byte-limited CSV parse with encoding/newline/quote errors;
2. user-visible column and sign/currency mapping preview;
3. lossless decimal parse and rejected-row report;
4. explicit mapping of source accounts to local accounts or Unknown/new accounts;
5. immutable import batch/source profile metadata;
6. provider-neutral mutation batch preview;
7. duplicate candidates and exact-reimport recognition;
8. one atomic canonical apply.

Provider-looking CSV columns (`transaction_id`, Plaid category names, etc.) do not make CSV a Plaid source and do not authorize provider semantics. Raw import facts are minimized and retained for audit.

## 13. Reconciliation result

The engine returns only safe local information:

```ts
interface IngestionApplyResultV1 {
  batchId: string;
  payloadDigest: string;
  status: 'applied' | 'already_applied' | 'quarantined' | 'conflict';
  counts: {
    accountsAdded: number;
    accountsUpdated: number;
    accountsDisconnected: number;
    transactionsAdded: number;
    transactionsUpdated: number;
    transactionsTombstoned: number;
    pendingPostedTransitions: number;
    interpretationConflicts: number;
    sourceRecordsQuarantined: number;
  };
  safeErrorCodes: string[];
  receipt: { connectionId: string | null; batchId: string; payloadDigest: string } | null;
}
```

No raw payload, description, provider ID, token, vault generation, passphrase, or stack trace crosses an error/UI boundary by default.

## 14. V3A conformance and adversarial fixtures

V3A is not accepted until offline tests cover:

- manual, multiple CSV sign profiles, and a fake non-Plaid provider through the same contract;
- positive/negative/max-safe/overflow/zero/one-decimal/two-decimal/three-decimal/scientific/invalid amounts;
- supported, unknown, unofficial, zero-decimal, and three-decimal currencies, including atomic quarantine plus cursor acknowledgement;
- exact reimport, reliable external IDs, identical repeated purchases, edited/reordered files, and colliding batch IDs;
- account add/modify/disconnect, Unknown account, renamed provider account, duplicate link namespace, and explicit user mapping;
- added/modified/removed replay and wrong-kind mutations;
- pending→posted same/different amount, different name/date, arrays/pages reordered, no predecessor, missing predecessor, duplicate successor, and posted-key collision;
- removal before/after user review, allocation, reimbursement/refund/transfer link, and tombstone revival;
- source amount conflict with one allocation, split allocations, reimbursable allocation, and no allocation;
- provider category changes that do not alter user meaning;
- oversized batch/string/metadata, unknown fields, malicious refs, cycles, invalid Unicode/control data, and malformed timestamps;
- failure before validation, during reconcile, during domain validation, on disk full, on repository conflict, and after save before acknowledgement;
- receipt replay after app restart and older-backup restore checkpoint mismatch;
- proof that adapter/domain tests contain no Plaid credential or network dependency.

All accepted V2 tests must remain green. V3A adds a schema migration only in its own implementation checkpoint; this architecture checkpoint adds none.
