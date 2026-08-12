import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test, {beforeEach} from 'node:test';
import {createCsvMutationBatch} from '../js/adapters/csvIngestionAdapter.js';
import {createFixtureMutationBatch} from '../js/adapters/fixtureIngestionAdapter.js';
import {createManualMutationBatch} from '../js/adapters/manualIngestionAdapter.js';
import {STATE_SCHEMA_VERSION, SYSTEM_BUCKET_IDS} from '../js/domain/constants.js';
import {ExactMoneyError, parseExactUsdAmount} from '../js/domain/exactMoney.js';
import {
  computeBatchDigest, computeLegacyEnvelopeDigest, finalizeMutationBatch, validateSourceMutationBatch
} from '../js/domain/ingestionContract.js';
import {migrateState, validateFoundationDomain} from '../js/domain/migrations.js';
import {validateDomainStore} from '../js/domain/models.js';
import {queryBucketDetail} from '../js/services/bucketService.js';
import {saveAllocationDraft} from '../js/services/allocationService.js';
import {applyMutationBatchAtomically, reconcileMutationBatch} from '../js/services/ingestionService.js';
import {createStateService} from '../js/services/stateService.js';
import {createVaultRepository} from '../js/services/vaultRepository.js';
import {installBrowserGlobals} from './helpers.js';
import {fixtureAccountMutation, fixtureTransactionMutation, V3A_NOW} from './fixtures/v3a-ingestion.js';

let idFactorySequence = 0;
beforeEach(() => {
  installBrowserGlobals();
  idFactorySequence = 0;
});

function freshState() {
  return migrateState({
    schemaVersion:1,
    preferences:{monthlyIncome:0},
    monthly:{selectedMonth:'2026-08', activeMonth:'2026-08'},
    review:{buckets:[], transactions:[], merchantRules:[], importSettings:{}},
    providerSnapshot:{asOf:null, accounts:[], recurring:[]},
    travel:{visited:[], destinations:[]},
    scriptures:[]
  }, {now:V3A_NOW}).state;
}

function ids() {
  const factoryId = ++idFactorySequence;
  let sequence = 0;
  return prefix => `${prefix}-test-${factoryId}-${++sequence}`;
}

async function fixtureBatch({
  batchId = 'fixture-batch-1',
  sourceNamespace = 'fixture:connection-1',
  accountMutations = [fixtureAccountMutation()],
  transactionMutations = [fixtureTransactionMutation()],
  quarantinedRecords = []
} = {}) {
  return createFixtureMutationBatch({
    batchId,
    sourceNamespace,
    producedAt:V3A_NOW,
    accountMutations,
    transactionMutations,
    quarantinedRecords
  });
}

async function seededFixtureState(options = {}) {
  const state = freshState();
  const applied = await reconcileMutationBatch(state, await fixtureBatch(options), {idFactory:ids(), now:V3A_NOW});
  return applied.state;
}

function onlyFixtureTransaction(state) {
  return state.domain.transactions.find(item => item.sourceKind === 'provider');
}

function addAllocation(state, transaction, amountCents = Math.abs(transaction.amountCents)) {
  const bucket = state.domain.buckets.find(item => !item.system && item.parentId === null);
  const allocation = {
    id:`allocation-${transaction.id}`,
    transactionId:transaction.id,
    bucketId:bucket.id,
    subBucketId:null,
    amountCents,
    ownershipType:'mine',
    note:'User-authored allocation note',
    reimbursementClaimId:null,
    status:'active',
    supersededByConflictId:null,
    createdAt:V3A_NOW,
    updatedAt:V3A_NOW
  };
  state.domain.allocations.push(allocation);
  return {allocation, bucket};
}

async function convertReceiptToCandidate1(state, batch) {
  const receipt = state.domain.ingestionReceipts.find(item => item.batchId === batch.batchId);
  const legacyDigest = await computeLegacyEnvelopeDigest(batch);
  receipt.id = `ingestion-receipt-${legacyDigest.slice(0, 20)}`;
  receipt.payloadDigest = legacyDigest;
  receipt.result.payloadDigest = legacyDigest;
  receipt.result.receipt.payloadDigest = legacyDigest;
  return receipt;
}

async function appliedCandidate1Csv({csv, profile, producedAt = V3A_NOW}) {
  const original = await createCsvMutationBatch({csvText:csv, producedAt, profile});
  const applied = await reconcileMutationBatch(freshState(), original, {idFactory:ids(), now:producedAt});
  const receipt = await convertReceiptToCandidate1(applied.state, original);
  return {original, state:applied.state, receipt};
}

async function followupCsvBatch(original, {batchId, producedAt, transactionMutations}) {
  const batch = structuredClone(original);
  Object.assign(batch, {
    batchId,
    producedAt,
    observation:{startedAt:producedAt, completedAt:producedAt, environment:'local', requestRef:null},
    accountMutations:[],
    transactionMutations,
    quarantinedRecords:[],
    sourceWarnings:[],
    payloadDigest:''
  });
  return finalizeMutationBatch(batch);
}

function toSchema9(state) {
  const legacy = structuredClone(state);
  legacy.schemaVersion = 9;
  legacy.migration.appliedMigrations = legacy.migration.appliedMigrations.filter(id => id !== 'v3a-provider-neutral-ingestion');
  for (const field of ['ingestionReceipts', 'sourceQuarantines', 'sourceTombstones', 'interpretationConflicts', 'sourceAuditEvents']) delete legacy.domain[field];
  for (const account of legacy.domain.accounts) for (const field of [
    'sourceKind', 'sourceNamespace', 'sourceAccountRef', 'connectionId', 'institutionName', 'providerDisplayName',
    'enabled', 'hidden', 'sourceStatus', 'connectionStatus', 'sourceMetadata', 'balances', 'sourceObservedAt'
  ]) delete account[field];
  for (const transaction of legacy.domain.transactions) for (const field of [
    'sourceKind', 'sourceNamespace', 'sourceRecordRef', 'sourceAccountRef', 'sourceLifecycle', 'sourceAmount',
    'sourceDate', 'authorizedDate', 'sourceAuthorizedAt', 'postedDate', 'sourcePostedAt', 'rawDescription', 'displayDescription', 'providerCategoryMetadata',
    'sourceProvenance', 'sourceRefAliases', 'predecessorTransactionId', 'tombstone', 'interpretationConflictId', 'sourceHistory'
  ]) delete transaction[field];
  for (const allocation of legacy.domain.allocations) {
    delete allocation.status;
    delete allocation.supersededByConflictId;
  }
  return legacy;
}

test('exact money parsing covers zero, signs, cents, safe maximum, overflow, precision, malformed input, and negative zero', () => {
  assert.equal(parseExactUsdAmount('0').amountCents, 0);
  assert.equal(parseExactUsdAmount('+12.3').amountCents, 1230);
  assert.equal(parseExactUsdAmount('-12.34').amountCents, -1234);
  assert.equal(parseExactUsdAmount('90071992547409.91').amountCents, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.is(parseExactUsdAmount('-0.00').amountCents, -0), false);
  for (const [value, code] of [
    ['90071992547409.92', 'UNSAFE_AMOUNT'],
    ['12.345', 'INVALID_DECIMAL'],
    ['1e3', 'INVALID_DECIMAL'],
    ['NaN', 'INVALID_DECIMAL'],
    ['1,000.00', 'INVALID_DECIMAL']
  ]) assert.throws(() => parseExactUsdAmount(value), error => error instanceof ExactMoneyError && error.code === code);
});

test('every supported source sign mapping produces Money Moves positive-inflow and negative-outflow cents', () => {
  assert.equal(parseExactUsdAmount('12.50', {signConvention:'positive_outflow'}).amountCents, -1250);
  assert.equal(parseExactUsdAmount('-12.50', {signConvention:'positive_outflow'}).amountCents, 1250);
  assert.equal(parseExactUsdAmount('12.50', {signConvention:'positive_inflow'}).amountCents, 1250);
  assert.equal(parseExactUsdAmount('-12.50', {signConvention:'money_moves_signed'}).amountCents, -1250);
  assert.equal(parseExactUsdAmount('12.50', {signConvention:'debit_credit', direction:'debit'}).amountCents, -1250);
  assert.equal(parseExactUsdAmount('12.50', {signConvention:'debit_credit', direction:'credit'}).amountCents, 1250);
});

test('manual adapter emits active USD records and deterministic unsafe, missing, invalid, and non-USD quarantine evidence', async () => {
  const batch = await createManualMutationBatch({
    batchId:'manual-currency-matrix',
    producedAt:V3A_NOW,
    accounts:[{sourceAccountRef:'manual-account', account:{officialName:'Cash', currency:'USD', type:'cash'}}],
    transactions:[
      {sourceRecordRef:'usd-in', sourceAccountRef:'manual-account', amountDecimal:'10.25', currency:'USD', direction:'inflow', sourceDate:'2026-08-01'},
      {sourceRecordRef:'usd-out', sourceAccountRef:'manual-account', amountDecimal:'4.50', currency:'USD', direction:'outflow', sourceDate:'2026-08-02'},
      {sourceRecordRef:'zero', sourceAccountRef:'manual-account', amountDecimal:'0', currency:'USD', direction:'outflow', sourceDate:'2026-08-03'},
      {sourceRecordRef:'bad', sourceAccountRef:'manual-account', amountDecimal:'4.501', currency:'USD', direction:'outflow', sourceDate:'2026-08-03'},
      {sourceRecordRef:'missing-currency', sourceAccountRef:'manual-account', amountDecimal:'4.50', direction:'outflow', sourceDate:'2026-08-03'},
      {sourceRecordRef:'invalid-currency', sourceAccountRef:'manual-account', amountDecimal:'4.50', currency:'US', direction:'outflow', sourceDate:'2026-08-03'},
      ...['EUR', 'GBP', 'JPY'].map((currency, index) => ({
        sourceRecordRef:`foreign-${currency}`, sourceAccountRef:'manual-account', amountDecimal:String(index + 1), currency,
        direction:'outflow', sourceDate:'2026-08-04'
      }))
    ]
  });
  await validateSourceMutationBatch(batch);
  assert.deepEqual(batch.transactionMutations.map(item => item.record.amountCents), [1025, -450]);
  assert.deepEqual(batch.quarantinedRecords.map(item => item.sourceCurrency), ['USD', 'USD', null, null, 'EUR', 'GBP', 'JPY']);
  assert.equal(batch.quarantinedRecords.every(item => item.rawAmountDecimal !== null), true);
  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(applied.state.domain.transactions.length, 2);
  assert.equal(applied.state.domain.sourceQuarantines.length, 7);
  assert.equal(applied.result.counts.sourceRecordsQuarantined, 7);
});

test('closed batch validation rejects unknown fields, sensitive metadata, duplicate terminal refs, invalid digest, and oversized strings without mutation', async () => {
  const valid = await fixtureBatch();
  const unknown = structuredClone(valid);
  unknown.transactionMutations[0].record.classification = 'earned_income';
  await assert.rejects(() => validateSourceMutationBatch(unknown), error => error.code === 'BATCH_VALIDATION_FAILED');

  const sensitive = structuredClone(valid);
  sensitive.transactionMutations[0].record.metadata.access_token = 'must-not-cross';
  sensitive.payloadDigest = await computeBatchDigest(sensitive);
  await assert.rejects(() => validateSourceMutationBatch(sensitive), error => error.code === 'BATCH_VALIDATION_FAILED');

  const duplicate = await fixtureBatch({
    batchId:'duplicate-ref-batch',
    transactionMutations:[fixtureTransactionMutation('same-ref'), fixtureTransactionMutation('same-ref')]
  });
  await assert.rejects(() => validateSourceMutationBatch(duplicate), error => error.code === 'BATCH_VALIDATION_FAILED');

  const badDigest = structuredClone(valid);
  badDigest.payloadDigest = '0'.repeat(64);
  await assert.rejects(() => validateSourceMutationBatch(badDigest), error => error.code === 'BATCH_VALIDATION_FAILED');

  const oversized = await fixtureBatch({
    batchId:'oversized-string-batch',
    transactionMutations:[fixtureTransactionMutation('oversized', {rawDescription:'x'.repeat(1_001)})]
  });
  await assert.rejects(() => validateSourceMutationBatch(oversized), error => error.code === 'BATCH_VALIDATION_FAILED');
});

