# Money Moves Engineering Handoff

## Current repository state

- Repository: `/Users/aleenamilburn/Downloads/aleenas_money_moves`
- Branch: `main`
- Hosted correction preservation checkpoint: `c591368` (`Harden hosted storage correction candidate`)
- Desktop foundation candidate reviewed: `v2-desktop-foundation-candidate` (`99c04ee`, `Implement desktop-first Electron foundation`)
- Original V2D candidate rejected at acceptance phase 2: `v2d-macos-release-candidate` (`0072b61`)
- V2D Candidate 2 rejected at acceptance phase 2: `v2d-macos-release-candidate-2` (`32347a1`, `Harden macOS release verification`)
- V2D Candidate 3 is the verified `Restrict macOS JIT signing policy` candidate with annotated tag `v2d-macos-release-candidate-3`; independent re-acceptance remains pending
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

Hosted live vault sync is **DEFERRED / NOT ACCEPTED**. The historical Supabase code, migrations, reports, and setup guide are retained as research but are not in the Electron runtime. Encrypted cloud backup, Plaid, phone editing, multi-device editing, shared vaults, reimbursement UI, Shared Expenses, refunds, reporting redesign, and automatic updates are not implemented. V2D Candidate 3 is fully candidate-verified in `V2D_MACOS_SIGNING_NOTARIZATION_IMPLEMENTATION.md`; independent re-acceptance remains separate.

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

## V2D Candidate 3 signing-policy remediation

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

No product behavior, vault, schema, migration, transaction, allocation,
devotional, UI, backup/restore, Plaid, or remote-service boundary changed. The
founder app remained present and normal Application Support data was not
accessed or modified. No independent V2D acceptance is claimed, and no V2D
accepted tag may be created.

## Recommended next task

Run independent re-acceptance against annotated tag
`v2d-macos-release-candidate-3`. Do not create an accepted tag, and do not
begin Plaid, cloud backup, hosted sync, phone support, shared vaults, or travel
implementation without a separately approved scope and acceptance plan.
