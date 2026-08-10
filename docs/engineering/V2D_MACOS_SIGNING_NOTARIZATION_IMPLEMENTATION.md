# V2D macOS Signing and Notarization Implementation

## Status

**Release-verification remediation complete; independent re-acceptance
pending.** Independent acceptance rejected the original
`v2d-macos-release-candidate` at phase 2 for two P1 verifier defects: entitlement
verification was a text search plus blacklist rather than an exact allowlist,
and the build-output, DMG, and ZIP apps were not cryptographically bound to one
candidate. Both defects are remediated and locally verified, but no independent
acceptance is claimed. This document describes only the release pipeline. It
does not change product features, encrypted-vault semantics, devotional
content, transaction behavior, or remote service boundaries.

## Release architecture

`forge.config.js` treats `MONEY_MOVES_RELEASE=1` as the only release mode.
Ordinary `electron:package` and `electron:make` runs retain the prior unsigned
developer-build behavior and do not access a signing identity or notarization
credential. Release output is isolated at `out/macos-release`, so it cannot be
confused with prior development artifacts.

In release mode, Electron Forge delegates to `@electron/osx-sign` with the
installed `Developer ID Application` identity selector, validation enabled,
strict post-sign verification, and `continueOnError:false`. Therefore an
absent/unusable identity stops the command; it does not produce an unsigned
candidate. Forge then delegates to `@electron/notarize`, using only the
Keychain profile name `MoneyMovesNotary`. The profile is resolved by
`notarytool`; no Apple account, app-specific password, API key, certificate
export, private key, fingerprint, or team-specific identity string is kept in
source, logs, environment files, or Git.

Electron Forge notarization submits the packaged signed app as a ZIP, waits for
Apple's result, and staples the accepted ticket to the app before Forge makes
distribution artifacts. A DMG is a distinct container and cannot inherit that
app ticket. `notarize-macos-dmg.mjs` therefore submits the finished DMG with
the same Keychain profile, inspects its issue count, and staples its own ticket.
A network/error result is a hard failure and leaves no candidate claim.

## Hardened runtime and exact entitlement policy

Every signed code object uses the hardened runtime. Electron Forge's signing
callback supplies the checked-in `build/entitlements/macos-electron.plist` to
executable processes. On current macOS signing tools, library code does not
receive an entitlement dictionary. The only approved entitlement is:

| Entitlement | Why it is present |
| --- | --- |
| `com.apple.security.cs.allow-jit` | Electron's V8 engine requires JIT execution in the main and helper processes when the hardened runtime is enabled. |

No other entitlement is permitted. In particular the release does **not** grant
unsigned executable memory, disabled library validation, camera, microphone,
audio input, location, Bluetooth, USB, printing, App Sandbox, or application
group access. `preAutoEntitlements` and provisioning-profile embedding are
disabled because Developer ID direct distribution needs neither and must not
quietly add a broader entitlement set.

The verifier recursively enumerates 24 signed code paths. Bundle and executable
paths are both checked intentionally: a bundle path resolves its main binary,
while explicitly enumerating executable paths prevents nested code from being
missed by discovery.

| Required policy | Signed paths |
| --- | --- |
| Exact `com.apple.security.cs.allow-jit = true`, with no additional key | The root `Money Moves.app` and `Contents/MacOS/Money Moves`; all four `Money Moves Helper*.app` bundles and each corresponding `Contents/MacOS` helper executable; Electron's `chrome_crashpad_handler`; and Squirrel's `ShipIt` executable. These are executable processes to which the Forge signing callback supplies the Electron entitlement file. |
| No entitlement dictionary | `Electron Framework.framework` and its primary `Electron Framework` binary; `libEGL.dylib`, `libGLESv2.dylib`, `libffmpeg.dylib`, and `libvk_swiftshader.dylib`; and the `Mantle.framework`, `ReactiveObjC.framework`, and `Squirrel.framework` bundles plus each primary framework binary. These are libraries; current `codesign` omits library entitlements by design. |

For every path, the verifier extracts the signed DER entitlement slot, converts
it to an XML property list with the macOS CoreEntitlements tool, parses it
structurally with `plutil`, and compares the resulting dictionary to the exact
policy. It fails closed for an unreadable component, malformed entitlement
data, an extra key, missing JIT, a non-boolean or false JIT value, or any
entitlement dictionary on a no-entitlement library. It does not use a
blacklist.

## Trusted-operator release commands

Run from the repository root on an Apple-silicon Mac. The operator must already
have a usable Developer ID Application certificate/private key in the login
Keychain and a validated `MoneyMovesNotary` profile in that Keychain. Do not
place any credential in the command line or an environment file.

```sh
CI=true pnpm run check
CI=true pnpm run electron:test
CI=true pnpm test
CI=true pnpm run release:macos
CI=true pnpm run inspect:package -- out/macos-release
CI=true pnpm run release:macos:verify
```

`release:macos` first validates that the host is Darwin/arm64 and that
`notarytool` can use `MoneyMovesNotary`; it clears only
`out/macos-release`, builds fresh ARM64 output, signs, notarizes, waits, and
staples the app, then separately notarizes and staples the finished DMG. An
unavailable Keychain profile prevents packaging. A missing or unusable signing
identity causes Forge signing to fail closed.

When diagnosing a network-interrupted upload, inspect status without exposing
credentials:

```sh
xcrun notarytool history --keychain-profile MoneyMovesNotary --output-format json
xcrun notarytool log SUBMISSION_ID --keychain-profile MoneyMovesNotary
```

