# V2D macOS Signing and Notarization Implementation

## Status

**Candidate verification complete; independent acceptance pending.** This document
describes only the release pipeline. It does not change product features,
encrypted-vault semantics, devotional content, transaction behavior, or remote
service boundaries. A candidate commit and tag are forbidden until Apple
notarization, stapling, strict signing checks, Gatekeeper assessment, package
scan, and the synthetic installation matrix all pass.

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

## Hardened runtime and entitlements

Every signed Electron component uses the hardened runtime and the checked-in
`build/entitlements/macos-electron.plist` entitlement file:

| Entitlement | Why it is present |
| --- | --- |
| `com.apple.security.cs.allow-jit` | Electron's V8 engine requires JIT execution in the main and helper processes when the hardened runtime is enabled. |

No other entitlement is granted. In particular the release does **not** grant
unsigned executable memory, disabled library validation, camera, microphone,
audio input, location, Bluetooth, USB, printing, App Sandbox, or application
group access. `preAutoEntitlements` and provisioning-profile embedding are
disabled because Developer ID direct distribution needs neither and must not
quietly add a broader entitlement set.

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
- a hardened-runtime signature and the exact JIT-only entitlement set;
- `xcrun stapler validate` success for both the app and DMG; and
- `spctl --assess --type execute --verbose=4` success for the app.

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

## Candidate verification record — 2026-08-10

- The packaged app ZIP submission `845dec41-a8a2-4dea-a1a6-d09110bc10f7`
  was accepted by Apple; the app ticket validates.
- The existing DMG submission `c587e0c2-9bbd-4b16-acf0-312380543f7d` was
  accepted with zero notarization-log issues and its separate ticket validates.
- Strict `codesign` verification passed for the app, every nested Electron
  framework/helper, the app mounted from the DMG, the app extracted from the
  ZIP, and the installed candidate copy. The hardened runtime and exact
  JIT-only entitlement set passed verification. Gatekeeper assessed both the
  build-output and installed candidate apps as notarized Developer ID software.
- `release:macos:verify`, package inspection (287 filesystem files and 49 ASAR
  entries), and the credentials/private-key/token/.env scan passed.
- The verifier correction now recursively discovers exactly one expected ARM64
  ZIP below `make/`, rejects missing/ambiguous app/DMG/ZIP artifacts, confines
  discovery to `out/macos-release`, and verifies the contents of the DMG and
  ZIP. The security scanner skips Electron framework symlinks rather than
  following outside the release tree. The package inspector accepts pnpm's
  literal argument separator before the explicit output path.
- `CI=true pnpm test` passed 201 tests; `CI=true pnpm run electron:test` passed
  38 tests; `CI=true pnpm run check` passed.
- The disposable direct build-output and installed `/Applications/Money Moves
  V2D Candidate.app` matrix both passed fresh synthetic vault creation,
  lock/unlock, V2B review entry point, Faith & Money, backup/restore entry
  points, and quit/reopen persistence. The DMG was read-only mounted, copied,
  ejected before installed launch, and the installed candidate passed strict
  signing and Gatekeeper. A localhost debug port was enabled only on these
  disposable test launches; it is absent from normal production configuration.
  `/Applications/Money Moves.app` and the founder's Application Support data
  were not accessed or changed.

No independent acceptance is claimed. Candidate commit/tag creation is the
next release-control step once the final Git diff and secret review pass.

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
