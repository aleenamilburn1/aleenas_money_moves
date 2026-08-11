# Money Moves Engineering Handoff

## Current repository state

- Repository: `/Users/aleenamilburn/Downloads/aleenas_money_moves`
- Branch: `main`
- Hosted correction preservation checkpoint: `c591368` (`Harden hosted storage correction candidate`)
- Desktop foundation candidate reviewed: `v2-desktop-foundation-candidate` (`99c04ee`, `Implement desktop-first Electron foundation`)
- Original V2D candidate rejected at acceptance phase 2: `v2d-macos-release-candidate` (`0072b61`)
- V2D Candidate 2 rejected at acceptance phase 2: `v2d-macos-release-candidate-2` (`32347a1`, `Harden macOS release verification`)
- V2D Candidate 3 (`f912517`, `Restrict macOS JIT signing policy`) is independently accepted by `V2D_MACOS_SIGNING_NOTARIZATION_ACCEPTANCE.md`; annotated tag `v2d-macos-release-accepted` identifies the documentation-only acceptance checkpoint
- Current domain schema: 10
- Desktop package version: `2.0.0-desktop.0`
- Founder direction: macOS-first Electron desktop app with one authoritative encrypted local vault per owner.
- V3 Plaid/provider-neutral ingestion Architecture Candidate 1 is preserved at `4ba0e65da73917d6a8b2b6d3fd20eb36a7dc641b` and annotated tag `v3-plaid-architecture-candidate`.
- V3 Architecture Candidate 2 incorporates the founder-approved USD, pseudonymous identity, duplicate connection, backend retention, and quarterly-reporting policies. Candidate 2 is independently accepted by `V3_PLAID_ARCHITECTURE_ACCEPTANCE.md`; annotated tag `v3-plaid-architecture-accepted` identifies the documentation-only acceptance checkpoint.
- V3A provider-neutral ingestion Candidates 1 (`1b45e1c8b85789a3847b19afef6567a7dd4b2f3c`) and 2 (`c2adfaca8411b2bdc9a050097452021e79928fcb`) were rejected by independent acceptance. Their annotated `v3a-provider-neutral-ingestion-candidate` and `v3a-provider-neutral-ingestion-candidate-2` tags remain preserved. The narrow legacy-receipt remediation retains schema 10 and is identified by annotated tag `v3a-provider-neutral-ingestion-candidate-3` after all gates pass. Candidate 3 awaits independent re-acceptance; there is still no live provider connection, network path, backend, credential, FX, cursor, webhook, or Reports UI.

## Desktop foundation

The desktop implementation is **ACCEPTED WITH LOW-RISK FOLLOW-UPS**. Read `DESKTOP_FIRST_ARCHITECTURE_DECISION.md` and `V2_DESKTOP_FOUNDATION_ACCEPTANCE.md` first.

- `electron/main.js` owns lifecycle, single-instance behavior, a local application protocol, native dialogs, narrow IPC dispatch, and encrypted files.
- `electron/preload.cjs` exposes a frozen `moneyMovesDesktop` API only; no generic IPC, Node, filesystem, process, or Electron internals reach the renderer.
- `js/services/desktopVaultRepository.js` keeps encryption/decryption, schema migration, domain validation, and unlocked state in the renderer.
- `electron/localVaultRepository.js` stores only encrypted envelopes in `active.mmvault`, `previous.mmvault`, and `pending.mmvault`, with read-back verification, previous preservation, atomic promotion, permissions, and generation conflicts.
- Electron 43.3.0 / Forge 7.11.2 ordinary development commands produce an unsigned ARM64 macOS app, DMG, and ZIP. The independently accepted release workflow produces exact-policy Developer ID-signed, hardened-runtime, notarized artifacts. `inspect:package` scans filesystem/ASAR content, the empty seed, `preload.cjs`, bounded-startup modules, unsafe PNG metadata, and the multi-size canonical macOS icon.
- The founder’s `/Applications` installation was confirmed to be the obsolete ESM-preload artifact (`electron/preload.js`), which explains the permanent mark-only startup screen. The current rebuild uses `electron/preload.cjs`, has a controlled fallback for any missing bridge/stalled inspection, and uses the founder-approved, self-contained `assets/brand/money-moves-mark.png` for both the UI and macOS icon. The direct bundle, DMG app, and ZIP app were verified to contain the same ICNS; Finder/Dock cache appearance still needs human confirmation.

