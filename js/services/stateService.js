import {migrateState, validateFoundationDomain} from '../domain/migrations.js';
import {getStateRevision} from './stateRevision.js';
import {applyMutationBatchAtomically} from './ingestionService.js';

export class LocalVaultAdoptionConflictError extends Error {
  constructor() {
    super('A hosted vault already exists for this account. Money Moves will not overwrite either vault automatically.');
    this.name = 'LocalVaultAdoptionConflictError';
    this.code = 'LOCAL_VAULT_ADOPTION_CONFLICT';
  }
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertFoundationState(migration) {
  getStateRevision(migration.state);
  const validation = validateFoundationDomain(migration.state.domain);
  if (!validation.ok) throw new Error(`Migrated state failed foundation validation: ${validation.errors.join('; ')}`);
  return migration;
}

export function createStateService({repository, seed, migrate = migrateState} = {}) {
  if (!repository) throw new Error('State service requires a vault repository.');

  function migrateForUse(input) {
    return assertFoundationState(migrate(input || seed));
  }

  return {
    async hasVault() {
      return repository.hasVault();
    },
    readLegacyState() {
      return repository.readLegacyState();
    },
    localRecoveryStatus() {
      let encryptedVault = false;
      let encryptedVaultCorrupt = false;
      try { encryptedVault = Boolean(repository.readLocalV1Record()); }
      catch { encryptedVaultCorrupt = true; }
      return {
        encryptedVault,
        encryptedVaultCorrupt,
        legacyState:Boolean(repository.readLegacyState())
      };
    },
    async adoptLocalVault(passphrase, options = {}) {
      const local = repository.readLocalV1Record();
      if (!local) throw new Error('No encrypted local recovery vault was found in this browser.');
      if (await repository.hasVault()) throw new LocalVaultAdoptionConflictError();
      const verified = await repository.verifyBackup(local.raw, passphrase);
      const migration = migrateForUse(verified.state);
      // create() is still insert-if-absent at the hosted boundary, so a second
      // device winning this race produces a conflict rather than an overwrite.
      const created = await repository.create(migration.state, passphrase, options.coordination);
      return {...created, state:migration.state, migration, preservedLocalRecovery:true};
    },
    exportLocalEncryptedRecovery() {
      const local = repository.readLocalV1Record();
      if (!local) throw new Error('No encrypted local recovery vault was found in this browser.');
      return local.raw;
    },
    async create(passphrase, initialState = seed, options = {}) {
      const migration = migrateForUse(initialState);
      const created = await repository.create(migration.state, passphrase, options.coordination);
      return {...created, state:migration.state, migration};
    },
    async unlock(passphrase) {
      const unlocked = await repository.unlock(passphrase);
      const migration = migrateForUse(unlocked.state);
      let meta = unlocked.meta;
      let vaultGeneration = unlocked.vaultGeneration;
      if (unlocked.needsVaultMigration || migration.changed || !sameState(unlocked.state, migration.state)) {
        const saved = await repository.save(migration.state, unlocked.key, unlocked.meta, {
          expectedVaultGeneration:unlocked.vaultGeneration,
          ...unlocked.coordination
        });
        meta = saved.meta;
        vaultGeneration = saved.vaultGeneration;
      }
      return {...unlocked, state:migration.state, meta, vaultGeneration, migration};
    },
    async save(state, key, meta, {expectedVaultGeneration = meta?.vaultGeneration, coordination} = {}) {
      const migration = migrateForUse(state);
      const saved = await repository.save(migration.state, key, meta, {expectedVaultGeneration, ...coordination});
      return {...saved, state:migration.state, migration};
    },
    async applyIngestionBatch(state, key, meta, batch, {
      expectedVaultGeneration = meta?.vaultGeneration,
      coordination = {},
      idFactory,
      now
    } = {}) {
      const migration = migrateForUse(state);
      const applied = await applyMutationBatchAtomically(
        migration.state,
        batch,
        nextState => repository.save(nextState, key, meta, {expectedVaultGeneration, ...coordination}),
        {idFactory, now}
      );
      if (!applied.changed) {
        return {
          state:applied.state,
          result:applied.result,
          migration,
          meta,
          vaultGeneration:expectedVaultGeneration
        };
      }
      return {
        ...applied.persistence,
        state:applied.state,
        result:applied.result,
        migration
      };
    },
    async changePassphrase(state, currentPassphrase, nextPassphrase, {expectedVaultGeneration, coordination} = {}) {
      const migration = migrateForUse(state);
      const expected = expectedVaultGeneration ?? await repository.readVaultGeneration();
      const changed = await repository.changePassphrase(migration.state, currentPassphrase, nextPassphrase, {
        expectedVaultGeneration:expected,
        ...coordination
      });
      return {...changed, state:migration.state, migration};
    },
    async exportEncryptedBackup() {
      return repository.exportEncryptedBackup();
    },
    async restore(raw, passphrase, {expectedVaultGeneration, coordination} = {}) {
      const expected = expectedVaultGeneration ?? await repository.readVaultGeneration();
      const verified = await repository.verifyBackup(raw, passphrase);
      const migration = migrateForUse(verified.state);
      const current = await repository.readVaultMetadata();
      const nextVaultSequence = current?.vaultSequence == null ? undefined : current.vaultSequence + 1;
      // save() writes the V2 vault only after decryption and migration validation have both succeeded.
      const saved = await repository.save(migration.state, verified.key, verified.meta, {
        expectedVaultGeneration:expected,
        nextVaultSequence,
        ...coordination
      });
      return {...verified, ...saved, state:migration.state, migration};
    },
    clearCurrentVault() {
      return repository.clearCurrentVault();
    }
  };
}
