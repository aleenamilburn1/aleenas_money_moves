# V2D macOS Signing and Notarization Implementation

## Status

**Candidate 3 independently accepted.** A fresh ARM64 app, DMG, and ZIP were
built from the Candidate 3 source on 2026-08-11. The app and final DMG were
separately accepted by Apple with zero issues, stapled, and validated. Exact
component policy, strict codesign, hardened runtime, canonical candidate
equality, Gatekeeper, package/security scans, full regression suites, and the
disposable installation matrix all passed. Independent acceptance is recorded
in `V2D_MACOS_SIGNING_NOTARIZATION_ACCEPTANCE.md`.

The release-status change does not alter product features, vault authority,
migrations, financial behavior, or remote-service boundaries.

## Acceptance history and root cause

The original `v2d-macos-release-candidate` (`0072b61`) was rejected at
acceptance phase 2 for two P1 verifier defects:

1. entitlement verification used text matching and a blacklist instead of an
   exact structural allowlist; and
2. the build-output, DMG, and ZIP applications were not cryptographically
   bound to one candidate payload.

Candidate 2 (`32347a1`, tag `v2d-macos-release-candidate-2`) corrected those
two verifier defects but was rejected at mandatory phase 2 for a second P1
defect. Its component classification granted JIT to every executable not
recognized as a framework or library. Its test suite explicitly accepted an
arbitrary `synthetic_tool` as JIT, and Forge's `optionsForFile` callback applied
the JIT entitlement to all signing targets. The shipped Candidate 2 app
therefore gave `com.apple.security.cs.allow-jit=true` to native
`chrome_crashpad_handler` and Squirrel `ShipIt`, even though neither links the
Electron Framework/V8. This was an actual signed-artifact defect, not merely a
verifier defect.

The Candidate 2 artifacts must not be relabeled or reused as Candidate 3.

## Candidate 3 release architecture

`MONEY_MOVES_RELEASE=1` remains the only release mode, and release output
remains isolated at `out/macos-release`. Ordinary `electron:package` and
`electron:make` remain unsigned and do not access release credentials.

The installed `@electron/osx-sign` implementation always invokes `codesign`
with an entitlement plist. A local signing probe confirmed that even an empty
plist creates an actual empty entitlement dictionary. That cannot satisfy the
Candidate 3 `none` policy, which requires no entitlement dictionary at all.
Candidate 3 therefore removes Forge's permissive signing/notarization callback
and uses this release-only sequence:

1. validate Apple-silicon macOS, the generic Developer ID selector, and the
   `MoneyMovesNotary` Keychain profile without printing identity or credential
   output;
2. clear only `out/macos-release` after preflight passes;
3. let Forge package an unsigned ARM64 application;
4. independently discover the packaged signed-code targets and require exact
   equality with the checked-in policy;
5. sign deepest targets first and the root app last with hardened runtime;
6. include `--entitlements build/entitlements/macos-electron.plist` only for
   exact `jit` paths and omit `--entitlements` entirely for `none` paths;
7. run strict codesign plus exact entitlement verification before any Apple
   upload;
8. submit a temporary ZIP of the app with `MoneyMovesNotary`, require
   `Accepted` and zero log issues, staple, and validate the app;
9. make DMG and ZIP containers from that stapled app; and
10. submit the final DMG separately, require `Accepted` and zero log issues,
    staple, and validate the DMG.

Every release step fails closed. No Apple account, app-specific password, API
key, private key, certificate export, fingerprint, or team-specific identity
is stored in source or release output.

Apple's successful `notarytool log` response encoded an empty issue list as
`issues:null`, rather than `issues:[]`. Candidate 3 now accepts only `null`
(exactly zero issues) or an array (counted exactly); a missing, scalar, or
otherwise malformed field still fails closed. The already-Accepted app was
recovered, stapled, and validated without resubmission.

## Explicit pinned signed-component policy

The checked-in policy contains the exact 24 paths discovered in Electron
43.3.0's packaged ARM64 app. It has 10 `jit` paths and 14 `none` paths. Bundle
and main-executable paths are both pinned because codesign accepts both as
signing targets and the verifier must reject an unexpected target at either
level.

