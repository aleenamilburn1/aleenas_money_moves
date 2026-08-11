# V2D macOS Signing and Notarization Acceptance

## Verdict

**ACCEPTED.** Money Moves Candidate 3 satisfies the independent V2D macOS
signing, notarization, provenance, package-security, regression, and synthetic
installation gates. This acceptance changes release status only. It does not
change product behavior, vault authority, schema, migrations, financial data,
or remote-service boundaries.

## Candidate and checkpoint integrity

- Candidate commit:
  `f912517e3fcd5233744cb69fa03a3d1471d60dc0`
  (`Restrict macOS JIT signing policy`).
- Candidate tag: annotated `v2d-macos-release-candidate-3`, dereferencing to the
  exact Candidate 3 commit.
- Ancestry: Candidate 3 descends from Candidate 2
  (`32347a15705f1272be660375d62a19d4ac7740fa`), which descends from Candidate 1
  (`0072b61347faaf89eda5e9f66ddf568b9ef0ef1b`).
- Previous candidate tags remained at their original commits. The accepted V2C
  checkpoint remained at `94ec1aa3dc218c18376f64bcf4fc8978fb336333`.
- No V2D accepted tag existed before this review.

Candidate 1 was rejected because entitlement validation was not an exact
structural allowlist and the build-output, DMG, and ZIP apps were not
cryptographically bound to one payload. Candidate 2 fixed those verifier
defects but was rejected because its heuristic classified unknown executables
as JIT and the shipped app granted JIT to native Crashpad and Squirrel ShipIt.
Candidate 3 corrects the signing policy and contains newly built and notarized
artifacts; no Candidate 1 or Candidate 2 artifact is accepted by this record.

## Independent scope and security review

The complete Candidate 2-to-Candidate 3 diff contains macOS signing policy,
release/notarization tooling, release verification, focused tests, and V2D
documentation/status only. It does not change UI or product workflows, vault
semantics or schema, migrations, transactions, allocations, devotionals,
backup/restore behavior, Plaid architecture, or remote-service boundaries.

A history/diff scan found no private-key material, Apple credential literal,
known token prefix, Plaid credential literal, certificate export, or personal
financial-data addition. Pre-existing `.DS_Store` and pnpm workspace-state
changes were left untouched and excluded from this acceptance.

The relevant PRD release gates remain the encrypted-vault end-to-end coverage,
clean-profile restore/persistence expectations, release checklist, and the rule
that status changes only after verification. The V1 audit's release boundary
also requires packaged-data and clean-profile checks. Those requirements are
covered below without accessing genuine user data.

## Exact signed-component policy

Independent filesystem and Mach-O enumeration of the Candidate 3 application
found 9 bundle boundaries and 15 Mach-O boundaries, for exactly **24 signed
paths**. This independently agrees with the pinned map:

| Classification | Bundle paths | Executable/library paths | Total |
|---|---:|---:|---:|
| Exact JIT-only | 5 | 5 | 10 |
| No entitlement dictionary | 4 | 10 | 14 |
| Total | 9 | 15 | 24 |

The 10 JIT paths are the root app and four Electron helper app bundles plus
their five main/helper executable paths. Each executable is ARM64 and links
`@rpath/Electron Framework.framework/Electron Framework`; V8 execution under
hardened runtime provides the technical basis for exact JIT-only entitlement.

The 14 no-entitlement paths are Electron Framework, its framework executable,
Crashpad, four Electron-related dylibs, Mantle and its framework executable,
ReactiveObjC and its framework executable, Squirrel and its framework
executable, and ShipIt. Independent linkage inspection established that
Crashpad uses native system frameworks and does not link Electron. ShipIt uses
native system frameworks plus Mantle and ReactiveObjC and does not link
Electron. Framework and dynamic-library signatures are not Electron/V8 process
entitlement boundaries.

The policy has no extension, executable-status, or generic fallback
classification. Exact set and kind equality are required before any path
receives a policy. Unknown, missing, moved, duplicate/ambiguous, unreadable,
and kind-mismatched components fail closed.

## Signing implementation and actual entitlements

Release signing is enabled only by `MONEY_MOVES_RELEASE=1`; ordinary development
packages remain unsigned and credential-free. Release preflight requires an
Apple-silicon Mac, usable generic Developer ID Application signing identity,
`notarytool`, and the `MoneyMovesNotary` Keychain profile before it clears only
the isolated release directory.

The release signer discovers the exact component set, signs deepest paths
first, applies hardened runtime and a secure timestamp to every target, passes
the JIT plist only for exact pinned JIT paths, and passes no entitlement
argument to `none` paths. Unknown targets cannot silently receive either JIT or
no-entitlement treatment. Strict deep codesign and exact entitlement
verification run before Apple upload.

The verifier independently inspects the actual code signature and DER
entitlement slot for every path. Candidate 3's real binaries passed all 24
path-specific checks:

- 10 Electron app/process boundaries contain exactly
  `com.apple.security.cs.allow-jit=true` and no additional key;
- `chrome_crashpad_handler` has no entitlement dictionary;
- Squirrel `ShipIt` has no entitlement dictionary; and
- framework bundles, framework executables, and dylibs have no entitlement
  dictionary.

Every inspected path has hardened runtime. Candidate 2's excessive-JIT defect
is absent from the Candidate 3 artifacts.

## Adversarial tests

The focused artifact/signing/verifier/security command passed **32/32**, with 0
failed and 0 skipped. The tests exercise the complete exact map, correct JIT
and no-entitlement cases, unknown executable and nested code, missing helper
and tool, moved path, duplicate/ambiguous discovery, kind mismatch, unexpected
64-bit universal Mach-O, Crashpad-style and ShipIt-style excessive JIT,
arbitrary native entitlement, missing/false/extra JIT entitlement, malformed
entitlement data, unreadable components, and exact provenance failures for
modified, added, removed, and symlink-changed payloads. The former permissive
`synthetic_tool => jit` behavior is now an explicit rejection case.