Only retrieve the log after the submission has reached a final status. Treat
every warning or error as a release finding. Do not publish the submission ID
or log if it contains material that should remain private.

## Verification and inspection

`release:macos:verify` requires all of the following and exits non-zero for
any failure:

- signed `Money Moves.app`, `.dmg`, and `.zip` in the isolated release output;
- ARM64-only application executable and package version metadata matching
  `2.0.0-desktop.0`;
- `codesign --verify --deep --strict --verbose=2` success;
- a hardened-runtime signature and the per-component exact entitlement policy;
- independently generated canonical manifests proving that the build-output,
  mounted-DMG, and extracted-ZIP apps are the same candidate;
- `xcrun stapler validate` success for both the app and DMG; and
- `spctl --assess --type execute --verbose=4` success for the app.

The canonical application manifest is deterministic line-delimited JSON in
bytewise relative-path order. It records every directory, every regular file's
relative path, POSIX mode, size, and SHA-256 digest, and every symlink's path
and literal target. Symlinks are never followed. Directory entries make added
or removed empty directories visible. The manifest excludes timestamps,
ownership, ACLs, and extended attributes because read-only DMG mounting and
ZIP extraction cannot preserve those consistently and they are not shipped
file payload. The verifier compares the canonical manifests exactly and reports
only added/removed/changed entry counts on mismatch, never file contents. It
also records SHA-256 provenance for the final DMG and ZIP containers.

`inspect:package -- out/macos-release` scans packaged filesystem and ASAR
content for excluded research/test material, forbidden source/config files,
unsafe image metadata, the empty bootstrap seed, and required desktop
components. `scan-macos-release.mjs` checks the release output and root for
private-key markers, credential/token material, and unexpected `.env` files;
it reports only pass/fail, never matched values. Its final result, the Git diff
review, and a manual confirmation that no local paths, vaults, financial data,
or sensitive diagnostics entered generated output are required before a
candidate commit.

## Artifact locations and installation matrix

Expected outputs after a passing release command:

- `out/macos-release/Money Moves-darwin-arm64/Money Moves.app`
- `out/macos-release/make/Money Moves-2.0.0-desktop.0-arm64.dmg`
- `out/macos-release/make/zip/darwin/arm64/Money Moves-darwin-arm64-2.0.0-desktop.0.zip`

Use a disposable synthetic profile by redirecting the test app's user-data
location; never use, rename, reset, or inspect the founder's real Money Moves
Application Support directory. The required manual matrix is:

1. launch the signed build-output app;
2. mount the DMG, copy the app to `/Applications`, eject the DMG, and launch
   the installed copy;
3. create a synthetic vault; lock/unlock it; exercise V2B workflows, Faith &
   Money devotionals, and backup/restore entry points;
4. quit/reopen the installed app and confirm the synthetic vault persists; and
5. confirm Gatekeeper shows neither an unidentified-developer nor damaged-app
   warning.

## Remediation verification record — 2026-08-10

- Independent acceptance rejected the original candidate for the two P1
  verifier defects described in Status. Acceptance stopped at phase 2; no V2D
  acceptance commit or tag exists.
- The previously accepted packaged-app and DMG Apple submissions remain the
  provenance of the existing artifacts. The existing app, DMG, and ZIP were
  reused unchanged: no rebuild, re-sign, artifact-content change, notarization
  resubmission, or Apple credential operation occurred during remediation.
- `CI=true pnpm run release:macos:verify` passed. The build-output, mounted-DMG,
  and extracted-ZIP canonical manifests matched exactly at application-manifest
  SHA-256 `be72d3f7c0023be535d6a4da203ee03d1099563fd890b29db7335ad54ed51e24`.
- Container provenance is DMG SHA-256
  `d208ef10ecbe3aa05a43f3eab136f2fe495c05d2d0eafb35a905eb7d592f47dc`
  and ZIP SHA-256
  `be150085da934a31ba3426fc76b402fef6e0c90b53f01b43c17f75eacfec98c0`.
- Exact entitlement validation passed for all 24 enumerated signed code paths.
  Strict deep signing passed for the build-output, DMG, and ZIP apps; hardened
  runtime passed; app and DMG stapling passed; and Gatekeeper accepted the app
  as Notarized Developer ID software.
- The release security scan passed. `CI=true pnpm run inspect:package --
  out/macos-release` passed with 287 filesystem files and 49 ASAR entries.
- Adversarial tests exercise the reusable verifier functions and pass the exact
  JIT-only case; arbitrary and known-dangerous extra entitlements; missing or
  false JIT; malformed plist output; the no-entitlement policy; identical
  candidates; stale same-version/signature-metadata payloads; modified, added,
  and removed files; changed symlink targets; and missing/ambiguous artifacts.
- `CI=true pnpm run check` passed. `CI=true pnpm test` passed 210 tests with
  zero failures or skips. `CI=true pnpm run electron:test` passed 38 tests with
  zero failures or skips.
- The remediation did not access or modify `/Applications/Money Moves.app` or
  any Money Moves Application Support data.

No independent acceptance is claimed. The remediation candidate is ready for a
fresh independent acceptance run from phase 1.

## Known operational risks

- Apple processing time and network availability are external dependencies.
  Preserve the submission ID, wait for a final Apple status, retrieve a failed
  submission's log, and do not declare success from a local upload alone.
- macOS may ask the trusted release operator to unlock the login Keychain for
  `codesign`. The password is the macOS login/Keychain password; it must never
  be supplied to Codex, a shell command, Git, or this repository.
- Signing the Electron framework contains many nested components and can take
  several minutes. Keep the release terminal and network connection available
  until Forge returns a final result.