test('a canonical add creates separate local/source identities, unclassified user meaning, minimized provenance, and a durable receipt', async () => {
  const result = await reconcileMutationBatch(freshState(), await fixtureBatch(), {idFactory:ids(), now:V3A_NOW});
  const account = result.state.domain.accounts.find(item => item.sourceKind === 'provider');
  const transaction = onlyFixtureTransaction(result.state);
  assert.notEqual(account.id, account.sourceAccountRef);
  assert.notEqual(transaction.id, transaction.sourceRecordRef);
  assert.equal(transaction.accountId, account.id);
  assert.equal(transaction.movementType, 'unclassified');
  assert.equal(transaction.reviewStatus, 'pending');
  assert.equal(result.state.domain.allocations.length, 0);
  assert.equal(transaction.providerCategoryMetadata.primary, 'FOOD');
  assert.equal(result.state.domain.ingestionReceipts.length, 1);
  assert.equal(result.state.review.transactions.some(item => item.canonicalTransactionId === transaction.id), true);
});

test('batch, transaction, account, modification, and complete replay are idempotent', async () => {
  const batch = await fixtureBatch();
  const first = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const replay = await reconcileMutationBatch(first.state, batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(replay.changed, false);
  assert.equal(replay.result.status, 'already_applied');
  assert.deepEqual(replay.state, first.state);

  const modified = await fixtureBatch({
    batchId:'modify-once',
    accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('fixture-transaction-1', {kind:'modify', rawDescription:'Updated source description', sourceRevision:'revision-2'})]
  });
  const once = await reconcileMutationBatch(first.state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const twice = await reconcileMutationBatch(once.state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.deepEqual(twice.state, once.state);
});

test('same semantic purchase facts coexist across distinct refs and across distinct namespaces', async () => {
  const firstBatch = await fixtureBatch({
    batchId:'same-purchases',
    transactionMutations:[fixtureTransactionMutation('purchase-a'), fixtureTransactionMutation('purchase-b')]
  });
  const first = await reconcileMutationBatch(freshState(), firstBatch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(first.state.domain.transactions.filter(item => item.sourceKind === 'provider').length, 2);

  const secondBatch = await fixtureBatch({batchId:'same-ref-new-namespace', sourceNamespace:'fixture:connection-2'});
  const second = await reconcileMutationBatch(first.state, secondBatch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(second.state.domain.transactions.filter(item => item.sourceRecordRef === 'fixture-transaction-1').length, 1);
  assert.equal(second.state.domain.accounts.filter(item => item.officialName === 'Fixture Checking').length, 2);
});

test('duplicate-looking account metadata remains separate when source account refs differ', async () => {
  const batch = await fixtureBatch({
    batchId:'duplicate-account-metadata',
    accountMutations:[fixtureAccountMutation('account-ref-a'), fixtureAccountMutation('account-ref-b')],
    transactionMutations:[
      fixtureTransactionMutation('account-a-transaction', {sourceAccountRef:'account-ref-a'}),
      fixtureTransactionMutation('account-b-transaction', {sourceAccountRef:'account-ref-b'})
    ]
  });
  const result = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const accounts = result.state.domain.accounts.filter(item => item.sourceKind === 'provider');
  assert.equal(accounts.length, 2);
  assert.notEqual(accounts[0].id, accounts[1].id);
  assert.deepEqual(accounts.map(item => item.sourceAccountRef).sort(), ['account-ref-a', 'account-ref-b']);
});

test('account source updates preserve friendly name, enabled, and hidden user fields; disconnect is idempotent', async () => {
  const state = await seededFixtureState();
  const account = state.domain.accounts.find(item => item.sourceKind === 'provider');
  account.friendlyName = 'My private nickname';
  account.enabled = false;
  account.hidden = true;
  const modify = await fixtureBatch({
    batchId:'account-modify',
    transactionMutations:[],
    accountMutations:[fixtureAccountMutation('fixture-account-1', {kind:'modify', account:{officialName:'Updated official name', mask:'9999'}})]
  });
  const modified = await reconcileMutationBatch(state, modify, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const updated = modified.state.domain.accounts.find(item => item.id === account.id);
  assert.equal(updated.friendlyName, 'My private nickname');
  assert.equal(updated.enabled, false);
  assert.equal(updated.hidden, true);
  assert.equal(updated.officialName, 'Updated official name');
  assert.equal(updated.mask, '9999');

  const disconnect = await fixtureBatch({
    batchId:'account-disconnect', transactionMutations:[], accountMutations:[fixtureAccountMutation('fixture-account-1', {kind:'disconnect'})]
  });
  const disconnected = await reconcileMutationBatch(modified.state, disconnect, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  assert.equal(disconnected.state.domain.accounts.find(item => item.id === account.id).sourceStatus, 'disconnected');
  assert.equal(disconnected.state.domain.accounts.find(item => item.id === account.id).enabled, false);
  const replay = await reconcileMutationBatch(disconnected.state, disconnect, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  assert.equal(replay.result.status, 'already_applied');
});

test('source description/date/category changes preserve classification, allocations, review, note, and manual overrides', async () => {
  const state = await seededFixtureState();
  const transaction = onlyFixtureTransaction(state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  transaction.userNote = 'Keep this user note';
  transaction.manualOverrides = {merchantName:'My chosen label'};
  const {allocation} = addAllocation(state, transaction);
  const modification = await fixtureBatch({
    batchId:'source-metadata-change',
    accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {
      kind:'modify', rawDescription:'Provider changed description', sourceDate:'2026-08-09', postedDate:'2026-08-09',
      sourceRevision:'revision-2', metadata:{classification:'earned_income', bucketId:'attack', reviewStatus:'reviewed', userNote:'attack'}
    })]
  });
  const result = await reconcileMutationBatch(state, modification, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const updated = onlyFixtureTransaction(result.state);
  assert.equal(updated.movementType, 'expense');
  assert.equal(updated.reviewStatus, 'reviewed');
  assert.equal(updated.userNote, 'Keep this user note');
  assert.deepEqual(updated.manualOverrides, {merchantName:'My chosen label'});
  assert.equal(result.state.domain.allocations.find(item => item.id === allocation.id).status, 'active');
  assert.equal(updated.rawDescription, 'Provider changed description');
  assert.equal(updated.sourceMetadata.bucketId, 'attack');
});

test('amount modification without allocations updates source facts without manufacturing user interpretation', async () => {
  const state = await seededFixtureState();
  const transaction = onlyFixtureTransaction(state);
  const modified = await fixtureBatch({
    batchId:'amount-no-allocation', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {kind:'modify', amountCents:-1500, decimal:'-15.00', sourceRevision:'revision-2'})]
  });
  const result = await reconcileMutationBatch(state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.equal(onlyFixtureTransaction(result.state).amountCents, -1500);
  assert.equal(onlyFixtureTransaction(result.state).interpretationConflictId, null);
  assert.equal(result.state.domain.allocations.length, 0);
});

test('classified or reviewed amount modifications without allocations require interpretation resolution', async () => {
  for (const authoredState of [
    {movementType:'expense', reviewStatus:'pending'},
    {movementType:'unclassified', reviewStatus:'reviewed'},
    {movementType:'expense', reviewStatus:'reviewed'}
  ]) {
    const state = await seededFixtureState({batchId:`authored-base-${authoredState.movementType}-${authoredState.reviewStatus}`});
    const transaction = onlyFixtureTransaction(state);
    Object.assign(transaction, authoredState);
    const modified = await fixtureBatch({
      batchId:`authored-modify-${authoredState.movementType}-${authoredState.reviewStatus}`,
      accountMutations:[],
      transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {
        kind:'modify', amountCents:-1500, decimal:'-15.00', sourceRevision:'revision-2'
      })]
    });
    const result = await reconcileMutationBatch(state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
    const updated = onlyFixtureTransaction(result.state);
    assert.equal(updated.amountCents, -1500);
    assert.equal(updated.reviewStatus, 'needs_resolution');
    assert.equal(updated.movementType, authoredState.movementType);
    assert.equal(result.state.domain.interpretationConflicts.length, 1);
    assert.equal(result.state.domain.interpretationConflicts[0].previousReviewStatus, authoredState.reviewStatus);
    assert.equal(result.state.domain.interpretationConflicts[0].previousMovementType, authoredState.movementType);
  }
});

test('notes and manual overrides make an amount modification require interpretation resolution', async () => {
  for (const authoredState of [
    {userNote:'Keep this note'},
    {manualOverrides:{merchantName:'Chosen name'}}
  ]) {
    const state = await seededFixtureState({batchId:`authored-extra-base-${Object.keys(authoredState)[0]}`});
    const transaction = onlyFixtureTransaction(state);
    Object.assign(transaction, authoredState);
    const modified = await fixtureBatch({
      batchId:`authored-extra-modify-${Object.keys(authoredState)[0]}`,
      accountMutations:[],
      transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {
        kind:'modify', amountCents:-1500, decimal:'-15.00', sourceRevision:'revision-2'
      })]
    });
    const result = await reconcileMutationBatch(state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
    const conflict = result.state.domain.interpretationConflicts[0];
    assert.equal(onlyFixtureTransaction(result.state).reviewStatus, 'needs_resolution');
    assert.deepEqual(conflict.manualOverridesSnapshot, authoredState.manualOverrides || null);
    assert.equal(conflict.userNoteSnapshot, authoredState.userNote || null);
  }
});

test('amount modification with allocations snapshots user work, supersedes active reporting, and marks explicit resolution', async () => {
  const state = await seededFixtureState();
  const transaction = onlyFixtureTransaction(state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  const {allocation, bucket} = addAllocation(state, transaction);
  const modified = await fixtureBatch({
    batchId:'amount-allocation-conflict', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {kind:'modify', amountCents:-1500, decimal:'-15.00', sourceRevision:'revision-2'})]
  });
  const result = await reconcileMutationBatch(state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const updated = onlyFixtureTransaction(result.state);
  const conflict = result.state.domain.interpretationConflicts[0];
  assert.equal(updated.amountCents, -1500);
  assert.equal(updated.reviewStatus, 'needs_resolution');
  assert.equal(updated.movementType, 'expense');
  assert.equal(conflict.allocationSnapshot[0].id, allocation.id);
  assert.equal(result.state.domain.allocations.find(item => item.id === allocation.id).status, 'superseded');
  assert.equal(queryBucketDetail(result.state, bucket.id).rolledUpCents, 0);
  assert.equal(validateDomainStore(result.state.domain).ok, true);
});

test('an amount update that still exactly matches active allocations preserves the allocation set', async () => {
  const state = await seededFixtureState();
  const transaction = onlyFixtureTransaction(state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  const {allocation} = addAllocation(state, transaction);
  const modified = await fixtureBatch({
    batchId:'same-magnitude-update', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {
      kind:'modify', rawDescription:'Different source description', sourceRevision:'revision-2'
    })]
  });
  const result = await reconcileMutationBatch(state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.equal(result.state.domain.allocations.find(item => item.id === allocation.id).status, 'active');
  assert.equal(onlyFixtureTransaction(result.state).interpretationConflictId, null);
  assert.equal(onlyFixtureTransaction(result.state).reviewStatus, 'reviewed');
});

test('a reimbursable allocation conflict preserves the claim relationship as resolution evidence and excludes it from active totals', async () => {
  const state = await seededFixtureState();
  const transaction = onlyFixtureTransaction(state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  const {allocation} = addAllocation(state, transaction);
  allocation.ownershipType = 'reimbursable';
  state.domain.reimbursementClaims.push({
    id:'claim-v3a', payerLabel:'Fixture payer', currency:'USD', dueDate:null, note:'Preserve claim',
    cancelledAt:null, cancellationReason:null, createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  state.domain.reimbursementClaimAllocations.push({
    id:'claim-allocation-v3a', claimId:'claim-v3a', allocationId:allocation.id, amountCents:allocation.amountCents,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  const modified = await fixtureBatch({
    batchId:'reimbursable-conflict', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {kind:'modify', amountCents:-1400, decimal:'-14.00', sourceRevision:'revision-2'})]
  });
  const result = await reconcileMutationBatch(state, modified, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.deepEqual(result.state.domain.interpretationConflicts[0].relatedClaimIds, ['claim-v3a']);
  assert.equal(result.state.domain.reimbursementClaimAllocations[0].allocationId, allocation.id);
  assert.equal(result.state.domain.reimbursementClaims[0].note, 'Preserve claim');
  assert.equal(validateDomainStore(result.state.domain).ok, true);
});

test('explicit pending-to-posted lineage retains local identity and allocation IDs; changed amount becomes a conflict', async () => {
  const pendingBatch = await fixtureBatch({
    batchId:'pending-add',
    transactionMutations:[fixtureTransactionMutation('pending-ref', {lifecycle:'pending', postedDate:null, amountCents:-1000, decimal:'-10.00'})]
  });
  const pendingResult = await reconcileMutationBatch(freshState(), pendingBatch, {idFactory:ids(), now:V3A_NOW});
  const pending = onlyFixtureTransaction(pendingResult.state);
  pending.movementType = 'expense';
  pending.reviewStatus = 'reviewed';
  const {allocation} = addAllocation(pendingResult.state, pending, 1000);
  const postedBatch = await fixtureBatch({
    batchId:'pending-posted',
    accountMutations:[],
    transactionMutations:[
      fixtureTransactionMutation('posted-ref', {predecessorSourceRef:'pending-ref', amountCents:-1200, decimal:'-12.00', rawDescription:'Posted with tip', sourceRevision:'revision-2'}),
      fixtureTransactionMutation('pending-ref', {kind:'remove', removalReason:'source_removed'})
    ]
  });
  const postedResult = await reconcileMutationBatch(pendingResult.state, postedBatch, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const posted = onlyFixtureTransaction(postedResult.state);
  assert.equal(posted.id, pending.id);
  assert.equal(posted.sourceRecordRef, 'posted-ref');
  assert.equal(posted.sourceRefAliases[0].sourceRecordRef, 'pending-ref');
  assert.equal(posted.sourceHistory[0].sourceRecordRef, 'pending-ref');
  assert.equal(postedResult.state.domain.allocations.find(item => item.id === allocation.id).status, 'superseded');
  assert.equal(posted.reviewStatus, 'needs_resolution');
  assert.equal(postedResult.result.counts.pendingPostedTransitions, 1);
  const replay = await reconcileMutationBatch(postedResult.state, postedBatch, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.equal(replay.result.status, 'already_applied');

  const transactionReplayBatch = await fixtureBatch({
    batchId:'pending-posted-new-batch', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('posted-ref', {
      predecessorSourceRef:'pending-ref', amountCents:-1200, decimal:'-12.00', rawDescription:'Posted with tip', sourceRevision:'revision-2'
    })]
  });
  const transactionReplay = await reconcileMutationBatch(postedResult.state, transactionReplayBatch, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  assert.equal(onlyFixtureTransaction(transactionReplay.state).id, pending.id);
  assert.equal(transactionReplay.state.domain.transactions.filter(item => item.sourceKind === 'provider').length, 1);
  assert.equal(transactionReplay.result.counts.pendingPostedTransitions, 0);
});

test('pending-to-posted amount changes require review only when meaningful interpretation exists', async () => {
  const cases = [
    {name:'clean', movementType:'unclassified', reviewStatus:'pending', expectConflict:false},
    {name:'classified', movementType:'expense', reviewStatus:'pending', expectConflict:true},
    {name:'reviewed', movementType:'unclassified', reviewStatus:'reviewed', expectConflict:true},
    {name:'classified-reviewed', movementType:'expense', reviewStatus:'reviewed', expectConflict:true}
  ];
  for (const item of cases) {
    const pendingBatch = await fixtureBatch({
      batchId:`pending-policy-${item.name}`,
      transactionMutations:[fixtureTransactionMutation(`pending-${item.name}`, {
        lifecycle:'pending', postedDate:null, amountCents:-1000, decimal:'-10.00'
      })]
    });
    const pendingResult = await reconcileMutationBatch(freshState(), pendingBatch, {idFactory:ids(), now:V3A_NOW});
    const transaction = onlyFixtureTransaction(pendingResult.state);
    transaction.movementType = item.movementType;
    transaction.reviewStatus = item.reviewStatus;
    const postedBatch = await fixtureBatch({
      batchId:`posted-policy-${item.name}`,
      accountMutations:[],
      transactionMutations:[fixtureTransactionMutation(`posted-${item.name}`, {
        predecessorSourceRef:`pending-${item.name}`, amountCents:-1200, decimal:'-12.00', sourceRevision:'revision-2'
      })]
    });
    const posted = await reconcileMutationBatch(pendingResult.state, postedBatch, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
    const updated = onlyFixtureTransaction(posted.state);
    assert.equal(Boolean(updated.interpretationConflictId), item.expectConflict, item.name);
    assert.equal(updated.reviewStatus, item.expectConflict ? 'needs_resolution' : item.reviewStatus, item.name);
    assert.equal(updated.movementType, item.movementType, item.name);
  }

  const unchangedPending = await fixtureBatch({
    batchId:'pending-policy-unchanged',
    transactionMutations:[fixtureTransactionMutation('pending-unchanged', {
      lifecycle:'pending', postedDate:null, amountCents:-1000, decimal:'-10.00'
    })]
  });
  const unchangedState = await reconcileMutationBatch(freshState(), unchangedPending, {idFactory:ids(), now:V3A_NOW});
  onlyFixtureTransaction(unchangedState.state).movementType = 'expense';
  onlyFixtureTransaction(unchangedState.state).reviewStatus = 'reviewed';
  const unchangedPosted = await fixtureBatch({
    batchId:'posted-policy-unchanged',
    accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('posted-unchanged', {
      predecessorSourceRef:'pending-unchanged', amountCents:-1000, decimal:'-10.00',
      rawDescription:'Posted description only', sourceRevision:'revision-2'
    })]
  });
  const unchanged = await reconcileMutationBatch(unchangedState.state, unchangedPosted, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.equal(onlyFixtureTransaction(unchanged.state).interpretationConflictId, null);
  assert.equal(onlyFixtureTransaction(unchanged.state).reviewStatus, 'reviewed');
  const replay = await reconcileMutationBatch(unchanged.state, unchangedPosted, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  assert.equal(replay.result.status, 'already_applied');
});

test('pending reconciliation never fuzzy-matches and rejects missing, wrong-account, and colliding predecessors', async () => {
  const state = await seededFixtureState({
    batchId:'pending-base',
    transactionMutations:[fixtureTransactionMutation('pending-real', {lifecycle:'pending', postedDate:null})]
  });
  const missing = await fixtureBatch({
    batchId:'missing-predecessor', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('posted-missing', {predecessorSourceRef:'semantic-lookalike'})]
  });
  await assert.rejects(() => reconcileMutationBatch(state, missing, {idFactory:ids()}), error => error.code === 'MISSING_PREDECESSOR');

  const wrongAccountBatch = await fixtureBatch({
    batchId:'wrong-account-predecessor',
    accountMutations:[fixtureAccountMutation('fixture-account-2')],
    transactionMutations:[fixtureTransactionMutation('posted-wrong-account', {predecessorSourceRef:'pending-real', sourceAccountRef:'fixture-account-2'})]
  });
  await assert.rejects(() => reconcileMutationBatch(state, wrongAccountBatch, {idFactory:ids()}), error => error.code === 'INVALID_PREDECESSOR_TRANSITION');
  assert.equal(onlyFixtureTransaction(state).sourceRecordRef, 'pending-real');
});

test('a posted record without explicit predecessor lineage remains independent from a semantic pending lookalike', async () => {
  const state = await seededFixtureState({
    batchId:'unmatched-pending-base',
    transactionMutations:[fixtureTransactionMutation('unmatched-pending', {lifecycle:'pending', postedDate:null})]
  });
  const posted = await fixtureBatch({
    batchId:'unmatched-posted-add', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('unmatched-posted', {rawDescription:'Fixture Market'})]
  });
  const result = await reconcileMutationBatch(state, posted, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.equal(result.state.domain.transactions.filter(item => item.sourceKind === 'provider').length, 2);
  assert.equal(result.state.domain.transactions.find(item => item.sourceRecordRef === 'unmatched-pending').sourceLifecycle, 'pending');
});

test('removal tombstones source activity, preserves authored history, survives replay, and records unknown removals', async () => {
  const state = await seededFixtureState();
  const transaction = onlyFixtureTransaction(state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  transaction.userNote = 'Do not delete';
  const {allocation, bucket} = addAllocation(state, transaction);
  const removal = await fixtureBatch({
    batchId:'remove-reviewed', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {kind:'remove', predecessorOfRef:'possible-successor'})]
  });
  const removed = await reconcileMutationBatch(state, removal, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const tombstoned = onlyFixtureTransaction(removed.state);
  assert.equal(tombstoned.sourceLifecycle, 'removed');
  assert.equal(tombstoned.userNote, 'Do not delete');
  assert.equal(removed.state.domain.allocations.find(item => item.id === allocation.id).amountCents, 1250);
  assert.equal(queryBucketDetail(removed.state, bucket.id).rolledUpCents, 0);
  assert.equal((await reconcileMutationBatch(removed.state, removal, {idFactory:ids()})).result.status, 'already_applied');

  const unknown = await fixtureBatch({
    batchId:'unknown-removal', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('never-seen', {kind:'remove'})]
  });
  const unknownResult = await reconcileMutationBatch(removed.state, unknown, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  assert.equal(unknownResult.state.domain.sourceTombstones.some(item => item.sourceRecordRef === 'never-seen'), true);
});

test('a same-key source revival reuses the local transaction and resolves only its removal conflict', async () => {
  const state = await seededFixtureState({batchId:'revival-base'});
  const transaction = onlyFixtureTransaction(state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  transaction.userNote = 'Keep this interpretation';
  const localId = transaction.id;
  const removal = await fixtureBatch({
    batchId:'revival-removal', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {kind:'remove'})]
  });
  const removed = await reconcileMutationBatch(state, removal, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const revival = await fixtureBatch({
    batchId:'revival-add', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation(transaction.sourceRecordRef, {sourceRevision:'revision-revived'})]
  });
  const revived = await reconcileMutationBatch(removed.state, revival, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  const current = onlyFixtureTransaction(revived.state);
  assert.equal(current.id, localId);
  assert.equal(current.sourceLifecycle, 'posted');
  assert.equal(current.reviewStatus, 'reviewed');
  assert.equal(current.movementType, 'expense');
  assert.equal(current.userNote, 'Keep this interpretation');
  assert.equal(current.interpretationConflictId, null);
  assert.equal(revived.state.domain.interpretationConflicts[0].status, 'resolved');
});

test('a later non-USD observation quarantines exact evidence and excludes an existing active source record without FX', async () => {
  const initial = await createManualMutationBatch({
    batchId:'manual-usd-initial', producedAt:V3A_NOW,
    accounts:[{sourceAccountRef:'manual-account', account:{officialName:'Manual cash', currency:'USD', type:'cash'}}],
    transactions:[{sourceRecordRef:'manual-record', sourceAccountRef:'manual-account', amountDecimal:'25.00', currency:'USD', direction:'outflow', sourceDate:'2026-08-10'}]
  });
  const first = await reconcileMutationBatch(freshState(), initial, {idFactory:ids(), now:V3A_NOW});
  const transaction = first.state.domain.transactions.find(item => item.sourceKind === 'manual' && item.sourceRecordRef === 'manual-record');
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  addAllocation(first.state, transaction, 2500);
  const foreign = await createManualMutationBatch({
    batchId:'manual-eur-change', producedAt:'2026-08-11T17:00:00.000Z',
    transactions:[{sourceRecordRef:'manual-record', sourceAccountRef:'manual-account', amountDecimal:'23.45', currency:'EUR', direction:'outflow', sourceDate:'2026-08-11'}]
  });
  const result = await reconcileMutationBatch(first.state, foreign, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  assert.equal(result.state.domain.sourceQuarantines[0].rawAmountDecimal, '23.45');
  assert.equal(result.state.domain.sourceQuarantines[0].sourceCurrency, 'EUR');
  assert.equal(result.state.domain.transactions.find(item => item.id === transaction.id).sourceLifecycle, 'removed');
  assert.equal(result.state.domain.interpretationConflicts[0].kind, 'source_quarantined');
  assert.equal(result.state.domain.transactions.some(item => item.currency === 'EUR'), false);
});

test('CSV adapter uses exact source identities and explicit sign profiles without classifying from provider categories', async () => {
  const csv = [
    'date,description,amount,account,transaction_id,category,currency',
    '2026-08-01,Coffee,5.25,Checking,tx-a,INCOME,USD',
    '2026-08-01,Coffee,5.25,Checking,tx-b,TRANSFERS,USD',
    '2026-08-02,Travel,10.00,Checking,tx-eur,TRAVEL,EUR'
  ].join('\n');
  const batch = await createCsvMutationBatch({
    csvText:csv,
    producedAt:V3A_NOW,
    profile:{signProfile:'positive_outflow', accountMappings:{Checking:'mapped:checking'}}
  });
  assert.deepEqual(batch.transactionMutations.map(item => item.record.amountCents), [-525, -525]);
  assert.notEqual(batch.transactionMutations[0].sourceRecordRef, batch.transactionMutations[1].sourceRecordRef);
  assert.equal(batch.quarantinedRecords[0].sourceCurrency, 'EUR');
  const result = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(result.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 2);
  assert.equal(result.state.domain.transactions.filter(item => item.sourceKind === 'csv').every(item => item.movementType === 'unclassified'), true);
  assert.equal((await reconcileMutationBatch(result.state, batch, {idFactory:ids()})).result.status, 'already_applied');
});

test('CSV account identity fails closed instead of merging same-label accounts without stable IDs', async () => {
  const csv = [
    'date,description,amount,account,institution,mask,transaction_id,currency',
    '2026-08-01,Bank A purchase,5.25,Checking,Bank A,1111,tx-a,USD',
    '2026-08-02,Bank B purchase,7.50,Checking,Bank B,2222,tx-b,USD'
  ].join('\n');

  await assert.rejects(
    () => createCsvMutationBatch({
      csvText:csv,
      producedAt:V3A_NOW,
      profile:{id:'same-label-rejection-profile', signProfile:'positive_outflow'}
    }),
    error => error.code === 'CSV_ACCOUNT_IDENTITY_AMBIGUOUS'
  );
});

test('CSV account resolution hierarchy preserves explicit IDs and normalized saved mappings', async t => {
  await t.test('explicit account IDs keep same-label accounts distinct with exact assignments', async () => {
    const csv = [
      'date,description,amount,account_id,account,institution,mask,account_type,account_subtype,transaction_id,currency',
      '2026-08-01,Bank A purchase,5.25,bank-a-checking,Checking,Bank A,1111,depository,checking,shared-id,USD',
      '2026-08-02,Bank B purchase,7.50,bank-b-checking,Checking,Bank B,2222,depository,checking,shared-id,USD'
    ].join('\n');
    const batch = await createCsvMutationBatch({
      csvText:csv,
      producedAt:V3A_NOW,
      profile:{id:'explicit-account-id-profile', signProfile:'positive_outflow'}
    });
    assert.equal(batch.accountMutations.length, 2);
    assert.deepEqual(
      batch.accountMutations.map(item => item.sourceAccountRef).sort(),
      ['external:bank-a-checking', 'external:bank-b-checking']
    );
    assert.notEqual(batch.transactionMutations[0].sourceAccountRef, batch.transactionMutations[1].sourceAccountRef);

    const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
    const accounts = applied.state.domain.accounts.filter(item => item.sourceKind === 'csv');
    const transactions = applied.state.domain.transactions.filter(item => item.sourceKind === 'csv');
    assert.equal(accounts.length, 2);
    assert.equal(transactions.length, 2);
    for (const expected of [
      {ref:'external:bank-a-checking', institution:'Bank A', mask:'1111'},
      {ref:'external:bank-b-checking', institution:'Bank B', mask:'2222'}
    ]) {
      const account = accounts.find(item => item.sourceAccountRef === expected.ref);
      const transaction = transactions.find(item => item.sourceAccountRef === expected.ref);
      assert.equal(account.institutionName, expected.institution);
      assert.equal(account.mask, expected.mask);
      assert.equal(account.type, 'depository');
      assert.equal(account.subtype, 'checking');
      assert.equal(transaction.accountId, account.id);
    }
  });

  await t.test('saved mapping labels normalize case and whitespace without changing account identity', async () => {
    const profile = {
      id:'normalized-account-mapping-profile',
      signProfile:'positive_outflow',
      accountMappings:{' Checking ':'mapped:bank-a-checking'}
    };
    const firstCsv = [
      'date,description,amount,account,institution,mask,transaction_id,currency',
      '2026-08-01,Coffee,5.25,Checking,Bank A,1111,stable-transaction,USD'
    ].join('\n');
    const secondCsv = firstCsv.replace(',Checking,', ',CHECKING,');
    const firstBatch = await createCsvMutationBatch({csvText:firstCsv, producedAt:V3A_NOW, profile});
    const secondBatch = await createCsvMutationBatch({
      csvText:secondCsv,
      producedAt:'2026-08-12T16:00:00.000Z',
      profile
    });
    assert.equal(firstBatch.accountMutations[0].sourceAccountRef, 'mapped:bank-a-checking');
    assert.equal(secondBatch.accountMutations[0].sourceAccountRef, 'mapped:bank-a-checking');
    const first = await reconcileMutationBatch(freshState(), firstBatch, {idFactory:ids(), now:V3A_NOW});
    const originalAccount = first.state.domain.accounts.find(item => item.sourceKind === 'csv');
    const originalTransaction = first.state.domain.transactions.find(item => item.sourceKind === 'csv');
    const replay = await reconcileMutationBatch(first.state, secondBatch, {
      idFactory:ids(), now:'2026-08-12T16:00:00.000Z'
    });
    const account = replay.state.domain.accounts.find(item => item.sourceKind === 'csv');
    const transaction = replay.state.domain.transactions.find(item => item.sourceKind === 'csv');
    assert.equal(account.id, originalAccount.id);
    assert.equal(transaction.id, originalTransaction.id);
    assert.equal(transaction.accountId, account.id);
    assert.equal(replay.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 1);
    assert.equal(replay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 1);
  });

  await t.test('explicit stable identity accepts source metadata updates without replacing user account fields', async () => {
    const profile = {id:'explicit-metadata-update-profile', signProfile:'positive_outflow'};
    const firstCsv = [
      'date,description,amount,account_id,account,institution,mask,account_type,account_subtype,transaction_id,currency',
      '2026-08-01,Coffee,5.25,stable-account,Checking,Bank A,,depository,,stable-meta-tx,USD'
    ].join('\n');
    const secondCsv = [
      'date,description,amount,account_id,account,institution,mask,account_type,account_subtype,transaction_id,currency',
      '2026-08-01,Coffee,5.25,stable-account,CHECKING,Bank A Corrected,9999,depository,cash management,stable-meta-tx,USD'
    ].join('\n');
    const firstBatch = await createCsvMutationBatch({csvText:firstCsv, producedAt:V3A_NOW, profile});
    const first = await reconcileMutationBatch(freshState(), firstBatch, {idFactory:ids(), now:V3A_NOW});
    const firstAccount = first.state.domain.accounts.find(item => item.sourceKind === 'csv');
    firstAccount.friendlyName = 'My Primary Account';
    firstAccount.enabled = false;
    firstAccount.hidden = true;
    const secondBatch = await createCsvMutationBatch({
      csvText:secondCsv,
      producedAt:'2026-08-12T16:00:00.000Z',
      profile
    });
    const second = await reconcileMutationBatch(first.state, secondBatch, {
      idFactory:ids(), now:'2026-08-12T16:00:00.000Z'
    });
    const updated = second.state.domain.accounts.find(item => item.sourceKind === 'csv');
    assert.equal(updated.id, firstAccount.id);
    assert.equal(updated.sourceAccountRef, 'external:stable-account');
    assert.equal(updated.friendlyName, 'My Primary Account');
    assert.equal(updated.enabled, false);
    assert.equal(updated.hidden, true);
    assert.equal(updated.officialName, 'CHECKING');
    assert.equal(updated.institutionName, 'Bank A Corrected');
    assert.equal(updated.mask, '9999');
    assert.equal(updated.subtype, 'cash management');
    assert.equal(second.result.counts.accountsUpdated, 1);
    assert.equal(second.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 1);
  });

  await t.test('saved mappings reject Unknown-account and legacy label references as stable identity', async () => {
    const csv = [
      'date,description,amount,account,transaction_id,currency',
      '2026-08-01,Coffee,5.25,Checking,invalid-map-tx,USD'
    ].join('\n');
    for (const sourceAccountRef of ['unknown-account', 'label:unsafe']) {
      await assert.rejects(
        () => createCsvMutationBatch({
          csvText:csv,
          producedAt:V3A_NOW,
          profile:{
            id:`invalid-mapping-${sourceAccountRef}`,
            signProfile:'positive_outflow',
            accountMappings:{Checking:sourceAccountRef}
          }
        }),
        error => error.code === 'CSV_ACCOUNT_MAPPING_INVALID'
      );
    }
  });
});

test('ambiguous missing-ID CSV account descriptors fail closed across adversarial collisions', async t => {
  const cases = [
    {
      name:'same label, different institution and mask',
      rows:['Bank A,Checking,1111', 'Bank B,Checking,2222']
    },
    {
      name:'same institution and label, different mask',
      rows:['Bank A,Checking,1111', 'Bank A,Checking,2222']
    },
    {
      name:'same label and mask, different institution',
      rows:['Bank A,Checking,1111', 'Bank B,Checking,1111']
    },
    {
      name:'same institution and label, one missing mask',
      rows:['Bank A,Checking,1111', 'Bank A,Checking,']
    },
    {
      name:'indistinguishable descriptors without a stable mapping',
      rows:['Bank A,Checking,1111', 'Bank A,Checking,1111']
    }
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const csv = [
      'date,description,amount,institution,account,mask,transaction_id,currency',
      `2026-08-01,First,5.25,${item.rows[0]},tx-a,USD`,
      `2026-08-02,Second,7.50,${item.rows[1]},tx-b,USD`
    ].join('\n');
    await assert.rejects(
      () => createCsvMutationBatch({
        csvText:csv,
        producedAt:V3A_NOW,
        profile:{id:`ambiguous-${item.name}`, signProfile:'positive_outflow'}
      }),
      error => {
        assert.equal(error.code, 'CSV_ACCOUNT_IDENTITY_AMBIGUOUS');
        assert.equal(error.details.rowCount, 2);
        assert.deepEqual(error.details.rowNumbers, [2, 3]);
        assert.doesNotMatch(JSON.stringify(error.details), /Bank A|Bank B|1111|2222|Checking/);
        return true;
      }
    );
  });
});

test('CSV grouping rejects conflicting facts assigned to one mapping instead of choosing the first row', async () => {
  const csv = [
    'date,description,amount,institution,account,mask,transaction_id,currency',
    '2026-08-01,First,5.25,Bank A,Checking,1111,tx-a,USD',
    '2026-08-02,Second,7.50,Bank B,Savings,2222,tx-b,USD'
  ].join('\n');
  await assert.rejects(
    () => createCsvMutationBatch({
      csvText:csv,
      producedAt:V3A_NOW,
      profile:{
        id:'conflicting-group-profile',
        signProfile:'positive_outflow',
        accountMappings:{Checking:'mapped:one-account', Savings:'mapped:one-account'}
      }
    }),
    error => {
      assert.equal(error.code, 'SOURCE_ACCOUNT_IDENTITY_CONFLICT');
      assert.deepEqual(error.details.rowNumbers, [2, 3]);
      assert.doesNotMatch(JSON.stringify(error.details), /Bank A|Bank B|1111|2222|Checking|Savings/);
      return true;
    }
  );
});

test('mapped distinct accounts retain account-scoped transaction identity including fallback record refs', async () => {
  const sharedExternalIdCsv = [
    'date,description,amount,account,transaction_id,currency',
    '2026-08-01,Checking purchase,5.25,Checking,shared-external-id,USD',
    '2026-08-02,Savings purchase,7.50,Savings,shared-external-id,USD'
  ].join('\n');
  const profile = {
    id:'mapped-transaction-scope-profile',
    signProfile:'positive_outflow',
    accountMappings:{Checking:'mapped:checking', Savings:'mapped:savings'}
  };
  const externalBatch = await createCsvMutationBatch({csvText:sharedExternalIdCsv, producedAt:V3A_NOW, profile});
  assert.equal(externalBatch.transactionMutations[0].sourceRecordRef, externalBatch.transactionMutations[1].sourceRecordRef);
  assert.notEqual(externalBatch.transactionMutations[0].sourceAccountRef, externalBatch.transactionMutations[1].sourceAccountRef);
  const applied = await reconcileMutationBatch(freshState(), externalBatch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(applied.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 2);
  assert.equal(applied.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 2);

  const noExternalIdCsv = [
    'date,description,amount,account,currency',
    '2026-08-03,Fallback identity,9.25,Checking,USD'
  ].join('\n');
  const firstFallback = await createCsvMutationBatch({csvText:noExternalIdCsv, producedAt:V3A_NOW, profile});
  const laterFallback = await createCsvMutationBatch({
    csvText:noExternalIdCsv,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile
  });
  assert.match(firstFallback.transactionMutations[0].sourceRecordRef, /^file:[a-f0-9]{64}:row:2$/);
  assert.equal(firstFallback.transactionMutations[0].sourceRecordRef, laterFallback.transactionMutations[0].sourceRecordRef);
  assert.equal(firstFallback.payloadDigest, laterFallback.payloadDigest);
  const fallbackApplied = await reconcileMutationBatch(applied.state, firstFallback, {idFactory:ids(), now:V3A_NOW});
  const fallbackReplay = await reconcileMutationBatch(fallbackApplied.state, laterFallback, {
    idFactory:ids(), now:'2026-08-12T16:00:00.000Z'
  });
  assert.equal(fallbackReplay.result.status, 'already_applied');
  assert.equal(fallbackReplay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 3);
});

test('ambiguous multi-account CSV leaves the encrypted vault unchanged and succeeds after explicit mapping', async () => {
  const csv = [
    'date,description,amount,account_id,account,transaction_id,currency',
    '2026-08-01,Explicit row,5.25,explicit-checking,Checking,tx-explicit,USD',
    '2026-08-02,Needs mapping,7.50,,Savings,tx-mapped,USD'
  ].join('\n');
  const state = freshState();
  const repository = createVaultRepository();
  const service = createStateService({repository, seed:freshState()});
  const created = await service.create('correct horse battery staple', state);
  const beforeState = structuredClone(created.state);
  const beforeBackup = await service.exportEncryptedBackup();

  await assert.rejects(
    () => createCsvMutationBatch({
      csvText:csv,
      producedAt:V3A_NOW,
      profile:{id:'atomic-account-mapping-profile', signProfile:'positive_outflow'}
    }),
    error => error.code === 'CSV_ACCOUNT_IDENTITY_AMBIGUOUS'
  );
  assert.deepEqual(created.state, beforeState);
  assert.equal(await service.exportEncryptedBackup(), beforeBackup);

  const corrected = await createCsvMutationBatch({
    csvText:csv,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile:{
      id:'atomic-account-mapping-profile',
      signProfile:'positive_outflow',
      accountMappings:{Savings:'mapped:savings'}
    }
  });
  const applied = await service.applyIngestionBatch(created.state, created.key, created.meta, corrected, {
    expectedVaultGeneration:created.vaultGeneration,
    idFactory:ids(),
    now:'2026-08-12T16:00:00.000Z'
  });
  assert.equal(applied.result.counts.accountsAdded, 2);
  assert.equal(applied.result.counts.transactionsAdded, 2);
  assert.equal(applied.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 2);
  assert.equal(applied.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 2);
});

test('unreleased schema-10 label identities require remediation without reinterpretation', async () => {
  const csv = [
    'date,description,amount,account,transaction_id,currency',
    '2026-08-01,Coffee,5.25,Checking,legacy-label-tx,USD'
  ].join('\n');
  const profile = {
    id:'legacy-label-state-profile',
    signProfile:'positive_outflow',
    accountMappings:{Checking:'mapped:checking'}
  };
  const batch = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const legacyRef = 'label:0dfe1d63c9d868967e5de877';
  const account = applied.state.domain.accounts.find(item => item.sourceKind === 'csv');
  const transaction = applied.state.domain.transactions.find(item => item.sourceKind === 'csv');
  account.sourceAccountRef = legacyRef;
  account.externalAccountId = legacyRef;
  transaction.sourceAccountRef = legacyRef;
  assert.equal(validateDomainStore(applied.state.domain).ok, true);
  const before = structuredClone(applied.state);
  const corrected = await createCsvMutationBatch({
    csvText:csv,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile
  });
  await assert.rejects(
    () => reconcileMutationBatch(applied.state, corrected, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
    error => error.code === 'CSV_LEGACY_ACCOUNT_IDENTITY_UNRESOLVED'
  );
  assert.deepEqual(applied.state, before);
});

test('encrypted backup restore preserves mapped account identity and stable CSV reimport', async () => {
  const csv = [
    'date,description,amount,account,institution,mask,transaction_id,currency',
    '2026-08-01,Coffee,5.25,Checking,Bank A,1111,backup-stable-tx,USD'
  ].join('\n');
  const profile = {
    id:'backup-account-mapping-profile',
    signProfile:'positive_outflow',
    accountMappings:{Checking:'mapped:bank-a-checking'}
  };
  const batch = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  const imported = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  imported.state.review.importSettings.accountMappings = structuredClone(profile.accountMappings);
  const repository = createVaultRepository();
  const service = createStateService({repository, seed:freshState()});
  const passphrase = 'correct horse battery staple';
  const created = await service.create(passphrase, imported.state);
  const backup = await service.exportEncryptedBackup();
  const changed = structuredClone(created.state);
  changed.preferences.monthlyIncome = 123;
  const saved = await service.save(changed, created.key, created.meta, {
    expectedVaultGeneration:created.vaultGeneration
  });
  const restored = await service.restore(backup, passphrase, {expectedVaultGeneration:saved.vaultGeneration});
  const restoredAccount = restored.state.domain.accounts.find(item => item.sourceKind === 'csv');
  const restoredTransaction = restored.state.domain.transactions.find(item => item.sourceKind === 'csv');
  assert.equal(restoredAccount.sourceAccountRef, 'mapped:bank-a-checking');
  assert.equal(restoredAccount.institutionName, 'Bank A');
  assert.equal(restoredAccount.mask, '1111');
  assert.equal(restoredTransaction.sourceAccountRef, restoredAccount.sourceAccountRef);
  assert.equal(restoredTransaction.accountId, restoredAccount.id);
  assert.deepEqual(restored.state.review.importSettings.accountMappings, profile.accountMappings);

  const later = await createCsvMutationBatch({
    csvText:csv,
    producedAt:'2026-08-13T16:00:00.000Z',
    profile
  });
  const replay = await reconcileMutationBatch(restored.state, later, {
    idFactory:ids(), now:'2026-08-13T16:00:00.000Z'
  });
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 1);
  assert.equal(replay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 1);
});

test('Candidate 1 legacy receipt proof remains valid with corrected mapped account identity', async () => {
  const csv = [
    'date,description,amount,account,transaction_id,currency',
    '2026-08-01,Coffee,5.25,Checking,mapped-legacy-receipt,USD'
  ].join('\n');
  const profile = {
    id:'mapped-legacy-receipt-profile',
    signProfile:'positive_outflow',
    accountMappings:{Checking:'mapped:legacy-checking'}
  };
  const original = await appliedCandidate1Csv({csv, profile});
  assert.equal(original.original.accountMutations[0].sourceAccountRef, 'mapped:legacy-checking');
  const replayBatch = await createCsvMutationBatch({
    csvText:csv,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile
  });
  const replay = await reconcileMutationBatch(original.state, replayBatch, {
    idFactory:ids(), now:'2026-08-12T16:00:00.000Z'
  });
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.changed, false);
  assert.equal(replay.state.domain.transactions.find(item => item.sourceKind === 'csv').sourceAccountRef, 'mapped:legacy-checking');
});

test('identical CSV content and profile replay across production times without a batch collision', async () => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-a,USD'
  ].join('\n');
  const profile = {id:'replay-profile', signProfile:'positive_outflow'};
  const firstBatch = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  const laterBatch = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-12T16:00:00.000Z', profile});
  assert.equal(firstBatch.batchId, laterBatch.batchId);
  assert.equal(firstBatch.payloadDigest, laterBatch.payloadDigest);
  assert.notEqual(firstBatch.producedAt, laterBatch.producedAt);
  const first = await reconcileMutationBatch(freshState(), firstBatch, {idFactory:ids(), now:V3A_NOW});
  const replay = await reconcileMutationBatch(first.state, laterBatch, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'});
  assert.equal(replay.changed, false);
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 1);
});

test('schema-10 CSV receipts from rejected Candidate 1 replay safely and still reject changed content', async () => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-legacy-receipt,USD'
  ].join('\n');
  const profile = {id:'legacy-receipt-profile', signProfile:'positive_outflow'};
  const original = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  const applied = await reconcileMutationBatch(freshState(), original, {idFactory:ids(), now:V3A_NOW});
  const receipt = applied.state.domain.ingestionReceipts[0];
  const legacyDigest = await computeLegacyEnvelopeDigest(original);
  receipt.id = `ingestion-receipt-${legacyDigest.slice(0, 20)}`;
  receipt.payloadDigest = legacyDigest;
  receipt.result.payloadDigest = legacyDigest;
  receipt.result.receipt.payloadDigest = legacyDigest;

  const later = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-12T16:00:00.000Z', profile});
  const replay = await reconcileMutationBatch(applied.state, later, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'});
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.changed, false);

  const changed = structuredClone(later);
  changed.transactionMutations[0].record.amountCents = -600;
  changed.transactionMutations[0].record.sourceAmount.decimal = '6.00';
  changed.payloadDigest = await computeBatchDigest(changed);
  await assert.rejects(
    () => reconcileMutationBatch(applied.state, changed, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
    error => error.code === 'BATCH_ID_COLLISION'
  );
});

test('Candidate 1 legacy receipt replay fails closed when a corrupted nested result has no persisted transaction effects', async () => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-corrupt-legacy-receipt,USD'
  ].join('\n');
  const profile = {id:'corrupt-legacy-receipt-profile', signProfile:'positive_outflow'};
  const original = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  const applied = await reconcileMutationBatch(freshState(), original, {idFactory:ids(), now:V3A_NOW});
  const receipt = applied.state.domain.ingestionReceipts[0];
  const legacyDigest = await computeLegacyEnvelopeDigest(original);
  receipt.id = `ingestion-receipt-${legacyDigest.slice(0, 20)}`;
  receipt.payloadDigest = legacyDigest;
  receipt.result = {
    batchId:'wrong',
    payloadDigest:'wrong',
    status:'applied',
    counts:{transactionsAdded:999},
    receipt:{batchId:'wrong', payloadDigest:'wrong'}
  };
  applied.state.domain.transactions = applied.state.domain.transactions.filter(item => item.sourceKind !== 'csv');
  applied.state.domain.accounts = applied.state.domain.accounts.filter(item => item.sourceKind !== 'csv');
  applied.state.domain.sourceAuditEvents = [];
  assert.equal(validateDomainStore(applied.state.domain).ok, false);

  const later = await createCsvMutationBatch({
    csvText:csv,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile
  });
  await assert.rejects(
    () => reconcileMutationBatch(applied.state, later, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
    error => error.code === 'LEGACY_RECEIPT_INVALID'
  );
});

test('Candidate 1 legacy receipt structure rejects partial, contradictory, unrelated, and corrupted records', async t => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-legacy-structure,USD'
  ].join('\n');
  const profile = {id:'legacy-structure-profile', signProfile:'positive_outflow'};
  const base = await appliedCandidate1Csv({csv, profile});
  const later = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-12T16:00:00.000Z', profile});
  const wrongDigest = 'f'.repeat(64);
  const cases = [
    {name:'missing nested result', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { delete receipt.result; }},
    {name:'nested batch ID mismatch', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.batchId = 'wrong-batch'; }},
    {name:'nested payload digest mismatch', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.payloadDigest = wrongDigest; }},
    {name:'missing nested receipt reference', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { delete receipt.result.receipt.batchId; }},
    {name:'nested receipt batch mismatch', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.receipt.batchId = 'wrong-batch'; }},
    {name:'nested receipt digest mismatch', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.receipt.payloadDigest = wrongDigest; }},
    {name:'nested connection reference mismatch', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.receipt.connectionId = receipt.sourceNamespace; }},
    {name:'negative result count', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.counts.transactionsAdded = -1; }},
    {name:'impossible result count', code:'LEGACY_RECEIPT_EFFECTS_UNVERIFIED', mutate:receipt => { receipt.result.counts.transactionsAdded = 2; }},
    {name:'contradictory status and counts', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.counts.sourceRecordsQuarantined = 1; }},
    {name:'partial outer receipt', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { delete receipt.adapterKind; }},
    {name:'malformed safe error codes', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.safeErrorCodes = 'not-an-array'; }},
    {name:'unknown nested field', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.result.untrusted = true; }},
    {name:'wrong outer receipt identifier', code:'LEGACY_RECEIPT_INVALID', mutate:receipt => { receipt.id = 'wrong-receipt-id'; }},
    {name:'receipt from another namespace', code:'BATCH_ID_COLLISION', mutate:receipt => { receipt.sourceNamespace = 'csv:another-profile'; }},
    {name:'corrupted legacy observation input', code:'BATCH_ID_COLLISION', mutate:receipt => {
      receipt.createdAt = '2026-08-10T16:00:00.000Z';
      receipt.updatedAt = receipt.createdAt;
    }}
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const state = structuredClone(base.state);
    const receipt = state.domain.ingestionReceipts.find(entry => entry.batchId === base.original.batchId);
    item.mutate(receipt);
    if (item.code === 'LEGACY_RECEIPT_INVALID') assert.equal(validateDomainStore(state.domain).ok, false, item.name);
    await assert.rejects(
      () => reconcileMutationBatch(state, later, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
      error => error.code === item.code
    );
  });

  await t.test('changed replay payload retains collision detection', async () => {
    const changed = structuredClone(later);
    changed.transactionMutations[0].record.amountCents = -600;
    changed.transactionMutations[0].record.sourceAmount.decimal = '6.00';
    changed.payloadDigest = await computeBatchDigest(changed);
    await assert.rejects(
      () => reconcileMutationBatch(base.state, changed, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
      error => error.code === 'BATCH_ID_COLLISION'
    );
  });
});

