import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test, {beforeEach} from 'node:test';
import {SYSTEM_BUCKET_IDS} from '../js/domain/constants.js';
import {migrateState} from '../js/domain/migrations.js';
import {validateAllocation} from '../js/domain/models.js';
import {
  addAllocationDraftRow, allocationTotals, createAllocationDraft, deterministicAllocationId,
  parseCurrencyToCents, saveAllocationDraft, transactionAllocationSummary, validateAllocationDraft
} from '../js/services/allocationService.js';
import {archiveBucket, createBucket, queryBucketDetail} from '../js/services/bucketService.js';
import {createStateService} from '../js/services/stateService.js';
import {createVaultRepository} from '../js/services/vaultRepository.js';
import {monthSummary} from '../js/state.js';
import {installBrowserGlobals} from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/v1-buckets.json', import.meta.url), 'utf8'));
const now = '2026-07-31T12:00:00.000Z';
const migrated = () => migrateState(fixture, {now}).state;

beforeEach(() => installBrowserGlobals());

function row(id, bucketId, amountCents, overrides = {}) {
  return {id, bucketId, subBucketId:null, amountCents, ownershipType:'mine', note:'', createdAt:null, ...overrides};
}

test('allocation model and currency parsing enforce positive integer cents and Phase 2 ownership', () => {
  const valid = {
    id:'allocation-1', transactionId:'transaction-1', bucketId:'food', subBucketId:null,
    amountCents:1250, ownershipType:'mine', note:null, reimbursementClaimId:null, createdAt:now, updatedAt:now
  };
  assert.equal(validateAllocation(valid).ok, true);
  assert.equal(validateAllocation({...valid, ownershipType:'reimbursable'}).ok, true);
  assert.equal(validateAllocation({...valid, amountCents:12.5}).ok, false);
  assert.equal(validateAllocation({...valid, amountCents:0}).ok, false);
  assert.equal(validateAllocation({...valid, amountCents:-1}).ok, false);
  assert.equal(parseCurrencyToCents('12.50'), 1250);
  assert.equal(parseCurrencyToCents('$1,234.56'), 123456);
  assert.equal(parseCurrencyToCents('12.345'), null);
  assert.equal(parseCurrencyToCents('-1.00'), null);
});

test('schema 6 deterministically migrates one safe legacy assignment and leaves aggregates alone', () => {
  const source = structuredClone(fixture);
  const before = structuredClone(source);
  const first = migrateState(source, {now});
  const second = migrateState(first.state, {now});
  const allocation = first.state.domain.allocations.find(item => item.transactionId === 'legacy-food-1');

  assert.deepEqual(source, before);
  assert.equal(allocation.id, deterministicAllocationId('legacy-food-1', 'food', null));
  assert.equal(allocation.amountCents, 1234);
  assert.equal(allocation.ownershipType, 'mine');
  assert.equal(first.state.domain.transactions.find(item => item.id === 'legacy-food-1').amountCents, -1234);
  assert.equal(first.state.domain.allocations.some(item => item.transactionId.includes('legacy-monthly-snapshot')), false);
  assert.equal(first.state.domain.legacyMonthlySnapshots[0].bucketActualsCents.travel, 4500);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
});

test('schema 6 preserves ambiguous legacy assignments and records why they were not allocated', () => {
  const source = structuredClone(fixture);
  source.review.transactions[0].bucketId = 'missing-bucket';
  source.review.transactions.push({...source.review.transactions[0]});
  const result = migrateState(source, {now}).state;

  assert.equal(result.domain.allocations.some(item => item.transactionId === 'legacy-food-1'), false);
  assert.equal(result.review.transactions.filter(item => item.id === 'legacy-food-1').length, 2);
  assert.equal(result.legacyV1.unresolvedAllocationMigrations.some(item => item.reason === 'duplicate_transaction_id'), true);
});