## Product boundaries

The local vault is live authority. Backup/export is manual and encrypted. Restore is explicit and conflict-protected. Existing browser users migrate only by exporting an encrypted backup and restoring it in Electron; there is no automatic localStorage/Vercel/Supabase migration or merge.

Hosted live vault sync is **DEFERRED / NOT ACCEPTED**. The historical Supabase code, migrations, reports, and setup guide are retained as research but are not in the Electron runtime. Encrypted cloud backup, Plaid, phone editing, multi-device editing, shared vaults, reimbursement UI, Shared Expenses, refunds, reporting redesign, and automatic updates are not implemented. V2D Candidate 3 is independently accepted in `V2D_MACOS_SIGNING_NOTARIZATION_ACCEPTANCE.md`.

## Accepted V2B desktop-beta workflows

Read `V2B_DESKTOP_BETA_WORKFLOW_ACCEPTANCE.md` and
`V2B_DESKTOP_BETA_WORKFLOW_CORRECTIONS.md` before changing bucket, allocation,
Overview, or month behavior. The independently accepted correction moves the
domain to schema 8.

- Schema 8 seeds editable Housing, Food, and Transportation only for a genuinely empty original vault; restored, migrated, and otherwise non-empty vaults receive no starters.
- Income (`mm-system-income`), Money Transfer (`mm-system-money-transfer`), and Debt Payment (`mm-system-debt-payment`) are protected system classifications with explicit semantics. Existing buckets are never converted because of their names.
- Weekly Review is parent-first. Parents with children open an explicit child chooser; canceling does not mutate an allocation, rule, or transaction.
- Overview now derives parent totals from canonical allocations, rolling direct and immediate-child amounts together once. Income and transfers are excluded from ordinary spending, while debt payments remain distinct.
- UI month defaults use the Mac’s local clock rather than the deterministic migration fallback timestamp. A user’s valid selected historical month persists.

Independent acceptance found and corrected normal-empty-vault starter seeding,
legacy-content starter pollution, partial classification records, reserved-ID
collisions, and a review path that could collapse a pre-existing split. It then
passed `CI=true pnpm test` with **175 tests**, `CI=true pnpm run electron:test`
with **27 tests**, check/compile/diff validation, package/make, and package
inspection (287 filesystem files and 42 ASAR entries). The direct ARM64 bundle
and read-only mounted DMG were verified; the recorded founder A–F synthetic
matrix remains PASS.

## Accepted Faith & Money devotionals

`FAITH_AND_MONEY_DEVOTIONALS_ACCEPTANCE.md` records final schema-9 acceptance. The original static public-domain-WEB library, encrypted optional journaling, reader/history, deterministic progression, validation, migration, and rollback are accepted. Independent review hardened content validation, impossible/repeated progression, native import results, selected-file errors, and sanitized restore outcomes. The matrix found and corrected a stale renderer draft after restore; successful restore now clears superseded devotional draft memory before rendering restored authority.

Fresh automated validation passed with 198 full tests and 38 Electron-focused tests, zero failures/skips. Fresh unsigned ARM64 app, DMG, and ZIP passed inspection (286 filesystem files, 46 ASAR entries). Direct and mounted-DMG apps had byte-identical ASARs and both passed native Alpha→Beta→wrong-passphrase→confirmed Alpha restore→relaunch using separate disposable profiles. Signing/notarization and V3 architecture planning may begin; release-Mac Finder/Dock appearance remains a low-risk follow-up. Plaid, travel, cloud backup/sync, phone, and shared-vault implementation remain outside this acceptance.

## Validation evidence

- `CI=true pnpm run check`: passed.
- `CI=true pnpm run electron:test`: 38 passed, 0 failed, 0 skipped.
- `CI=true pnpm test`: 198 passed, 0 failed, 0 skipped.
- `CI=true pnpm run electron:package`: ARM64 macOS package passed.
- `CI=true pnpm run electron:make`: unsigned ARM64 DMG and ZIP passed.
- `CI=true pnpm run inspect:package`: passed (286 filesystem files and 46 ASAR entries scanned).
- `python3 -m py_compile start.py`, `git diff --check`, and `CI=true pnpm run content:validate`: passed.
- Direct and mounted-DMG native backup/restore, wrong-passphrase preservation, explicit confirmation, relaunch persistence, supported compact layout, privacy scans, and financial regression are recorded in `FAITH_AND_MONEY_DEVOTIONALS_ACCEPTANCE.md`.