test('Candidate 1 legacy receipt effect proof rejects missing, mismatched, and contradictory persisted evidence', async t => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-legacy-effects,USD'
  ].join('\n');
  const profile = {id:'legacy-effects-profile', signProfile:'positive_outflow'};
  const base = await appliedCandidate1Csv({csv, profile});
  const later = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-12T16:00:00.000Z', profile});
  const cases = [
    {name:'valid-looking receipt without effects', mutate:state => {
      state.domain.transactions = state.domain.transactions.filter(item => item.sourceKind !== 'csv');
      state.domain.accounts = state.domain.accounts.filter(item => item.sourceKind !== 'csv');
      state.domain.sourceAuditEvents = [];
    }},
    {name:'transaction effect on wrong source account', mutate:state => {
      state.domain.transactions.find(item => item.sourceKind === 'csv').sourceAccountRef = 'external:wrong-account';
    }},
    {name:'transaction effect with wrong source reference', mutate:state => {
      const transaction = state.domain.transactions.find(item => item.sourceKind === 'csv');
      transaction.sourceRecordRef = 'external:wrong-reference';
      transaction.sourceTransactionId = transaction.sourceRecordRef;
    }},
    {name:'claimed transaction add without its batch audit', mutate:state => {
      state.domain.sourceAuditEvents = state.domain.sourceAuditEvents.filter(item => item.entityType !== 'transaction');
    }},
    {name:'extra contradictory legacy mutation audit', mutate:state => {
      const transaction = state.domain.transactions.find(item => item.sourceKind === 'csv');
      state.domain.sourceAuditEvents.push({
        id:'source-audit-extra-contradiction',
        batchId:base.original.batchId,
        entityType:'transaction',
        entityId:transaction.id,
        action:'unexpected',
        changedFields:['source'],
        observedAt:V3A_NOW,
        createdAt:V3A_NOW,
        updatedAt:V3A_NOW
      });
    }}
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const state = structuredClone(base.state);
    item.mutate(state);
    assert.equal(validateDomainStore(state.domain).ok, true, item.name);
    await assert.rejects(
      () => reconcileMutationBatch(state, later, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
      error => error.code === 'LEGACY_RECEIPT_EFFECTS_UNVERIFIED'
    );
  });

  await t.test('one missing transaction from a multi-record batch', async () => {
    const multiCsv = [
      'date,description,amount,account_id,transaction_id,currency',
      '2026-08-01,Coffee,5.25,checking-1,tx-legacy-multi-a,USD',
      '2026-08-02,Lunch,8.75,checking-1,tx-legacy-multi-b,USD'
    ].join('\n');
    const multiProfile = {id:'legacy-multi-effects-profile', signProfile:'positive_outflow'};
    const multi = await appliedCandidate1Csv({csv:multiCsv, profile:multiProfile});
    const missing = multi.state.domain.transactions.find(item => item.sourceRecordRef === 'external:tx-legacy-multi-b');
    multi.state.domain.transactions = multi.state.domain.transactions.filter(item => item.id !== missing.id);
    multi.state.domain.sourceAuditEvents = multi.state.domain.sourceAuditEvents.filter(item => item.entityId !== missing.id);
    assert.equal(validateDomainStore(multi.state.domain).ok, true);
    const replay = await createCsvMutationBatch({csvText:multiCsv, producedAt:'2026-08-12T16:00:00.000Z', profile:multiProfile});
    await assert.rejects(
      () => reconcileMutationBatch(multi.state, replay, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
      error => error.code === 'LEGACY_RECEIPT_EFFECTS_UNVERIFIED'
    );
  });

  await t.test('missing quarantine evidence', async () => {
    const foreignCsv = [
      'date,description,amount,account_id,transaction_id,currency',
      '2026-08-01,Foreign purchase,5.25,checking-1,tx-legacy-foreign,EUR'
    ].join('\n');
    const foreignProfile = {id:'legacy-quarantine-effects-profile', signProfile:'positive_outflow'};
    const foreign = await appliedCandidate1Csv({csv:foreignCsv, profile:foreignProfile});
    foreign.state.domain.sourceQuarantines = [];
    foreign.state.domain.sourceAuditEvents = foreign.state.domain.sourceAuditEvents.filter(item => item.entityType !== 'quarantine');
    assert.equal(validateDomainStore(foreign.state.domain).ok, true);
    const replay = await createCsvMutationBatch({csvText:foreignCsv, producedAt:'2026-08-12T16:00:00.000Z', profile:foreignProfile});
    await assert.rejects(
      () => reconcileMutationBatch(foreign.state, replay, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
      error => error.code === 'LEGACY_RECEIPT_EFFECTS_UNVERIFIED'
    );
  });

  await t.test('empty legacy batch has no independent persisted-effect proof', async () => {
    const emptyCsv = 'date,description,amount,account_id,transaction_id,currency';
    const emptyProfile = {id:'legacy-empty-effects-profile', signProfile:'positive_outflow'};
    const empty = await appliedCandidate1Csv({csv:emptyCsv, profile:emptyProfile});
    const replay = await createCsvMutationBatch({csvText:emptyCsv, producedAt:'2026-08-12T16:00:00.000Z', profile:emptyProfile});
    await assert.rejects(
      () => reconcileMutationBatch(empty.state, replay, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
      error => error.code === 'LEGACY_RECEIPT_EFFECTS_UNVERIFIED'
    );
  });
});

test('genuine Candidate 1 effects remain provable after later source modification or tombstoning', async t => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-legacy-history,USD'
  ].join('\n');
  const profile = {id:'legacy-history-profile', signProfile:'positive_outflow'};

  await t.test('later legitimate source modification retains historical proof', async () => {
    const applied = await appliedCandidate1Csv({csv, profile});
    const originalMutation = applied.original.transactionMutations[0];
    const modifiedMutation = structuredClone(originalMutation);
    modifiedMutation.kind = 'modify';
    modifiedMutation.observedAt = '2026-08-12T12:00:00.000Z';
    modifiedMutation.record.amountCents = -600;
    modifiedMutation.record.sourceAmount.decimal = '6.00';
    modifiedMutation.record.sourceRevision = 'revision-2';
    const modification = await followupCsvBatch(applied.original, {
      batchId:'csv-history-modification',
      producedAt:modifiedMutation.observedAt,
      transactionMutations:[modifiedMutation]
    });
    const changed = await reconcileMutationBatch(applied.state, modification, {
      idFactory:ids(), now:modifiedMutation.observedAt
    });
    const replay = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-13T16:00:00.000Z', profile});
    const result = await reconcileMutationBatch(changed.state, replay, {idFactory:ids(), now:'2026-08-13T16:00:00.000Z'});
    assert.equal(result.changed, false);
    assert.equal(result.result.status, 'already_applied');
    assert.equal(result.state.domain.transactions.find(item => item.sourceKind === 'csv').amountCents, -600);
  });

  await t.test('later legitimate tombstone retains historical proof', async () => {
    const applied = await appliedCandidate1Csv({csv, profile});
    const originalMutation = applied.original.transactionMutations[0];
    const removedAt = '2026-08-12T13:00:00.000Z';
    const removal = await followupCsvBatch(applied.original, {
      batchId:'csv-history-removal',
      producedAt:removedAt,
      transactionMutations:[{
        kind:'remove',
        sourceRecordRef:originalMutation.sourceRecordRef,
        sourceAccountRef:originalMutation.sourceAccountRef,
        observedAt:removedAt,
        record:null,
        removal:{reason:'source_removed', predecessorOfRef:null}
      }]
    });
    const removed = await reconcileMutationBatch(applied.state, removal, {idFactory:ids(), now:removedAt});
    const replay = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-13T16:00:00.000Z', profile});
    const result = await reconcileMutationBatch(removed.state, replay, {idFactory:ids(), now:'2026-08-13T16:00:00.000Z'});
    assert.equal(result.changed, false);
    assert.equal(result.result.status, 'already_applied');
    assert.equal(result.state.domain.transactions.find(item => item.sourceKind === 'csv').sourceLifecycle, 'removed');
  });

  await t.test('genuine retained quarantine evidence replays safely', async () => {
    const foreignCsv = [
      'date,description,amount,account_id,transaction_id,currency',
      '2026-08-01,Foreign purchase,5.25,checking-1,tx-legacy-quarantine,EUR'
    ].join('\n');
    const foreignProfile = {id:'legacy-history-quarantine-profile', signProfile:'positive_outflow'};
    const applied = await appliedCandidate1Csv({csv:foreignCsv, profile:foreignProfile});
    const replay = await createCsvMutationBatch({
      csvText:foreignCsv,
      producedAt:'2026-08-13T16:00:00.000Z',
      profile:foreignProfile
    });
    const result = await reconcileMutationBatch(applied.state, replay, {idFactory:ids(), now:'2026-08-13T16:00:00.000Z'});
    assert.equal(result.changed, false);
    assert.equal(result.result.status, 'already_applied');
    assert.equal(result.result.counts.sourceRecordsQuarantined, 1);
  });
});

