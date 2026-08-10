# Money Moves

A desktop-first, encrypted personal finance application for macOS private beta.

## Private-beta launch

Release candidates are built for Apple silicon as signed, notarized DMG and ZIP artifacts. A trusted release operator must use the documented release command on an Apple-silicon Mac with the required Developer ID certificate and local Keychain notarization profile; neither credential is stored in this repository.

The application, Finder/Dock, and DMG use the same canonical Money Moves mark.
On first launch, a short **Opening your encrypted vault** screen is expected;
it safely becomes Create Vault, Unlock Vault, or a clear recovery-safe error.

For source development only:

```bash
CI=true pnpm install
CI=true pnpm run electron:start
```

The historical browser launcher (`start.py`) and hosted-storage candidate remain in the repository as migration/research material. They are not the private-beta runtime.

## Local vault and migration

Money Moves keeps one authoritative encrypted vault in the operating system’s per-user application-data directory, not in Supabase or browser `localStorage`. The desktop app writes `active.mmvault`, retains `previous.mmvault` as recovery evidence, and never writes plaintext financial data to its vault directory.

To move data from the older browser prototype, first export its encrypted backup, then choose **Restore encrypted backup** in the desktop app. The desktop app validates and decrypts the backup locally, migrates/validates its canonical state, and asks for explicit replacement confirmation. It never imports browser `localStorage`, Vercel, or Supabase automatically.

## First launch

Create a passphrase with at least 12 characters. It encrypts the local vault and is not recoverable. Keep one or more encrypted `.mmvault` backups separately; each still requires the correct passphrase.

This release preserves the current user workflows, schema-8 migrations, IDs, buckets, allocations, reimbursement services, audit history, V1 recovery compatibility, and integer-cent accounting. New empty vaults start with editable Housing, Food, and Transportation buckets, plus protected Income, Money Transfer, and Debt Payment classifications. It does not contain bank credentials, access tokens, cloud backup, or a live bank connection.

## Desktop foundation status

The Electron shell, encrypted local-file repository, atomic replacement, generation conflict checks, manual encrypted backup/restore, single-instance behavior, package inspection, founder-approved unified app icon, and macOS release signing configuration are implemented. A candidate is distributable only after Apple accepts notarization, stapling and Gatekeeper checks pass, and the synthetic installation matrix is completed. Hosted live vault synchronization is deferred and not accepted.

## Monthly rollover

At launch, the app checks the computer’s local month. A fresh or invalid month selection uses that local month, while an explicit valid historical selection remains selected. Bucket order, targets, rules, travel history, and preferences carry forward. Overview totals roll direct and immediate-child allocations up to their parent exactly once.

The app cannot fetch transactions while closed. The V2 import workflow is intentionally out of scope for this foundation release.

## Security

- Renderer-only AES-256-GCM vault encryption
- PBKDF2-SHA-256 with 600,000 iterations
- Fresh IV for every save
- 60-minute default inactivity lock
- Native encrypted backup export and explicit restore
- Sandboxed renderer, context isolation, narrow IPC, and local application protocol
- No remote financial persistence, analytics, external scripts, or remote fonts

See `SECURITY.md` for the threat model.

## Current V1 screens

- Overview
- Weekly review
- Buckets & rules
- Travel
- Debt & goals
- Settings & vault

## Important limitation

Direct bank API synchronization is not included. Cloud backup, live sync, phone editing, shared vaults, reimbursement UI, Shared Expenses, refund workflows, and automatic updates remain out of scope for this foundation. Signing and notarization are release operations documented in `docs/engineering/V2D_MACOS_SIGNING_NOTARIZATION_IMPLEMENTATION.md`.