## Accepted V2D Candidate 3 signing and notarization

The first V2D rejection found non-structural entitlement verification and no
cryptographic binding among build-output, DMG, and ZIP apps. Candidate 2 fixed
those verifier defects but was rejected again because its heuristic treated
every otherwise-unrecognized executable as JIT. The Forge callback applied the
JIT plist to all signing targets, so the actual Candidate 2 artifact gave JIT
to native Crashpad and Squirrel ShipIt tools that do not link Electron/V8.

Candidate 3 source changes are confined to macOS release security:

- `scripts/macos-signing-policy.mjs` pins exactly 24 deterministic relative
  paths: 10 Electron main/helper bundle-or-process paths use `jit`, while 14
  native framework/library/support-tool paths use `none`.
- Main and all four helper executables link `@rpath/Electron`, which is the
  technical basis for JIT. Crashpad links native system frameworks only;
  ShipIt links native system frameworks plus Mantle/ReactiveObjC; neither links
  Electron. Frameworks and dylibs are not execution-process entitlement
  boundaries.
- The verifier independently discovers nested code, requires exact set
  equality before assigning a policy, and rejects unknown, missing, duplicate,
  unreadable, or moved components. There is no fallback classification.
- JIT components require exactly
  `com.apple.security.cs.allow-jit=true`. `none` components require the
  entitlement slot to be absent; even an empty dictionary fails.
- The installed `@electron/osx-sign` always passes an entitlement plist, and an
  empty plist embeds an empty dictionary. Release signing therefore uses a
  release-only exact-path codesign step: hardened runtime for every target,
  JIT plist only for pinned JIT targets, and no `--entitlements` argument for
  native/framework/library targets. Strict codesign and exact policy
  verification run before app submission.
- Canonical app-manifest and container provenance enforcement from Candidate 2
  is retained unchanged.

Validation completed:

- `CI=true pnpm run check`: passed.
- Focused release suites: 32 passed, 0 failed, 0 skipped.
- `CI=true pnpm test`: 229 passed, 0 failed, 0 skipped.
- `CI=true pnpm run electron:test`: 38 passed, 0 failed, 0 skipped.
- App notarization: `Accepted`, 0 issues,
  `9a5cb3e6-c343-4d75-a4c7-cfbb383dd5ef`; stapled and validated.
- Final DMG notarization: `Accepted`, 0 issues,
  `32ce4a00-4a18-403f-af72-09cd30ff6e33`; separately stapled and validated.
- `release:macos:verify`, package inspection (289 files and 49 archive
  entries), strict codesign, hardened runtime, exact entitlements, Gatekeeper,
  app/DMG staples, and release security scan: passed.
- Canonical build-output, read-only-DMG, and extracted-ZIP app manifests are
  exactly equal. App manifest SHA-256 is
  `62802941b8661d2b46e2dc1e6f6b406b2f603bf69d3a28b3f93e23ca153af346`;
  DMG SHA-256 is
  `88c6e063bec862e890c6cd89b09bd09a657f66a61b900ef293c45d2b8a70cd42`;
  ZIP SHA-256 is
  `60cf80212d7cda34e04cfbd3dc024e60012e9080290e05f06d3a80f73cd35aac`.
- Forge outputs the ZIP at
  `out/macos-release/make/zip/darwin/arm64/Money Moves-darwin-arm64-2.0.0-desktop.0.zip`;
  the verifier handles that deterministic nested path and rejects absent or
  ambiguous artifacts outside the isolated release root.
- Apple's successful log used `issues:null`; the corrected parser treats only
  `null` as zero or counts an array, while malformed/missing shapes fail
  closed. The Accepted app was stapled without resubmission.
- The package inspector retains the pnpm `--` argument-separator fix.
- A new `/private/tmp` profile passed fresh vault, V2B, Faith & Money,
  backup/restore entry points, lock/unlock, quit/reopen, and persistence in the
  build app and a read-only-DMG copy temporarily installed at
  `/Applications/Money Moves V2D Candidate 3.app`. The installed copy passed
  strict codesign, Gatekeeper, and LaunchServices launch without a security
  warning. Test-only localhost debugging was used only for disposable
  processes, and all disposable resources were removed.

