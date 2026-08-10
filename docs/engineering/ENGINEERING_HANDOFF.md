# Money Moves Engineering Handoff

## Current repository state

- Repository: `/Users/aleenamilburn/Downloads/aleenas_money_moves`
- Branch: `main`
- Hosted correction preservation checkpoint: `c591368` (`Harden hosted storage correction candidate`)
- Desktop foundation candidate reviewed: `v2-desktop-foundation-candidate` (`99c04ee`, `Implement desktop-first Electron foundation`)
- Current domain schema: 9
- Desktop package version: `2.0.0-desktop.0`
- Founder direction: macOS-first Electron desktop app with one authoritative encrypted local vault per owner.

## Desktop foundation

The desktop implementation is **ACCEPTED WITH LOW-RISK FOLLOW-UPS**. Read `DESKTOP_FIRST_ARCHITECTURE_DECISION.md` and `V2_DESKTOP_FOUNDATION_ACCEPTANCE.md` first.

- `electron/main.js` owns lifecycle, single-instance behavior, a local application protocol, native dialogs, narrow IPC dispatch, and encrypted files.
- `electron/preload.cjs` exposes a frozen `moneyMovesDesktop` API only; no generic IPC, Node, filesystem, process, or Electron internals reach the renderer.
- `js/services/desktopVaultRepository.js` keeps encryption/decryption, schema migration, domain validation, and unlocked state in the renderer.
- `electron/localVaultRepository.js` stores only encrypted envelopes in `active.mmvault`, `previous.mmvault`, and `pending.mmvault`, with read-back verification, previous preservation, atomic promotion, permissions, and generation conflicts.
- Electron 43.3.0 / Forge 7.11.2 produce an unsigned ARM64 macOS app, DMG, and ZIP. `inspect:package` scans filesystem/ASAR content, the empty seed, `preload.cjs`, bounded-startup modules, unsafe PNG metadata, and the multi-size canonical macOS icon.
- The founder’s `/Applications` installation was confirmed to be the obsolete ESM-preload artifact (`electron/preload.js`), which explains the permanent mark-only startup screen. The current rebuild uses `electron/preload.cjs`, has a controlled fallback for any missing bridge/stalled inspection, and uses the founder-approved, self-contained `assets/brand/money-moves-mark.png` for both the UI and macOS icon. The direct bundle, DMG app, and ZIP app were verified to contain the same ICNS; Finder/Dock cache appearance still needs human confirmation.

## Product boundaries

The local vault is live authority. Backup/export is manual and encrypted. Restore is explicit and conflict-protected. Existing browser users migrate only by exporting an encrypted backup and restoring it in Electron; there is no automatic localStorage/Vercel/Supabase migration or merge.

Hosted live vault sync is **DEFERRED / NOT ACCEPTED**. The historical Supabase code, migrations, reports, and setup guide are retained as research but are not in the Electron runtime. Encrypted cloud backup, Plaid, phone editing, multi-device editing, shared vaults, reimbursement UI, Shared Expenses, refunds, reporting redesign, and automatic updates are not implemented. V2D release-only signing and notarization is candidate-verified in `V2D_MACOS_SIGNING_NOTARIZATION_IMPLEMENTATION.md`; independent acceptance remains separate.

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

## Recommended next task

Perform independent V2D candidate acceptance in a new task. Do not begin
Plaid, cloud backup, hosted sync, phone support, shared vaults, or travel
implementation without a separately approved scope and acceptance plan.