test('CSV retry after persistence failure remains deterministic across production times', async () => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Coffee,5.25,checking-1,tx-retry,USD'
  ].join('\n');
  const profile = {id:'retry-profile', signProfile:'positive_outflow'};
  const state = freshState();
  const before = structuredClone(state);
  const firstBatch = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  await assert.rejects(
    () => applyMutationBatchAtomically(state, firstBatch, async () => { throw new Error('simulated persistence failure'); }, {idFactory:ids(), now:V3A_NOW}),
    /simulated persistence failure/
  );
  assert.deepEqual(state, before);
  const retryBatch = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-12T16:00:00.000Z', profile});
  const retry = await applyMutationBatchAtomically(state, retryBatch, async () => ({ok:true}), {
    idFactory:ids(), now:'2026-08-12T16:00:00.000Z'
  });
  const replay = await applyMutationBatchAtomically(retry.state, firstBatch, async () => {
    assert.fail('receipt replay must not persist');
  }, {idFactory:ids(), now:'2026-08-13T16:00:00.000Z'});
  assert.equal(retry.result.payloadDigest, firstBatch.payloadDigest);
  assert.deepEqual(replay.result.receipt, retry.result.receipt);
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.persistence, null);
});

test('CSV transaction identity scopes the same external reference to its source account', async () => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Account A purchase,5.25,account-a,shared-123,USD',
    '2026-08-02,Account B purchase,7.50,account-b,shared-123,USD'
  ].join('\n');
  const batch = await createCsvMutationBatch({
    csvText:csv,
    producedAt:V3A_NOW,
    profile:{id:'multi-account-profile', signProfile:'positive_outflow'}
  });
  await validateSourceMutationBatch(batch);
  assert.equal(batch.transactionMutations[0].sourceRecordRef, batch.transactionMutations[1].sourceRecordRef);
  assert.notEqual(batch.transactionMutations[0].sourceAccountRef, batch.transactionMutations[1].sourceAccountRef);
  const result = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(result.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 2);
  assert.deepEqual(
    result.state.domain.transactions.filter(item => item.sourceKind === 'csv').map(item => item.sourceAccountRef).sort(),
    ['external:account-a', 'external:account-b']
  );
  const otherProfileBatch = await createCsvMutationBatch({
    csvText:csv,
    producedAt:V3A_NOW,
    profile:{id:'intentionally-distinct-profile', signProfile:'positive_outflow'}
  });
  assert.notEqual(batch.sourceNamespace, otherProfileBatch.sourceNamespace);
  const otherProfile = await reconcileMutationBatch(result.state, otherProfileBatch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(otherProfile.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 4);
});