Independent acceptance repeated the source, artifact, Apple, package,
regression, and fresh synthetic installation gates and records the result in
`V2D_MACOS_SIGNING_NOTARIZATION_ACCEPTANCE.md`. No product behavior, vault,
schema, migration, transaction, allocation, devotional, UI, backup/restore,
Plaid, or remote-service boundary changed. The founder app remained untouched
and normal Application Support data was not accessed or modified.

The exact map intentionally fails closed when a future Electron/Forge layout
adds, removes, moves, or changes a signed component. Such an upgrade requires
an intentional linkage/policy review, updated adversarial coverage, fresh
artifacts and notarization, and new independent acceptance.

## Accepted V3 Plaid architecture

Read these together before scoping any V3 implementation:

- `V3_PLAID_ARCHITECTURE.md` records accepted-app discovery, Hosted Link in the
  system browser, pseudonymous device identity, minimal backend persistence,
  cursor acknowledgement, webhooks, disconnect/reconnect, restore behavior,
  current official Plaid references, the three retention classes, local
  quarterly-reporting boundary, and V3A-V3E plus V3R gates.
- `V3_CANONICAL_INGESTION_CONTRACT.md` defines offline provider-neutral account
  and transaction mutations, source keys, exact cents/sign/currency handling,
  field ownership, pending-to-posted identity, modifications, tombstones,
  conflicts, idempotency, atomic apply, USD-only active accounting with explicit
  unsupported-currency evidence, report-sufficient history, and V3A fixtures.
- `V3_SECURITY_TRUST_MODEL.md` defines actor possession boundaries, renderer and
  main separation, backend/KMS/token custody, device credential controls,
  webhook verification, enforceable retention classes, logging/redaction,
  support, threats, and phase gates.
- `V3_ARCHITECTURE_DECISIONS.md` separates product-fixed rules, current
  Plaid-imposed behavior, architecture recommendations, four approved founder
  decisions, locked policies, and tunable operational parameters.

The recommendation keeps every Plaid client secret/access token/public token
out of Electron and the vault. Backend delivers public-token completion and
temporarily encrypted sync batches; the local vault remains the durable
financial authority. Temporary payloads use a short post-ack recovery window;
bounded operational records start at 90 days; active connections follow their
connection lifecycle and are not removed because a quarter or 90 days elapsed.
The Plaid roadmap remains sequential: V3A follows independent
architecture acceptance, V3B follows accepted V3A boundaries, V3C follows V3B,
V3D depends on accepted V3A and V3C, and V3E is the private-beta hardening gate.
V3R is a separate post-V3D local Quarterly Reports product slice and does not
turn V3E or the backend into a reporting implementation.

All four Candidate 1 founder decisions are approved: USD-only first-beta active
accounting, pseudonymous Keychain-backed device identity, likely-duplicate Item
warning/block by default with explicit separate-namespace override, and minimal
backend retention classes. Calendar-quarter reports remain local and derived
from detailed canonical history, which is never deleted at quarter close.
V3B/V3D/V3E still tune exact API-session duration, temporary-payload recovery
window, credential rotation/inactivity and inactive-connection retirement
thresholds, and post-beta operational-record duration under the locked policy.

Independent acceptance verified Candidate 2 against the accepted schema-9
product, current official Plaid documentation, every trust/retention/cursor/
reconciliation/reporting/phase gate, and the founder decision register. Fresh
validation passed `CI=true pnpm run check`, the full 229-test suite, the 38-test
Electron suite, and diff-integrity checks. The acceptance commit/tag changes
documentation status only; no test, product source, schema, migration,
dependency, credential, or asset was added or changed.

## V3A provider-neutral ingestion candidate

Read `V3A_PROVIDER_NEUTRAL_INGESTION_IMPLEMENTATION.md` before reviewing or
extending ingestion. V3A advances the encrypted domain from schema 9 to 10 and
adds a closed, offline canonical mutation-batch contract. Manual, generic CSV,
and synthetic fixture adapters normalize into the same account and transaction
mutations. Exact decimal-string parsing, explicit sign profiles, source-key
identity, durable batch receipts, USD-only active accounting, bounded currency
quarantine, explicit pending-to-posted lineage, source history, tombstones, and
interpretation conflicts are shared domain behavior rather than adapter policy.