test('schema 6 preserves an existing valid child assignment and normalizes legacy personal ownership', () => {
  const state = migrated();
  createBucket(state, {parentId:'food', name:'Dining'}, {id:'food-dining', now});
  const legacy = state.review.transactions.find(item => item.id === 'legacy-food-1');
  legacy.bucketId = 'food-dining';
  state.domain.allocations = [];
  state.domain.transactions = [];
  state.schemaVersion = 5;
  state.migration.appliedMigrations = state.migration.appliedMigrations.filter(id => id !== 'v2a-transaction-allocations');
  const result = migrateState(state, {now}).state;
  const allocation = result.domain.allocations[0];
  assert.equal(allocation.bucketId, 'food');
  assert.equal(allocation.subBucketId, 'food-dining');
  assert.equal(allocation.ownershipType, 'mine');
});

test('draft validation blocks under, over, zero, missing bucket, and invalid parent-child combinations', () => {
  const state = migrated();
  createBucket(state, {parentId:'food', name:'Dining'}, {id:'food-dining', now});
  createBucket(state, {parentId:'travel', name:'Flights'}, {id:'travel-flights', now});
  const transactionId = 'legacy-food-1';

  assert.match(validateAllocationDraft(state, transactionId, [row('a', 'food', 1000)]).errors.join(' '), /\$2\.34 remains/);
  assert.match(validateAllocationDraft(state, transactionId, [row('a', 'food', 1400)]).errors.join(' '), /exceed.*\$1\.66/i);
  assert.equal(validateAllocationDraft(state, transactionId, [row('a', 'food', 0)]).ok, false);
  assert.match(validateAllocationDraft(state, transactionId, [row('a', '', 1234)]).errors.join(' '), /Choose a bucket/);
  assert.match(validateAllocationDraft(state, transactionId, [row('a', 'food', 1234, {subBucketId:'travel-flights'})]).errors.join(' '), /must belong/);
  assert.equal(validateAllocationDraft(state, transactionId, [row('same', 'food', 600), row('same', 'travel', 634)]).ok, false);
  assert.match(validateAllocationDraft(state, transactionId, null).errors.join(' '), /Add at least one allocation/);
});

test('draft edits are isolated until save and adding a row defaults to the exact remainder', () => {
  const state = migrated();
  const before = structuredClone(state);
  const draft = createAllocationDraft(state, 'legacy-food-1', {idFactory:()=>'new-id'});
  draft.rows[0].amountCents = 700;
  addAllocationDraftRow(draft, {idFactory:()=>'second-id'});
  assert.equal(draft.rows[1].amountCents, 534);
  draft.rows[1].bucketId = 'travel';
  assert.equal(validateAllocationDraft(state, draft.transactionId, draft.rows).ok, true);
  assert.deepEqual(state, before);
});