test('account-scoped CSV replay and authored amount conflict preserve identity, sign, and isolation', async () => {
  const csv = [
    'date,description,amount,account_id,transaction_id,currency',
    '2026-08-01,Account A movement,+12.50,account-a,shared-cross,USD',
    '2026-08-02,Account B movement,+7.50,account-b,shared-cross,USD'
  ].join('\n');
  const profile = {id:'cross-invariant-profile', signProfile:'signed_cash_flow'};
  const imported = await createCsvMutationBatch({csvText:csv, producedAt:V3A_NOW, profile});
  const first = await reconcileMutationBatch(freshState(), imported, {idFactory:ids(), now:V3A_NOW});
  const laterImport = await createCsvMutationBatch({csvText:csv, producedAt:'2026-08-12T16:00:00.000Z', profile});
  const importReplay = await reconcileMutationBatch(first.state, laterImport, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'});
  assert.equal(importReplay.result.status, 'already_applied');

  const accountA = importReplay.state.domain.transactions.find(item => item.sourceAccountRef === 'external:account-a');
  const accountB = importReplay.state.domain.transactions.find(item => item.sourceAccountRef === 'external:account-b');
  await saveAllocationDraft(importReplay.state, accountA.id, [{
    id:'cross-transfer-allocation', bucketId:SYSTEM_BUCKET_IDS.transfer, subBucketId:null,
    amountCents:1250, ownershipType:'mine', note:'Preserve interpretation', createdAt:null
  }], async () => {}, {now:'2026-08-12T17:00:00.000Z', markReviewed:true});
  assert.equal(accountA.amountCents, 1250);
  assert.equal(accountA.movementType, 'internal_transfer');
  assert.equal(parseExactUsdAmount(accountA.sourceAmount.decimal, {
    signConvention:accountA.sourceAmount.signConvention
  }).amountCents, accountA.amountCents);

  const sourceMutation = structuredClone(imported.transactionMutations.find(item => item.sourceAccountRef === 'external:account-a'));
  sourceMutation.kind = 'modify';
  sourceMutation.observedAt = '2026-08-13T16:00:00.000Z';
  sourceMutation.record.amountCents = 1500;
  sourceMutation.record.sourceAmount.decimal = '+15.00';
  sourceMutation.record.sourceRevision = 'csv-revision-2';
  const modification = await finalizeMutationBatch({
    contractVersion:1,
    batchId:'cross-invariant-modification',
    sourceKind:'csv',
    adapterKind:'csv.generic.v1',
    sourceNamespace:imported.sourceNamespace,
    producedAt:'2026-08-13T16:00:00.000Z',
    observation:{startedAt:'2026-08-13T16:00:00.000Z', completedAt:'2026-08-13T16:00:00.000Z', environment:'local', requestRef:null},
    checkpoint:null,
    accountMutations:[],
    transactionMutations:[sourceMutation],
    quarantinedRecords:[],
    sourceWarnings:[],
    payloadDigest:''
  });
  const changed = await reconcileMutationBatch(importReplay.state, modification, {idFactory:ids(), now:'2026-08-13T16:00:00.000Z'});
  const changedA = changed.state.domain.transactions.find(item => item.id === accountA.id);
  const unchangedB = changed.state.domain.transactions.find(item => item.id === accountB.id);
  assert.equal(changedA.amountCents, 1500);
  assert.equal(changedA.movementType, 'internal_transfer');
  assert.equal(changedA.reviewStatus, 'needs_resolution');
  assert.equal(changedA.interpretationConflictId !== null, true);
  assert.equal(changed.state.domain.allocations.find(item => item.id === 'cross-transfer-allocation').status, 'superseded');
  assert.equal(unchangedB.amountCents, 750);
  assert.equal(unchangedB.interpretationConflictId, null);
  assert.equal(changed.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 2);
  const mutationReplay = await reconcileMutationBatch(changed.state, modification, {idFactory:ids(), now:'2026-08-14T16:00:00.000Z'});
  assert.equal(mutationReplay.result.status, 'already_applied');
  assert.equal(mutationReplay.state.domain.interpretationConflicts.length, 1);
});

test('CSV debit/credit columns map exactly and require one explicit non-empty side', async () => {
  const csv = [
    'date,description,debit,credit,account,transaction_id,currency',
    '2026-08-01,Debit row,12.34,,Checking,debit-row,USD',
    '2026-08-02,Credit row,,8.90,Checking,credit-row,USD',
    '2026-08-03,Ambiguous row,1.00,1.00,Checking,bad-row,USD'
  ].join('\n');
  const batch = await createCsvMutationBatch({
    csvText:csv,
    producedAt:V3A_NOW,
    profile:{signProfile:'debit_credit', accountMappings:{Checking:'mapped:checking'}}
  });
  assert.deepEqual(batch.transactionMutations.map(item => item.record.amountCents), [-1234, 890]);
  assert.deepEqual(batch.transactionMutations.map(item => item.record.sourceAmount.signConvention), ['debit_credit', 'debit_credit']);
  assert.equal(batch.quarantinedRecords[0].safeDetailCode, 'DEBIT_CREDIT_EXCLUSIVE');
  await validateSourceMutationBatch(batch);
});

test('unsupported vault schema and missing account relationships fail before durable mutation', async () => {
  const batch = await fixtureBatch({batchId:'unsupported-state'});
  const future = freshState();
  future.schemaVersion = STATE_SCHEMA_VERSION + 1;
  await assert.rejects(() => reconcileMutationBatch(future, batch, {idFactory:ids()}), error => error.code === 'UNSUPPORTED_SCHEMA');

  const missingAccount = await fixtureBatch({
    batchId:'missing-account-relationship', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('orphan', {sourceAccountRef:'not-present'})]
  });
  const state = freshState();
  const before = structuredClone(state);
  await assert.rejects(() => reconcileMutationBatch(state, missingAccount, {idFactory:ids()}), error => error.code === 'MISSING_LOCAL_ACCOUNT');
  assert.deepEqual(state, before);
});