## Artifact identity and canonical provenance

No rebuild, re-sign, or resubmission occurred during acceptance. The isolated
release output contains exactly the expected Candidate 3 build-output app, DMG,
and ZIP for ARM64 version `2.0.0-desktop.0`. Build-output, read-only-DMG, and
extracted-ZIP application manifests are exactly equal, including file bytes,
modes, directories, and symlink targets.

- Canonical application-manifest SHA-256:
  `62802941b8661d2b46e2dc1e6f6b406b2f603bf69d3a28b3f93e23ca153af346`
- DMG SHA-256:
  `88c6e063bec862e890c6cd89b09bd09a657f66a61b900ef293c45d2b8a70cd42`
- ZIP SHA-256:
  `60cf80212d7cda34e04cfbd3dc024e60012e9080290e05f06d3a80f73cd35aac`

These independently calculated values exactly match the Candidate 3 provenance
record and differ from the rejected Candidate 2 values.

## Apple notarization and native security

Apple was queried independently using only `MoneyMovesNotary`:

| Submission | ID | Status | Log status | Issues representation | Count |
|---|---|---|---|---|---:|
| Application | `9a5cb3e6-c343-4d75-a4c7-cfbb383dd5ef` | Accepted | Accepted | `null` | 0 |
| DMG | `32ce4a00-4a18-403f-af72-09cd30ff6e33` | Accepted | Accepted | `null` | 0 |

The submission and log IDs matched. The notarization parser treats a genuine
`issues:null` as zero, counts issue arrays exactly, and rejects missing,
scalar, non-object, or otherwise ambiguous shapes.

Strict deep codesign passed for the build-output, mounted-DMG, extracted-ZIP,
and temporarily installed applications, including nested code. The root and
all 24 pinned paths passed hardened-runtime and exact-entitlement validation.
The application and DMG staples validated. Gatekeeper accepted the
build-output, mounted-DMG, and installed applications as Notarized Developer ID
software. No unidentified-developer or damaged-app condition appeared. The
main executable is ARM64, and both application version fields are exactly
`2.0.0-desktop.0`.

The outer DMG is notarized and stapled but is not separately Developer ID
code-signed; Gatekeeper acceptance above applies to each contained application.
The immutable Candidate 3 DMG hash and exact application-manifest binding
provide the acceptance provenance. Signing the DMG container itself remains a
defense-in-depth follow-up rather than a V2D acceptance blocker.

## Package and regression results

- `CI=true pnpm run release:macos:verify`: passed, including canonical
  build/DMG/ZIP equality, 24-path entitlement verification, strict codesign,
  staples, Gatekeeper, and the release-security scan.
- `CI=true pnpm run inspect:package -- out/macos-release`: passed; 289
  filesystem files and 49 archive entries scanned.
- Package/security scan: no Apple credentials, app-specific passwords, private
  keys, certificate exports, Plaid credentials/tokens, real vault or financial
  data indicators, founder data, unexpected `.env` material, production remote
  debugging, or unexpected packaged source/research/test material.
- `CI=true pnpm run check`: passed.
- `CI=true pnpm test`: **229/229** passed, 0 failed, 0 skipped.
- `CI=true pnpm run electron:test`: **38/38** passed, 0 failed, 0 skipped.

No migration was added or required. No implementation or test file was changed
by this acceptance review.

## Fresh synthetic installation matrix

Two separate, newly created `/private/tmp` profiles were used. Localhost remote
debugging was enabled only with launch arguments on the disposable acceptance
processes; production release configuration and packaged content do not enable
it.

The build-output application passed Gatekeeper, first launch, fresh synthetic
vault creation, lock/unlock, V2B Review presence, Faith & Money, backup/restore
entry points, quit/reopen, and encrypted persistence.

The DMG was mounted read-only. Its contained app passed strict codesign and
Gatekeeper, was copied only to
`/Applications/Money Moves V2D Acceptance 3.app`, and the DMG was ejected. The
installed copy then passed strict codesign, Gatekeeper, first launch, a separate
fresh synthetic vault, lock/unlock, V2B Review, Faith & Money, backup/restore
entry points, quit/reopen, and encrypted persistence. No security warning
blocked either run.

All acceptance processes, profiles, mounts, and the temporary installed app
were removed. `/Applications/Money Moves.app` retained the same inode and
modification time recorded before the matrix. The founder's normal Money Moves
Application Support path was never accessed or modified.

## Documentation and remaining low-risk operations

The Candidate 3 implementation record, implementation status, engineering
handoff, and README are consistent with the accepted behavior and retained
product boundaries. This acceptance record supersedes their prior
candidate-pending language.

The exact map is intentionally coupled to Electron 43.3.0's package layout. A
future Electron/Forge upgrade that adds, removes, moves, or changes a signed
component will fail closed until its linkage and entitlement requirement are
reviewed, the explicit map and adversarial tests are intentionally updated,
fresh artifacts receive new notarization, and the change is independently
accepted. Finder/Dock/application-switcher icon-cache appearance remains a
human release-Mac visual check. Separately signing the outer DMG may be added as
defense in depth.

## Acceptance checkpoint

The annotated tag `v2d-macos-release-accepted` points to the documentation-only
acceptance commit containing this record. Its parent contains Candidate 3
`f912517e3fcd5233744cb69fa03a3d1471d60dc0`. Previous candidate and accepted
checkpoint tags remain unmoved.