| Relative path inside `Money Moves.app` | Policy | Technical basis |
|---|---|---|
| `.` | `jit` | Root signature for the Electron main application. |
| `Contents/MacOS/Money Moves` | `jit` | ARM64 process links `@rpath/Electron`; V8 requires JIT under hardened runtime. |
| `Contents/Frameworks/Money Moves Helper.app` | `jit` | Electron utility helper application bundle. |
| `Contents/Frameworks/Money Moves Helper.app/Contents/MacOS/Money Moves Helper` | `jit` | ARM64 helper process links `@rpath/Electron`. |
| `Contents/Frameworks/Money Moves Helper (Renderer).app` | `jit` | Electron renderer helper application bundle. |
| `Contents/Frameworks/Money Moves Helper (Renderer).app/Contents/MacOS/Money Moves Helper (Renderer)` | `jit` | ARM64 renderer process links `@rpath/Electron`. |
| `Contents/Frameworks/Money Moves Helper (GPU).app` | `jit` | Electron GPU helper application bundle. |
| `Contents/Frameworks/Money Moves Helper (GPU).app/Contents/MacOS/Money Moves Helper (GPU)` | `jit` | ARM64 GPU helper process links `@rpath/Electron`. |
| `Contents/Frameworks/Money Moves Helper (Plugin).app` | `jit` | Electron plugin helper application bundle. |
| `Contents/Frameworks/Money Moves Helper (Plugin).app/Contents/MacOS/Money Moves Helper (Plugin)` | `jit` | ARM64 plugin helper process links `@rpath/Electron`. |
| `Contents/Frameworks/Electron Framework.framework` | `none` | Framework bundle, not an executable process entitlement boundary. |
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework` | `none` | Electron/V8 framework library; JIT belongs to consuming processes, not the library signature. |
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler` | `none` | Native Crashpad tool; links native macOS frameworks and does not link Electron. |
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib` | `none` | Native dynamic library. |
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib` | `none` | Native dynamic library. |
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib` | `none` | Native dynamic library. |
| `Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib` | `none` | Native dynamic library. |
| `Contents/Frameworks/Mantle.framework` | `none` | Native framework bundle. |
| `Contents/Frameworks/Mantle.framework/Versions/A/Mantle` | `none` | Native framework library. |
| `Contents/Frameworks/ReactiveObjC.framework` | `none` | Native framework bundle. |
| `Contents/Frameworks/ReactiveObjC.framework/Versions/A/ReactiveObjC` | `none` | Native framework library. |
| `Contents/Frameworks/Squirrel.framework` | `none` | Native framework bundle. |
| `Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel` | `none` | Native framework library. |
| `Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt` | `none` | Native Squirrel tool; links AppKit/Foundation/Mantle/ReactiveObjC, not Electron. |

There is no fallback policy. In particular, `unknown executable => jit` no
longer exists.

## Fail-closed discovery and entitlement enforcement

The verifier independently walks the final application without following
symlinks. It discovers the root app, nested code bundles, executable files,
dynamic/native modules, and Mach-O files. Discovery does not assign an
entitlement based on extension, executable mode, or a default branch. It first
requires exact path-set equality with the pinned policy and rejects:

- an unknown executable or nested code bundle;
- a missing helper, tool, library, framework, or other expected path;
- a duplicate or ambiguous discovered path;
- an unreadable directory, file, signature, or entitlement slot; and
- a component moved to an unexpected relative path.

Only after equality succeeds does each path receive its pinned `jit` or `none`
policy.

For `jit`, DER entitlement output must parse to exactly:

```json
{"com.apple.security.cs.allow-jit":true}
```

No additional key is allowed. For `none`, the DER entitlement slot must be
absent; an empty dictionary also fails. Malformed output, missing or false JIT,
an extra entitlement, or any dictionary on a `none` component fails closed.
Every discovered component must also show hardened runtime, and the app must
pass strict deep codesign verification.

## Adversarial and regression verification

The combined focused release suites pass **32/32** tests. Coverage includes:

- complete exact component-set and exact JIT/no-entitlement pass cases;
- unknown executable and unknown nested component;
- missing nested executable and missing helper;
- duplicate/ambiguous discovery;
- component moved to an unexpected path;
- Crashpad/native JIT and arbitrary native entitlement;
- missing JIT, `allow-jit=false`, and extra JIT-process entitlement;
- malformed entitlement output and unreadable required component; and
- Candidate 2's canonical manifest/provenance tests for identical, modified,
  added, removed, and symlink-changed application payloads plus deterministic
  artifact discovery.

The prior test that accepted `synthetic_tool => jit` has been reversed: the
same arbitrary executable now causes exact-set rejection.

Final validation completed on 2026-08-11:

- `CI=true pnpm run check`: passed.
- focused artifact/signing/verifier/security suites: 32 passed, 0 failed, 0
  skipped.
- `CI=true pnpm test`: 229 passed, 0 failed, 0 skipped.
- `CI=true pnpm run electron:test`: 38 passed, 0 failed, 0 skipped.
- `CI=true pnpm run inspect:package -- out/macos-release`: passed (289 files
  and 49 archive entries).
- `CI=true pnpm run release:macos:verify`: passed, including the security scan.

No schema, migration, product behavior, vault, transaction, allocation,
devotional, UI, backup/restore, Plaid, or remote-service change was made.

## Candidate 3 release evidence — 2026-08-11

Preflight confirmed repository integrity, a usable generic Developer ID
Application private key, and authenticated `MoneyMovesNotary` access without
printing identity or credential material. The build cleared only
`out/macos-release`; no Candidate 2 artifact was reused.

- App notarization: `Accepted`, 0 issues, submission
  `9a5cb3e6-c343-4d75-a4c7-cfbb383dd5ef`; stapled and validated.
- DMG notarization: `Accepted`, 0 issues, submission
  `32ce4a00-4a18-403f-af72-09cd30ff6e33`; separately stapled and validated.
- Signed component set: exactly 24 paths; 10 `jit` and 14 `none`.
- Crashpad and ShipIt: hardened runtime with no entitlement dictionary.
- Framework bundles, framework executables, and dynamic libraries: hardened
  runtime with no entitlement dictionary.
- Main app/process and four helper bundle/process pairs: hardened runtime with
  exactly `com.apple.security.cs.allow-jit=true` and no additional key.
- Strict deep codesign and Gatekeeper: passed.
- App architecture and both version fields: exact ARM64 and
  `2.0.0-desktop.0`.
- Build-output, read-only-DMG, and extracted-ZIP canonical manifests: exactly
  equal.
- Canonical app-manifest SHA-256:
  `62802941b8661d2b46e2dc1e6f6b406b2f603bf69d3a28b3f93e23ca153af346`.
- DMG SHA-256:
  `88c6e063bec862e890c6cd89b09bd09a657f66a61b900ef293c45d2b8a70cd42`.
- ZIP SHA-256:
  `60cf80212d7cda34e04cfbd3dc024e60012e9080290e05f06d3a80f73cd35aac`.

Electron Forge's deterministic output paths are:

- `out/macos-release/Money Moves-darwin-arm64/Money Moves.app`;
- `out/macos-release/make/Money Moves-2.0.0-desktop.0-arm64.dmg`; and
- `out/macos-release/make/zip/darwin/arm64/Money Moves-darwin-arm64-2.0.0-desktop.0.zip`.

The verifier searches only inside `out/macos-release`, requires exactly one
expected app, DMG, and nested Forge ZIP, and rejects absent or ambiguous
matches. The package inspector also handles pnpm's literal `--` argument
separator before the explicit output path. The final release scan found no
credentials, private keys, Plaid tokens, user financial-data indicators, or
unexpected environment files.

The disposable matrix created a new profile under `/private/tmp`. The direct
build app and a read-only-DMG copy installed temporarily at
`/Applications/Money Moves V2D Candidate 3.app` both passed fresh vault,
lock/unlock, V2B review, Faith & Money, backup/restore entry points,
quit/reopen, and persistence. The installed candidate passed strict codesign,
Gatekeeper, and LaunchServices launch without an unidentified-developer or
damaged-app block. Localhost remote debugging was enabled only on these
disposable processes. The candidate app, profile, processes, and mount were
removed afterward. `/Applications/Money Moves.app` remained present, and the
founder's normal Application Support data was not accessed or modified.

The exact signed-component map is intentionally coupled to Electron 43.3.0's
package layout. A future Electron or Forge change that adds, removes, moves, or
changes a signed boundary will fail closed until the new layout and linkage are
reviewed, the explicit map and adversarial tests are intentionally updated,
fresh artifacts receive new notarization, and the change is independently
accepted.

## Historical Candidate 2 provenance — not valid for Candidate 3

Candidate 2 previously recorded application-manifest SHA-256
`be72d3f7c0023be535d6a4da203ee03d1099563fd890b29db7335ad54ed51e24`,
DMG SHA-256
`d208ef10ecbe3aa05a43f3eab136f2fe495c05d2d0eafb35a905eb7d592f47dc`,
and ZIP SHA-256
`be150085da934a31ba3426fc76b402fef6e0c90b53f01b43c17f75eacfec98c0`.
Those values describe the rejected excessive-JIT artifacts and must never be
reported as Candidate 3 provenance.

## Acceptance checkpoint

The verified implementation is the `Restrict macOS JIT signing policy`
candidate commit with annotated tag `v2d-macos-release-candidate-3`.
Independent re-acceptance passed and is recorded in
`V2D_MACOS_SIGNING_NOTARIZATION_ACCEPTANCE.md`; the annotated
`v2d-macos-release-accepted` tag identifies its documentation-only acceptance
checkpoint.