test('one invalid mutation prevents all valid mutations from applying', async () => {
  const state = freshState();
  const before = structuredClone(state);
  const batch = await fixtureBatch({
    batchId:'atomic-validation-failure',
    transactionMutations:[fixtureTransactionMutation('valid-ref'), fixtureTransactionMutation('valid-ref')]
  });
  await assert.rejects(() => reconcileMutationBatch(state, batch, {idFactory:ids()}));
  assert.deepEqual(state, before);
});

test('persistence failure leaves the vault draft untouched and a retry applies the exact batch once', async () => {
  const state = freshState();
  const before = structuredClone(state);
  const batch = await fixtureBatch({batchId:'persistence-retry'});
  await assert.rejects(() => applyMutationBatchAtomically(state, batch, async () => { throw new Error('simulated disk full'); }, {idFactory:ids(), now:V3A_NOW}), /simulated disk full/);
  assert.deepEqual(state, before);
  let persisted = null;
  const retry = await applyMutationBatchAtomically(state, batch, async next => { persisted = structuredClone(next); return {ok:true}; }, {idFactory:ids(), now:V3A_NOW});
  assert.equal(retry.changed, true);
  assert.deepEqual(retry.state, persisted);
  assert.equal(retry.state.domain.transactions.filter(item => item.sourceKind === 'provider').length, 1);
});

