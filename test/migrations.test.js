import assert from 'node:assert/strict';
import test from 'node:test';
import {STATE_SCHEMA_VERSION} from '../js/domain/constants.js';
import {migrateState, validateFoundationDomain} from '../js/domain/migrations.js';
import {legacyV1State} from './helpers.js';

test('V1 state migrates without mutating the source and produces legacy snapshots', () => {
  const source = legacyV1State();
  const before = structuredClone(source);
  const result = migrateState(source, {now:'2026-07-31T00:00:00.000Z'});

  assert.deepEqual(source, before);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, STATE_SCHEMA_VERSION);
  assert.equal(result.state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(result.state.app.name, 'Money Moves');
  assert.deepEqual(result.applied, ['v1-preserve-legacy-state', 'v2-foundation-domain-store', 'v2-foundation-canonical-name', 'v2a-bucket-explorer-fields', 'v2a-transaction-allocations', 'v2a-reimbursement-relationship-foundation', 'v2b-desktop-beta-bucket-workflow', 'v2c-faith-money-devotional-state', 'v3a-provider-neutral-ingestion']);
  assert.equal(result.state.domain.accounts[0].id, 'unknown-account');
  assert.equal(result.state.domain.buckets.length, 5);
  assert.equal(result.state.domain.devotionalState.activeDevotionalId, 'faith-money-mammon');
  assert.equal(result.state.domain.legacyMonthlySnapshots[0].bucketActualsCents.groceries, 12550);
  assert.equal(result.state.domain.legacyBalanceSnapshots[0].label.includes('not normalized account history'), true);
  assert.equal(validateFoundationDomain(result.state.domain).ok, true);
});

test('migrations are idempotent after reaching the current schema', () => {
  const once = migrateState(legacyV1State(), {now:'2026-07-31T00:00:00.000Z'}).state;
  const twice = migrateState(once, {now:'2026-07-31T00:00:00.000Z'});

  assert.deepEqual(twice.applied, []);
  assert.deepEqual(twice.state, once);
});

test('migrations use deterministic timestamps when no clock is supplied', () => {
  const source = {schemaVersion:1, categories:[{id:'legacy', name:'Legacy', group:'Needs', target:1}]};
  const first = migrateState(source).state;
  const second = migrateState(source).state;

  assert.deepEqual(first, second);
  assert.equal(first.domain.accounts[0].createdAt, '1970-01-01T00:00:00.000Z');
});

test('an invalid existing domain state is rejected before migration can rewrite it', () => {
  const source = migrateState(legacyV1State(), {now:'2026-07-31T00:00:00.000Z'}).state;
  source.domain.transactions.push({
    id:'invalid-transaction', accountId:'missing-account', source:'migration', sourceTransactionId:null,
    rawName:'Invalid', merchantName:null, amountCents:-1, currency:'USD', authorizedAt:null,
    postedAt:null, displayDate:null, pendingStatus:'posted', movementType:'expense', reviewStatus:'pending',
    locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null,
    createdAt:'2026-07-31T00:00:00.000Z', updatedAt:'2026-07-31T00:00:00.000Z'
  });
  const before = structuredClone(source);

  assert.throws(() => migrateState(source, {now:'2026-07-31T00:00:00.000Z'}), /Pre-migration state failed foundation validation/);
  assert.deepEqual(source, before);
});

test('a newer state schema is rejected before it can be downgraded', () => {
  const future = legacyV1State();
  future.schemaVersion = STATE_SCHEMA_VERSION + 1;
  assert.throws(() => migrateState(future), /newer than supported schema/);
});