The reconciler is clone-first and validates the complete domain before handing
one draft to the encrypted repository. Source fields cannot overwrite friendly
account names, visibility, review, movement type, notes, allocations, claims, or
other user meaning. Incompatible source corrections preserve that meaning in a
resolution snapshot and exclude superseded allocations from active totals.
Known removals retain canonical rows and user evidence; unknown removals retain
source tombstones. Same-key replay is idempotent, while semantic lookalikes are
never merged.

Independent acceptance rejected Candidate 1 for four reproduced defects:
volatile observation time changed the CSV batch digest; account scope was absent
from transaction source identity; classified/reviewed amount changes without
allocations could bypass resolution; and system classification could rewrite
canonical signed cents. Candidate 2 corrects only those defects and their
direct regression surface.

Independent acceptance then rejected Candidate 2 because its Candidate-1
compatibility reader validated only selected outer fields and the reconstructed
legacy digest before returning an optional, unchecked nested receipt result. A
schema-valid corrupted receipt with no CSV transaction effects returned
`already_applied` and its attacker-controlled batch/digest fields.

Batch receipts now use a semantic source/content digest that excludes
`producedAt`, the observation envelope, and per-item observation timestamps.
Those fields remain validated observability metadata. Exact later reimport and
persistence retry reuse one deterministic receipt, while changed source
account, amount, reference, checkpoint, or order still collides. Candidate 3
recognizes an existing Candidate-1 CSV receipt only when its exact outer,
nested-result, count, and nested-reference shape is internally consistent; the
old timestamp-bound envelope reconstructs exactly; and schema-10 account/source
identity, current or historical transaction facts, quarantine/tombstone/conflict
records, and distinct batch audit events prove every claimed mutation. Missing,
wrong-account, wrong-reference, effect-less, or contradictory evidence returns
`LEGACY_RECEIPT_EFFECTS_UNVERIFIED`; malformed or partial receipts return
`LEGACY_RECEIPT_INVALID`; changed content remains `BATCH_ID_COLLISION`. The
service never blindly returns a persisted nested result.

Schema 10 is sufficient for this narrow proof and remains unchanged. It already
stores the needed transaction history and durable evidence. If those fields
cannot prove a legacy replay—such as an empty legacy batch or later source-
account changes without retained account history—the path intentionally fails
closed for explicit integrity handling instead of inventing a migration or
silently reapplying a contradictory batch.

Canonical transaction identity is now
`sourceKind + sourceNamespace + sourceAccountRef + sourceRecordRef`. This uses
schema-10 fields already present, including for external-ID and fallback CSV
references, and the schema-9→10 migration is corrected in place. One shared
interpretation predicate covers classification, review state, allocations,
notes, overrides, and reimbursement-payment use for both ordinary modifications
and pending-to-posted changes. Allocation/review workflows never assign to
source-owned `amountCents`.

The existing CSV entry point now uses the canonical batch path. No new Reports,
quarantine, or conflict-resolution screen was added. No provider product,
network, backend, token, credential, cursor, webhook, FX, or hosted persistence
exists in V3A. Quarter boundaries retain detailed source and user history for a
future local V3R phase without implementing report calculations or snapshots.

Fresh remediation validation passed:

- `CI=true pnpm run check`: passed.
- `CI=true pnpm test`: 303 passed, 0 failed, 0 skipped, 0 todo.
- `CI=true pnpm run electron:test`: 38 passed, 0 failed, 0 skipped, 0 todo.
- Focused V3A suite: 72 passed, 0 failed, 0 skipped, 0 todo.
- `git diff --check` and the forbidden-capability/security scans: passed.

These are implementation results, not independent acceptance. Candidates 1 and
2 and both annotated tags remain intact; the remediation is identified by
annotated tag `v3a-provider-neutral-ingestion-candidate-3`. V3B may begin only
after a new, separate V3A review records re-acceptance.

## Recommended next task

Open a new bounded independent V3A re-acceptance task from
`v3a-provider-neutral-ingestion-candidate-3`. Re-read
the PRD, all four V3 architecture documents, the architecture acceptance, and
the V3A implementation report; independently review schema-9 migration, source
identity, exact money, ownership, reconciliation, atomic persistence, backup,
history retention, and scope/privacy boundaries. Repeat the 303-unit and
38-Electron gates and record acceptance or rejection separately. Do not begin
V3B, V3C, V3D, V3R, or V3E until each preceding phase receives its own
implementation and independent acceptance. The remaining human Finder/Dock/
application-switcher icon-cache visual check remains a low-risk V2D follow-up.