test('saving two and three allocations keeps retained IDs, removes only allocations, and calculates ownership totals', async () => {
  const state = migrated();
  createBucket(state, {parentId:'food', name:'Dining'}, {id:'food-dining', now});
  const transactionId = 'legacy-food-1';
  const originalId = state.domain.allocations.find(item => item.transactionId === transactionId).id;
  const providerCategoryBefore = state.domain.transactions.find(item=>item.id===transactionId).providerCategory;
  const legacyProviderCategoryBefore = state.review.transactions.find(item=>item.id===transactionId).providerCategory;
  const two = [
    row(originalId, 'food', 700, {subBucketId:'food-dining'}),
    row('allocation-travel', 'travel', 534, {ownershipType:'reimbursable', note:'Expected from others'})
  ];
  await saveAllocationDraft(state, transactionId, two, async()=>{}, {now});
  assert.equal(state.stateRevision, 1);
  assert.deepEqual(allocationTotals(state.domain.allocations.filter(item=>item.transactionId===transactionId)), {
    grossCents:1234, mineCents:700, reimbursableCents:534
  });
  assert.equal(queryBucketDetail(state, 'food-dining').rolledUpCents, 700);
  assert.equal(queryBucketDetail(state, 'travel').rolledUpCents, 534);
  assert.equal(monthSummary(state, '2026-07').spend, 12.34);
  assert.equal(monthSummary(state, '2026-07').actuals.food, 7);
  assert.equal(monthSummary(state, '2026-07').actuals['food-dining'], 7);
  assert.equal(monthSummary(state, '2026-07').actuals.travel, 5.34);
  assert.equal(transactionAllocationSummary(state, transactionId).status, 'split');
  assert.equal(state.domain.transactions.find(item=>item.id===transactionId).providerCategory, providerCategoryBefore);
  assert.equal(state.review.transactions.find(item=>item.id===transactionId).providerCategory, legacyProviderCategoryBefore);

  const three = [...two.map(item=>structuredClone(item)), row('allocation-third', 'food', 100)];
  three[0].amountCents = 600;
  three[1].amountCents = 534;
  await saveAllocationDraft(state, transactionId, three, async()=>{}, {now});
  assert.equal(state.stateRevision, 2);
  assert.equal(state.domain.allocations.filter(item=>item.transactionId===transactionId).length, 3);
  assert.equal(state.domain.allocations.some(item=>item.id===originalId), true);

  await saveAllocationDraft(state, transactionId, [row(originalId, 'food', 1234)], async()=>{}, {now});
  assert.equal(state.stateRevision, 3);
  assert.equal(state.domain.allocations.filter(item=>item.transactionId===transactionId).length, 1);
  assert.equal(state.domain.transactions.some(item=>item.id===transactionId), true);
  assert.equal(state.review.transactions.find(item=>item.id===transactionId).bucketId, 'food');
});

test('archived historical assignments remain editable in place but cannot be selected for a new row', async () => {
  const state = migrated();
  archiveBucket(state, 'food', {now});
  const draft = createAllocationDraft(state, 'legacy-food-1');
  draft.rows[0].note = 'Historical note';
  assert.equal(validateAllocationDraft(state, draft.transactionId, draft.rows).ok, true);
  await saveAllocationDraft(state, draft.transactionId, draft.rows, async()=>{}, {now});
  const added = [...draft.rows, row('new-archived', 'food', 100)];
  added[0].amountCents -= 100;
  assert.match(validateAllocationDraft(state, draft.transactionId, added).errors.join(' '), /active parent/);
  assert.equal(queryBucketDetail(state, 'food').rolledUpCents, 1234);
});

test('failed persistence restores allocations, compatibility state, totals, and the prior encrypted vault', async () => {
  const passphrase = 'allocation rollback passphrase';
  const service = createStateService({repository:createVaultRepository(), seed:fixture});
  const created = await service.create(passphrase, fixture);
  const state = created.state;
  const before = structuredClone(state);
  const original = state.domain.allocations.find(item=>item.transactionId==='legacy-food-1');
  const split = [row(original.id, 'food', 700), row('rollback-second', 'travel', 534)];

  await assert.rejects(() => saveAllocationDraft(state, 'legacy-food-1', split, async()=>{throw new Error('simulated allocation save failure');}, {now}), /simulated/);
  assert.deepEqual(state, before);
  const unlocked = await service.unlock(passphrase);
  assert.deepEqual(unlocked.state, before);
});

test('balanced splits survive encrypted save/reload and merchant rules do not overwrite them', async () => {
  const passphrase = 'allocation persistence passphrase';
  const service = createStateService({repository:createVaultRepository(), seed:fixture});
  const created = await service.create(passphrase, fixture);
  const state = created.state;
  const original = state.domain.allocations.find(item=>item.transactionId==='legacy-food-1');
  const split = [row(original.id, 'food', 700), row('persist-second', 'travel', 534, {ownershipType:'reimbursable'})];
  await saveAllocationDraft(state, 'legacy-food-1', split, async()=>{}, {now, markReviewed:true});
  state.review.merchantRules[0].bucketId = 'old';
  await service.save(state, created.key, created.meta);
  const unlocked = await service.unlock(passphrase);
  assert.deepEqual(unlocked.state.domain.allocations.filter(item=>item.transactionId==='legacy-food-1').map(item=>item.amountCents), [700,534]);
  assert.equal(transactionAllocationSummary(unlocked.state, 'legacy-food-1').reimbursableCents, 534);
  assert.equal(queryBucketDetail(unlocked.state, 'food').rolledUpCents, 700);
  assert.equal(queryBucketDetail(unlocked.state, 'travel').rolledUpCents, 534);
});