test('schema 9 to 10 migration is deterministic for empty/populated vaults and preserves accounts, allocations, classifications, and manual/CSV history', () => {
  const emptySchema9 = toSchema9(freshState());
  const emptyResult = migrateState(emptySchema9, {now:V3A_NOW});
  assert.equal(emptyResult.state.schemaVersion, 10);
  assert.deepEqual(emptyResult.state.domain.ingestionReceipts, []);
  assert.deepEqual(emptyResult.state.domain.sourceQuarantines, []);

  const schema9 = toSchema9(freshState());
  const account = {
    id:'legacy-csv-account', institutionId:null, externalAccountId:'csv-account-id', friendlyName:'Friendly stays', officialName:'CSV Checking',
    mask:null, type:'cash', subtype:null, currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  schema9.domain.accounts.push(account);
  const transaction = {
    id:'legacy-csv-transaction', accountId:account.id, source:'csv', sourceTransactionId:'csv-transaction-id', rawName:'Legacy CSV', merchantName:'Legacy CSV',
    amountCents:-1200, currency:'USD', authorizedAt:null, postedAt:'2026-08-01', displayDate:'2026-08-01', pendingStatus:'posted',
    movementType:'expense', reviewStatus:'reviewed', locationRegion:null, locationCountry:null, locationSource:null, providerCategory:'FOOD',
    manualOverrides:{merchantName:'User label'}, createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  schema9.domain.transactions.push(transaction);
  const secondAccount = {
    ...account,
    id:'legacy-csv-account-2',
    externalAccountId:'csv-account-id-2',
    friendlyName:'Second account'
  };
  const secondTransaction = {
    ...transaction,
    id:'legacy-csv-transaction-2',
    accountId:secondAccount.id,
    rawName:'Same external ID, second account',
    merchantName:'Same external ID, second account',
    manualOverrides:null
  };
  schema9.domain.accounts.push(secondAccount);
  schema9.domain.transactions.push(secondTransaction);
  const bucket = schema9.domain.buckets.find(item => !item.system && item.parentId === null);
  schema9.domain.allocations.push({
    id:'legacy-allocation', transactionId:transaction.id, bucketId:bucket.id, subBucketId:null, amountCents:1200,
    ownershipType:'mine', note:'preserve', reimbursementClaimId:null, createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  const before = structuredClone(schema9);
  const first = migrateState(schema9, {now:V3A_NOW});
  const second = migrateState(schema9, {now:V3A_NOW});
  assert.deepEqual(schema9, before);
  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.applied, ['v3a-provider-neutral-ingestion']);
  assert.equal(first.state.schemaVersion, 10);
  assert.equal(first.state.domain.accounts.find(item => item.id === account.id).friendlyName, 'Friendly stays');
  assert.equal(first.state.domain.transactions.find(item => item.id === transaction.id).sourceRecordRef, 'csv-transaction-id');
  assert.equal(first.state.domain.transactions.find(item => item.id === secondTransaction.id).sourceRecordRef, 'csv-transaction-id');
  assert.notEqual(
    first.state.domain.transactions.find(item => item.id === transaction.id).sourceAccountRef,
    first.state.domain.transactions.find(item => item.id === secondTransaction.id).sourceAccountRef
  );
  assert.equal(first.state.domain.transactions.find(item => item.id === transaction.id).manualOverrides.merchantName, 'User label');
  assert.equal(first.state.domain.allocations.find(item => item.id === 'legacy-allocation').status, 'active');
  assert.equal(first.state.domain.buckets.filter(item => item.system).length, 3);
  assert.equal(first.state.domain.devotionalState.activeDevotionalId, schema9.domain.devotionalState.activeDevotionalId);
  assert.equal(validateFoundationDomain(first.state.domain).ok, true);
  assert.deepEqual(migrateState(first.state, {now:V3A_NOW}).state, first.state);
});

test('schema 9 to 10 migration never derives CSV account identity from duplicate display labels', () => {
  const schema9 = toSchema9(freshState());
  const baseAccount = {
    id:'legacy-csv-same-label-a', institutionId:null, externalAccountId:null, friendlyName:'Checking', officialName:'Checking',
    mask:null, type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  const secondAccount = {...baseAccount, id:'legacy-csv-same-label-b'};
  schema9.domain.accounts.push(baseAccount, secondAccount);
  schema9.domain.transactions.push(
    {
      id:'legacy-csv-same-label-tx-a', accountId:baseAccount.id, source:'csv', sourceTransactionId:'shared-external-id',
      rawName:'First', merchantName:'First', amountCents:-525, currency:'USD', authorizedAt:null, postedAt:'2026-08-01',
      displayDate:'2026-08-01', pendingStatus:'posted', movementType:'unclassified', reviewStatus:'pending',
      locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null, manualOverrides:null,
      createdAt:V3A_NOW, updatedAt:V3A_NOW
    },
    {
      id:'legacy-csv-same-label-tx-b', accountId:secondAccount.id, source:'csv', sourceTransactionId:'shared-external-id',
      rawName:'Second', merchantName:'Second', amountCents:-750, currency:'USD', authorizedAt:null, postedAt:'2026-08-02',
      displayDate:'2026-08-02', pendingStatus:'posted', movementType:'unclassified', reviewStatus:'pending',
      locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null, manualOverrides:null,
      createdAt:V3A_NOW, updatedAt:V3A_NOW
    }
  );

  const migrated = migrateState(schema9, {now:V3A_NOW}).state;
  const accounts = migrated.domain.accounts.filter(item => item.id.startsWith('legacy-csv-same-label-'));
  const transactions = migrated.domain.transactions.filter(item => item.id.startsWith('legacy-csv-same-label-tx-'));
  assert.deepEqual(
    accounts.map(item => item.sourceAccountRef).sort(),
    ['account:legacy-csv-same-label-a', 'account:legacy-csv-same-label-b']
  );
  assert.notEqual(transactions[0].sourceAccountRef, transactions[1].sourceAccountRef);
  assert.equal(transactions[0].sourceRecordRef, 'shared-external-id');
  assert.equal(transactions[1].sourceRecordRef, 'shared-external-id');
  assert.equal(validateDomainStore(migrated.domain).ok, true);
});

test('schema 9 migration rejects malformed input clone-first with no partial migration', () => {
  const schema9 = toSchema9(freshState());
  schema9.domain.accounts[0].currency = 'usd';
  const before = structuredClone(schema9);
  assert.throws(() => migrateState(schema9, {now:V3A_NOW}), /Pre-migration state failed foundation validation/);
  assert.deepEqual(schema9, before);
});

test('encrypted backup and restore round-trip source metadata, tombstones, lineage, quarantine, conflicts, allocations, and classifications', async () => {
  const pending = await fixtureBatch({
    batchId:'backup-pending',
    transactionMutations:[fixtureTransactionMutation('backup-pending-ref', {lifecycle:'pending', postedDate:null, amountCents:-1000, decimal:'-10.00'})]
  });
  const first = await reconcileMutationBatch(freshState(), pending, {idFactory:ids(), now:V3A_NOW});
  const transaction = onlyFixtureTransaction(first.state);
  transaction.movementType = 'expense';
  transaction.reviewStatus = 'reviewed';
  addAllocation(first.state, transaction, 1000);
  const posted = await fixtureBatch({
    batchId:'backup-posted', accountMutations:[],
    transactionMutations:[
      fixtureTransactionMutation('backup-posted-ref', {predecessorSourceRef:'backup-pending-ref', amountCents:-1200, decimal:'-12.00'}),
      fixtureTransactionMutation('backup-pending-ref', {kind:'remove'})
    ],
    quarantinedRecords:[{
      sourceRecordRef:'backup-eur', sourceAccountRef:'fixture-account-1', observedAt:V3A_NOW,
      reason:'unsupported_currency', rawAmountDecimal:'9.99', sourceCurrency:'EUR', safeDetailCode:'CURRENCY_NOT_ACTIVE'
    }]
  });
  const prepared = await reconcileMutationBatch(first.state, posted, {idFactory:ids(), now:'2026-08-11T17:00:00.000Z'});
  const removal = await fixtureBatch({
    batchId:'backup-removal', accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('backup-posted-ref', {kind:'remove'})]
  });
  const tombstoned = await reconcileMutationBatch(prepared.state, removal, {idFactory:ids(), now:'2026-08-11T18:00:00.000Z'});
  const repository = createVaultRepository();
  const service = createStateService({repository, seed:freshState()});
  const passphrase = 'correct horse battery staple';
  const created = await service.create(passphrase, tombstoned.state);
  const backup = await service.exportEncryptedBackup();
  const changed = structuredClone(created.state);
  changed.preferences.monthlyIncome = 99;
  const saved = await service.save(changed, created.key, created.meta, {expectedVaultGeneration:created.vaultGeneration});
  const restored = await service.restore(backup, passphrase, {expectedVaultGeneration:saved.vaultGeneration});
  const restoredTransaction = restored.state.domain.transactions.find(item => item.sourceRecordRef === 'backup-posted-ref');
  assert.equal(restoredTransaction.sourceRefAliases[0].sourceRecordRef, 'backup-pending-ref');
  assert.equal(restoredTransaction.sourceLifecycle, 'removed');
  assert.equal(restoredTransaction.tombstone.reason, 'source_removed');
  assert.equal(restored.state.domain.sourceQuarantines[0].sourceCurrency, 'EUR');
  assert.equal(restored.state.domain.interpretationConflicts.length, 1);
  assert.equal(restored.state.domain.allocations[0].status, 'superseded');
  assert.equal(restored.state.domain.buckets.filter(item => item.system).length, 3);
});

test('calendar-quarter boundaries retain detailed canonical history, corrections, tombstones, and conflicts without destructive rollup', async () => {
  const batch = await fixtureBatch({
    batchId:'quarter-boundary',
    transactionMutations:[
      fixtureTransactionMutation('q1-last-day', {sourceDate:'2026-03-31', postedDate:'2026-03-31'}),
      fixtureTransactionMutation('q2-first-day', {sourceDate:'2026-04-01', postedDate:'2026-04-01'})
    ]
  });
  const state = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.deepEqual(state.state.domain.transactions.filter(item => item.sourceKind === 'provider').map(item => item.sourceDate).sort(), ['2026-03-31', '2026-04-01']);
  assert.equal(state.state.domain.transactions.every(item => !Object.hasOwn(item, 'quarterlySummary')), true);
});

test('canonical ingestion and adapters contain no provider-product-specific runtime terminology or network capability', () => {
  const paths = [
    'js/domain/exactMoney.js',
    'js/domain/ingestionContract.js',
    'js/services/ingestionService.js',
    'js/adapters/adapterUtils.js',
    'js/adapters/manualIngestionAdapter.js',
    'js/adapters/csvIngestionAdapter.js',
    'js/adapters/fixtureIngestionAdapter.js'
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, new RegExp(['pl', 'aid'].join(''), 'i'), path);
    assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\//i, path);
  }
});

test('same batch ID with changed source reference, account, or amount fails closed', async () => {
  const firstBatch = await fixtureBatch({batchId:'colliding-batch-id'});
  const state = await reconcileMutationBatch(freshState(), firstBatch, {idFactory:ids(), now:V3A_NOW});
  const conflicts = [
    await fixtureBatch({
      batchId:'colliding-batch-id',
      transactionMutations:[fixtureTransactionMutation('different-source-ref')]
    }),
    await fixtureBatch({
      batchId:'colliding-batch-id',
      accountMutations:[fixtureAccountMutation('different-account')],
      transactionMutations:[fixtureTransactionMutation('fixture-transaction-1', {sourceAccountRef:'different-account'})]
    }),
    await fixtureBatch({
      batchId:'colliding-batch-id',
      transactionMutations:[fixtureTransactionMutation('fixture-transaction-1', {amountCents:-1300, decimal:'-13.00'})]
    })
  ];
  for (const conflicting of conflicts) {
    await assert.rejects(
      () => reconcileMutationBatch(state.state, conflicting, {idFactory:ids()}),
      error => error.code === 'BATCH_ID_COLLISION'
    );
  }
});

test('fixture batch finalization is deterministic and payload digest covers checkpoint and ordering', async () => {
  const raw = {
    contractVersion:1,
    batchId:'digest-test',
    sourceKind:'provider',
    adapterKind:'fixture.v1',
    sourceNamespace:'fixture:digest',
    producedAt:V3A_NOW,
    observation:{startedAt:V3A_NOW, completedAt:V3A_NOW, environment:'local', requestRef:null},
    checkpoint:{baseRef:'base', proposedRef:'next', generation:1},
    accountMutations:[fixtureAccountMutation()],
    transactionMutations:[fixtureTransactionMutation()],
    quarantinedRecords:[],
    sourceWarnings:[],
    payloadDigest:''
  };
  const first = await finalizeMutationBatch(raw);
  const second = await finalizeMutationBatch(raw);
  assert.equal(first.payloadDigest, second.payloadDigest);
  const changed = await finalizeMutationBatch({...raw, checkpoint:{...raw.checkpoint, generation:2}});
  assert.notEqual(first.payloadDigest, changed.payloadDigest);
});

assert.equal(STATE_SCHEMA_VERSION, 10);