test('unassigned transactions remain empty and inflows use positive allocation magnitudes against signed source facts', async () => {
  const state = migrated();
  assert.equal(transactionAllocationSummary(state, 'legacy-unassigned').status, 'unassigned');
  const inflow = {
    id:'inflow-1', accountId:'unknown-account', source:'manual', sourceTransactionId:null, rawName:'Inflow', merchantName:'Inflow',
    amountCents:2500, currency:'USD', authorizedAt:null, postedAt:'2026-07-31', displayDate:'2026-07-31', pendingStatus:'posted',
    movementType:'other_inflow', reviewStatus:'pending', locationRegion:null, locationCountry:null, locationSource:null,
    providerCategory:null, manualOverrides:null, createdAt:now, updatedAt:now
  };
  state.domain.transactions.push(inflow);
  await saveAllocationDraft(state, inflow.id, [row('inflow-allocation', 'travel', 2500)], async()=>{}, {now});
  assert.equal(state.domain.transactions.find(item=>item.id===inflow.id).amountCents, 2500);
  assert.equal(state.domain.allocations.find(item=>item.transactionId===inflow.id).amountCents, 2500);
});

test('system classifications never rewrite canonical signed source cents', async () => {
  for (const amountCents of [1250, -1250]) {
    for (const bucketId of [...Object.values(SYSTEM_BUCKET_IDS), 'food']) {
      const state = migrated();
      const transaction = {
        id:`source-${amountCents}-${bucketId}`,
        accountId:'unknown-account', source:'csv', sourceTransactionId:`external-${amountCents}-${bucketId}`,
        rawName:'Source movement', merchantName:'Source movement', amountCents, currency:'USD', authorizedAt:null,
        postedAt:'2026-07-31', displayDate:'2026-07-31', pendingStatus:'posted', movementType:'unclassified',
        reviewStatus:'pending', locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null,
        manualOverrides:null, createdAt:now, updatedAt:now
      };
      state.domain.transactions.push(transaction);
      await saveAllocationDraft(
        state,
        transaction.id,
        [row(`allocation-${amountCents}-${bucketId}`, bucketId, 1250)],
        async()=>{},
        {now, markReviewed:true}
      );
      assert.equal(state.domain.transactions.find(item => item.id === transaction.id).amountCents, amountCents);
    }
  }
});

test('reimbursement and refund interpretation with allocation/review changes preserves source cents', async () => {
  for (const amountCents of [1250, -1250]) {
    for (const movementType of ['reimbursement', 'merchant_refund']) {
      const state = migrated();
      const transaction = {
        id:`interpreted-${amountCents}-${movementType}`,
        accountId:'unknown-account', source:'csv', sourceTransactionId:`external-${amountCents}-${movementType}`,
        rawName:'Interpreted movement', merchantName:'Interpreted movement', amountCents, currency:'USD', authorizedAt:null,
        postedAt:'2026-07-31', displayDate:'2026-07-31', pendingStatus:'posted', movementType,
        reviewStatus:'pending', locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null,
        manualOverrides:null, createdAt:now, updatedAt:now
      };
      state.domain.transactions.push(transaction);
      await saveAllocationDraft(
        state,
        transaction.id,
        [row(`interpreted-allocation-${amountCents}-${movementType}`, 'food', 1250, {ownershipType:'reimbursable'})],
        async()=>{},
        {now, markReviewed:true}
      );
      assert.equal(state.domain.transactions.find(item => item.id === transaction.id).amountCents, amountCents);
      assert.equal(state.domain.transactions.find(item => item.id === transaction.id).reviewStatus, 'reviewed');
    }
  }
});
