import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test, {beforeEach} from 'node:test';
import {createCsvMutationBatch} from '../js/adapters/csvIngestionAdapter.js';
import {createFixtureMutationBatch} from '../js/adapters/fixtureIngestionAdapter.js';
import {createManualMutationBatch} from '../js/adapters/manualIngestionAdapter.js';
import {STATE_SCHEMA_VERSION, SYSTEM_BUCKET_IDS} from '../js/domain/constants.js';
import {ExactMoneyError, parseExactUsdAmount} from '../js/domain/exactMoney.js';
import {
  canonicalExternalSourceReference,
  computeBatchDigest,
  computeLegacyEnvelopeDigest,
  encodeSourceAccountReference,
  finalizeMutationBatch,
  INGESTION_LIMITS,
  SOURCE_ACCOUNT_IDENTITY_DOMAINS,
  validateSourceMutationBatch
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
    'sourceKind', 'sourceNamespace', 'sourceAccountRef', 'sourceAccountIdentityDomain',
    'connectionId', 'institutionName', 'providerDisplayName',
    'enabled', 'hidden', 'sourceStatus', 'connectionStatus', 'sourceMetadata', 'balances', 'sourceObservedAt'
  ]) delete account[field];
  for (const transaction of legacy.domain.transactions) for (const field of [
    'sourceKind', 'sourceNamespace', 'sourceRecordRef', 'sourceAccountRef', 'sourceAccountIdentityDomain',
    'sourceLifecycle', 'sourceAmount',
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

test('raw external source references use one opaque collision-free canonical encoding', async t => {
  const cases = [
    ['ordinary', 'stable-account', 'external:stable-account'],
    ['punctuation', 'acct:/?#[]@!$&\'()*+,;=', 'external:acct:/?#[]@!$&\'()*+,;='],
    ['internal whitespace', 'account  two', 'external:account  two'],
    ['Unicode', '账户-Å-💵', 'external:账户-Å-💵'],
    ['colon', 'bank:checking:1234', 'external:bank:checking:1234'],
    ['prefix-looking raw value', 'external:stable-account', 'external:external:stable-account'],
    ['leading ASCII space', ' stable-account', 'external: stable-account'],
    ['trailing ASCII space', 'stable-account ', 'external:stable-account '],
    ['NBSP boundary', '\u00a0stable-account', 'external:\u00a0stable-account'],
    ['long valid value', 'x'.repeat(247), `external:${'x'.repeat(247)}`]
  ];
  for (const [name, raw, expected] of cases) await t.test(name, () => {
    assert.equal(canonicalExternalSourceReference(raw), expected);
  });
  assert.notEqual(canonicalExternalSourceReference('foo'), canonicalExternalSourceReference('external:foo'));
  assert.notEqual(canonicalExternalSourceReference('CaseSensitive'), canonicalExternalSourceReference('casesensitive'));
  assert.notEqual(canonicalExternalSourceReference('é'), canonicalExternalSourceReference('é'));
  assert.throws(() => canonicalExternalSourceReference('x'.repeat(248)), error => error.code === 'INVALID_RAW_EXTERNAL_REFERENCE');
  assert.throws(() => canonicalExternalSourceReference('bad\u0000id'), error => error.code === 'INVALID_RAW_EXTERNAL_REFERENCE');
});

test('source-account reference encoding is deterministic and injective within and across every encoded identity domain', () => {
  const domains = [
    SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL,
    SOURCE_ACCOUNT_IDENTITY_DOMAINS.MAPPING,
    SOURCE_ACCOUNT_IDENTITY_DOMAINS.MIGRATED_LOCAL,
    SOURCE_ACCOUNT_IDENTITY_DOMAINS.DIRECT
  ];
  const payloads = [
    'foo', 'external:foo', 'mapping:foo', 'mapped:foo', 'file:x', 'external:external:foo',
    'a:b', ':', '账户-Å-💵', 'punctuation-._~:/?#[]@!$&\'()*+,;=', 'CaseSensitive',
    'casesensitive', 'internal  whitespace', 'é', 'é', ' foo', 'foo ', ' foo ',
    '\u00a0foo', 'foo\u00a0', '\u2003foo', 'foo\u2003', 'a/b', 'a\\b', 'a||b', '   ', '\u00a0'
  ];
  assert.equal(new Set(payloads).size, payloads.length);
  const encoded = new Map();
  const allReferences = new Set();
  for (const domain of domains) {
    const references = payloads.map(payload => encodeSourceAccountReference(domain, payload));
    assert.equal(new Set(references).size, payloads.length, `${domain} must be injective`);
    for (const [index, payload] of payloads.entries()) {
      assert.equal(encodeSourceAccountReference(domain, payload), references[index], `${domain} must be deterministic`);
      allReferences.add(references[index]);
    }
    encoded.set(domain, references);
  }
  assert.equal(allReferences.size, domains.length * payloads.length, 'all domain/payload pairs must be disjoint');
  for (let leftIndex = 0; leftIndex < domains.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < domains.length; rightIndex += 1) {
      const left = new Set(encoded.get(domains[leftIndex]));
      assert.equal(
        encoded.get(domains[rightIndex]).some(reference => left.has(reference)),
        false,
        `${domains[leftIndex]} and ${domains[rightIndex]} must be disjoint`
      );
    }
  }
  assert.equal(
    encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.UNKNOWN),
    'unknown-account'
  );
  assert.equal(
    domains.some(domain => encoded.get(domain).includes('unknown-account')),
    false
  );
  const prefixes = new Map([
    [SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL, 'external:'],
    [SOURCE_ACCOUNT_IDENTITY_DOMAINS.MAPPING, 'mapping:'],
    [SOURCE_ACCOUNT_IDENTITY_DOMAINS.MIGRATED_LOCAL, 'account:'],
    [SOURCE_ACCOUNT_IDENTITY_DOMAINS.DIRECT, 'direct:']
  ]);
  for (const domain of domains) {
    const maximumPayloadLength = INGESTION_LIMITS.refChars - prefixes.get(domain).length;
    const boundary = ` ${'x'.repeat(maximumPayloadLength - 1)}`;
    assert.equal(encodeSourceAccountReference(domain, boundary).length, INGESTION_LIMITS.refChars);
    assert.throws(
      () => encodeSourceAccountReference(domain, `${boundary}x`),
      error => error.code === 'INVALID_SOURCE_ACCOUNT_REFERENCE'
    );
  }
  assert.notEqual(canonicalExternalSourceReference('foo'), canonicalExternalSourceReference(' foo'));
  assert.notEqual(canonicalExternalSourceReference('foo'), canonicalExternalSourceReference('foo '));
  assert.notEqual(canonicalExternalSourceReference('foo'), canonicalExternalSourceReference('\u00a0foo'));
  assert.throws(() => canonicalExternalSourceReference(''), error => error.code === 'INVALID_RAW_EXTERNAL_REFERENCE');
  assert.throws(() => canonicalExternalSourceReference('\tfoo'), error => error.code === 'INVALID_RAW_EXTERNAL_REFERENCE');
});

test('schema-9 migration and CSV ingestion encode opaque external account and transaction IDs identically', async t => {
  const rawIds = [
    'stable-id', 'punctuation-._~:/?#[]@!$&\'()*+', 'internal  whitespace', '账户-Å-💵',
    'external:prefix-looking', 'CaseSensitive', 'casesensitive', ' foo', 'foo ', '\u00a0foo',
    'a|external:b', 'x'.repeat(247)
  ];
  const observedRefs = new Set();
  for (const [index, rawId] of rawIds.entries()) await t.test(`opaque ID ${index + 1}`, async () => {
    const schema9 = toSchema9(freshState());
    const accountId = `edge-account-${index}`;
    const transactionId = `edge-transaction-${index}`;
    schema9.domain.accounts.push({
      id:accountId, institutionId:null, externalAccountId:rawId, friendlyName:'Edge', officialName:'Edge', mask:null,
      type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
      createdAt:V3A_NOW, updatedAt:V3A_NOW
    });
    schema9.domain.transactions.push({
      id:transactionId, accountId, source:'csv', sourceTransactionId:rawId, rawName:null, merchantName:null,
      amountCents:-100, currency:'USD', authorizedAt:null, postedAt:'2026-08-01', displayDate:'2026-08-01',
      pendingStatus:'posted', movementType:'unclassified', reviewStatus:'pending', locationRegion:null,
      locationCountry:null, locationSource:null, providerCategory:null, manualOverrides:null,
      createdAt:V3A_NOW, updatedAt:V3A_NOW
    });
    const migrated = migrateState(schema9, {now:V3A_NOW}).state;
    const batch = await createCsvMutationBatch({
      rows:[{date:'2026-08-01', amount:'1.00', account_name:'Edge', account_id:rawId, transaction_id:rawId}],
      producedAt:V3A_NOW,
      sourceNamespace:'csv:legacy',
      profile:{id:`edge-${index}`}
    });
    const migratedAccount = migrated.domain.accounts.find(item => item.id === accountId);
    const migratedTransaction = migrated.domain.transactions.find(item => item.id === transactionId);
    assert.equal(migratedAccount.sourceAccountRef, batch.accountMutations[0].sourceAccountRef);
    assert.equal(migratedAccount.sourceAccountIdentityDomain, SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL);
    assert.equal(migratedTransaction.sourceAccountIdentityDomain, SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL);
    assert.equal(migratedTransaction.sourceRecordRef, batch.transactionMutations[0].sourceRecordRef);
    observedRefs.add(`${migratedAccount.sourceAccountRef}\u001f${migratedTransaction.sourceRecordRef}`);
  });
  assert.equal(observedRefs.size, rawIds.length);
});

test('explicit external IDs remain separate from deterministic CSV fallback references', async () => {
  const profile = {id:'fallback-domain-separation', accountMappings:{Checking:'mapped:checking'}};
  const explicit = await createCsvMutationBatch({
    rows:[{date:'2026-08-01', amount:'1.00', account:'Checking', transaction_id:'file:pretend:row:2'}],
    producedAt:V3A_NOW,
    profile
  });
  const fallback = await createCsvMutationBatch({
    csvText:'date,amount,account\n2026-08-01,1.00,Checking',
    producedAt:V3A_NOW,
    profile
  });
  assert.equal(explicit.transactionMutations[0].sourceRecordRef, 'external:file:pretend:row:2');
  assert.match(fallback.transactionMutations[0].sourceRecordRef, /^file:[a-f0-9]{64}:row:2$/);
  assert.notEqual(explicit.transactionMutations[0].sourceRecordRef, fallback.transactionMutations[0].sourceRecordRef);
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

test('manual and fixture adapters preserve exact direct account identity payloads', async () => {
  const manual = await createManualMutationBatch({
    batchId:'manual-exact-account-identity',
    producedAt:V3A_NOW,
    accounts:[{sourceAccountRef:' direct-account ', account:{officialName:'Cash', currency:'USD', type:'cash'}}],
    transactions:[
      {
        sourceRecordRef:' direct-transaction ', sourceAccountRef:' direct-account ', amountDecimal:'1.00',
        currency:'USD', direction:'outflow', sourceDate:'2026-08-01'
      },
      {
        sourceRecordRef:' ', sourceAccountRef:' direct-account ', amountDecimal:'2.00',
        currency:'USD', direction:'outflow', sourceDate:'2026-08-02'
      }
    ]
  });
  assert.equal(manual.accountMutations[0].sourceAccountRef, 'direct: direct-account ');
  assert.equal(manual.transactionMutations[0].sourceAccountRef, 'direct: direct-account ');
  assert.equal(manual.transactionMutations[0].sourceRecordRef, ' direct-transaction ');
  assert.equal(manual.transactionMutations[1].sourceRecordRef, ' ');
  const manualApplied = await reconcileMutationBatch(freshState(), manual, {idFactory:ids(), now:V3A_NOW});
  assert.equal(manualApplied.result.counts.accountsAdded, 1);
  assert.equal(manualApplied.result.counts.transactionsAdded, 2);

  const fixture = await createFixtureMutationBatch({
    batchId:'fixture-exact-account-identity',
    producedAt:V3A_NOW,
    sourceNamespace:'fixture:exact-identity',
    accountMutations:[fixtureAccountMutation(' fixture-account ')],
    transactionMutations:[fixtureTransactionMutation('fixture-exact-record', {sourceAccountRef:' fixture-account '})]
  });
  assert.equal(fixture.accountMutations[0].sourceAccountRef, 'direct: fixture-account ');
  assert.equal(fixture.transactionMutations[0].sourceAccountRef, 'direct: fixture-account ');
  assert.throws(
    () => encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.DIRECT, '\tinvalid'),
    error => error.code === 'INVALID_SOURCE_ACCOUNT_REFERENCE'
  );
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
  assert.deepEqual(accounts.map(item => item.sourceAccountRef).sort(), ['direct:account-ref-a', 'direct:account-ref-b']);
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

test('tombstone and revival keep boundary-distinct account identities isolated', async () => {
  const initial = await fixtureBatch({
    batchId:'boundary-revival-base',
    accountMutations:[fixtureAccountMutation('foo'), fixtureAccountMutation('foo ')],
    transactionMutations:[
      fixtureTransactionMutation('shared-boundary-record', {sourceAccountRef:'foo'}),
      fixtureTransactionMutation('shared-boundary-record', {sourceAccountRef:'foo '})
    ]
  });
  const applied = await reconcileMutationBatch(freshState(), initial, {idFactory:ids(), now:V3A_NOW});
  const original = applied.state.domain.transactions.find(item => item.sourceAccountRef === 'direct:foo ');
  const removal = await fixtureBatch({
    batchId:'boundary-revival-remove',
    accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('shared-boundary-record', {sourceAccountRef:'foo ', kind:'remove'})]
  });
  const removed = await reconcileMutationBatch(applied.state, removal, {
    idFactory:ids(), now:'2026-08-11T17:00:00.000Z'
  });
  assert.equal(removed.state.domain.transactions.find(item => item.sourceAccountRef === 'direct:foo ').sourceLifecycle, 'removed');
  assert.equal(removed.state.domain.transactions.find(item => item.sourceAccountRef === 'direct:foo').sourceLifecycle, 'posted');
  const revival = await fixtureBatch({
    batchId:'boundary-revival-add',
    accountMutations:[],
    transactionMutations:[fixtureTransactionMutation('shared-boundary-record', {sourceAccountRef:'foo '})]
  });
  const revived = await reconcileMutationBatch(removed.state, revival, {
    idFactory:ids(), now:'2026-08-11T18:00:00.000Z'
  });
  const current = revived.state.domain.transactions.find(item => item.sourceAccountRef === 'direct:foo ');
  assert.equal(current.id, original.id);
  assert.equal(current.sourceLifecycle, 'posted');
  assert.equal(revived.state.domain.transactions.find(item => item.sourceAccountRef === 'direct:foo').sourceLifecycle, 'posted');
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

test('CSV external and saved-mapping account identity domains cannot collapse', async () => {
  const batch = await createCsvMutationBatch({
    rows:[
      {
        date:'2026-08-01', description:'Explicit identity', amount:'1.00', account:'Checking',
        account_id:'foo', transaction_id:'tx-explicit'
      },
      {
        date:'2026-08-02', description:'Mapped identity', amount:'2.00', account:'Checking',
        account_id:'', transaction_id:'tx-mapped'
      }
    ],
    producedAt:V3A_NOW,
    profile:{
      id:'candidate-5-domain-collision',
      signProfile:'positive_outflow',
      accountMappings:{Checking:'external:foo'}
    }
  });

  assert.deepEqual(
    batch.transactionMutations.map(item => item.sourceAccountRef),
    ['external:foo', 'mapping:external:foo']
  );
  assert.equal(batch.accountMutations.length, 2);

  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const accounts = applied.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  const transactions = applied.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.equal(applied.result.counts.accountsAdded, 2);
  assert.equal(accounts.length, 2);
  assert.equal(transactions.length, 2);
  assert.equal(new Set(transactions.map(item => item.accountId)).size, 2);
  for (const transaction of transactions) {
    assert.equal(accounts.find(item => item.sourceAccountRef === transaction.sourceAccountRef)?.id, transaction.accountId);
  }
});

test('CSV preserves leading, trailing, and NBSP account identity boundaries end to end and on replay', async () => {
  const csvText = [
    'date,description,amount,account,account_id,transaction_id',
    '2026-08-01,Plain,1.00,Checking,foo,shared-boundary-tx',
    '2026-08-02,Leading,2.00,Checking," foo",shared-boundary-tx',
    '2026-08-03,Trailing,3.00,Checking,"foo ",shared-boundary-tx',
    '2026-08-04,NBSP,4.00,Checking,\u00a0foo,shared-boundary-tx'
  ].join('\n');
  const profile = {id:'candidate-7-whitespace-boundaries', signProfile:'positive_outflow'};
  const batch = await createCsvMutationBatch({csvText, producedAt:V3A_NOW, profile});
  const expectedRefs = ['external:foo', 'external: foo', 'external:foo ', 'external:\u00a0foo'];
  assert.deepEqual(batch.accountMutations.map(item => item.sourceAccountRef).sort(), expectedRefs.sort());
  assert.equal(batch.accountMutations.length, 4);
  assert.equal(batch.transactionMutations.length, 4);
  assert.equal(new Set(batch.transactionMutations.map(item => item.sourceRecordRef)).size, 1);

  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const accounts = applied.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  const transactions = applied.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.equal(applied.result.counts.accountsAdded, 4);
  assert.equal(applied.result.counts.transactionsAdded, 4);
  assert.equal(accounts.length, 4);
  assert.equal(transactions.length, 4);
  assert.equal(new Set(transactions.map(item => item.accountId)).size, 4);
  for (const transaction of transactions) {
    assert.equal(accounts.find(item => item.sourceAccountRef === transaction.sourceAccountRef)?.id, transaction.accountId);
  }

  const later = await createCsvMutationBatch({
    csvText,
    producedAt:'2026-08-13T16:00:00.000Z',
    profile
  });
  const replay = await reconcileMutationBatch(applied.state, later, {
    idFactory:ids(), now:'2026-08-13T16:00:00.000Z'
  });
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.changed, false);
  assert.equal(replay.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 4);
  assert.equal(replay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 4);
});

test('saved mapping identity payload boundaries stay exact while lookup labels remain normalized', async () => {
  const batch = await createCsvMutationBatch({
    rows:[
      {date:'2026-08-01', amount:'1.00', account:' PLAIN ', transaction_id:'mapping-boundary-a'},
      {date:'2026-08-02', amount:'2.00', account:'LEADING', transaction_id:'mapping-boundary-b'},
      {date:'2026-08-03', amount:'3.00', account:'trailing', transaction_id:'mapping-boundary-c'},
      {date:'2026-08-04', amount:'4.00', account:'nbsp', transaction_id:'mapping-boundary-d'}
    ],
    producedAt:V3A_NOW,
    profile:{
      id:'candidate-7-mapping-boundaries',
      accountMappings:{Plain:'foo', Leading:' foo', Trailing:'foo ', NBSP:'\u00a0foo'}
    }
  });
  assert.deepEqual(
    batch.accountMutations.map(item => item.sourceAccountRef).sort(),
    ['mapping:foo', 'mapping: foo', 'mapping:foo ', 'mapping:\u00a0foo'].sort()
  );
  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(applied.result.counts.accountsAdded, 4);
  assert.equal(new Set(applied.state.domain.transactions.filter(item => item.sourceKind === 'csv')
    .map(item => item.accountId)).size, 4);
});

test('external and mapping identities remain disjoint when opaque payloads contain boundary whitespace', async () => {
  const batch = await createCsvMutationBatch({
    rows:[
      {date:'2026-08-01', amount:'1.00', account:'Explicit', account_id:'foo', transaction_id:'cross-space-a'},
      {date:'2026-08-02', amount:'2.00', account:' mapped ', transaction_id:'cross-space-b'}
    ],
    producedAt:V3A_NOW,
    profile:{id:'candidate-7-cross-domain-space', accountMappings:{Mapped:' foo'}}
  });
  assert.deepEqual(
    batch.accountMutations.map(item => item.sourceAccountRef).sort(),
    ['external:foo', 'mapping: foo'].sort()
  );
  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(applied.result.counts.accountsAdded, 2);
  assert.equal(applied.result.counts.transactionsAdded, 2);
  assert.equal(new Set(applied.state.domain.transactions.filter(item => item.sourceKind === 'csv')
    .map(item => item.accountId)).size, 2);
});

test('collision-free tuple keys preserve delimiter-looking account and transaction identities', async () => {
  const batch = await createCsvMutationBatch({
    rows:[
      {
        date:'2026-08-01', amount:'1.00', account:'First', account_id:'a|external:b',
        transaction_id:'c'
      },
      {
        date:'2026-08-02', amount:'2.00', account:'Second', account_id:'a',
        transaction_id:'b|external:c'
      }
    ],
    producedAt:V3A_NOW,
    profile:{id:'candidate-7-delimiter-tuples'}
  });
  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(applied.result.counts.accountsAdded, 2);
  assert.equal(applied.result.counts.transactionsAdded, 2);
  assert.equal(validateDomainStore(applied.state.domain).ok, true);
  assert.equal(new Set(applied.state.domain.transactions.filter(item => item.sourceKind === 'csv')
    .map(item => item.accountId)).size, 2);
});

test('CSV external and mapping collision matrix preserves grouping, metadata, and transaction assignment', async () => {
  const payloads = ['foo', 'external:foo', 'mapping:foo', 'file:x'];
  const rows = [];
  const accountMappings = {};
  for (const [index, payload] of payloads.entries()) {
    rows.push({
      date:`2026-08-${String(index + 1).padStart(2, '0')}`,
      description:`External ${payload}`,
      amount:'1.00',
      account:`External ${index}`,
      account_id:payload,
      institution:`External Bank ${index}`,
      mask:`1${index}1${index}`,
      transaction_id:`external-tx-${index}`
    });
    const label = `Mapped ${index}`;
    accountMappings[label] = payload;
    rows.push({
      date:`2026-08-${String(index + 5).padStart(2, '0')}`,
      description:`Mapped ${payload}`,
      amount:'2.00',
      account:label,
      account_id:'',
      institution:`Mapped Bank ${index}`,
      mask:`2${index}2${index}`,
      transaction_id:`mapped-tx-${index}`
    });
  }
  const batch = await createCsvMutationBatch({
    rows,
    producedAt:V3A_NOW,
    profile:{id:'cross-domain-matrix', signProfile:'positive_outflow', accountMappings}
  });
  const externalRefs = new Set(payloads.map(payload => (
    encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL, payload)
  )));
  const mappingRefs = new Set(payloads.map(payload => (
    encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.MAPPING, payload)
  )));
  assert.equal([...externalRefs].some(reference => mappingRefs.has(reference)), false);
  assert.equal(batch.accountMutations.length, 8);
  assert.equal(new Set(batch.accountMutations.map(item => item.sourceAccountRef)).size, 8);

  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const accounts = applied.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  const transactions = applied.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.equal(accounts.length, 8);
  assert.equal(transactions.length, 8);
  assert.equal(new Set(transactions.map(item => item.accountId)).size, 8);
  for (const transaction of transactions) {
    const account = accounts.find(item => item.id === transaction.accountId);
    assert.equal(account.sourceAccountRef, transaction.sourceAccountRef);
    assert.equal(account.sourceAccountIdentityDomain, transaction.sourceAccountIdentityDomain);
    if (transaction.rawName.startsWith('External ')) assert.match(account.institutionName, /^External Bank /);
    else assert.match(account.institutionName, /^Mapped Bank /);
  }
});

test('CSV profile namespace scopes equal mapping labels and values to distinct canonical accounts', async () => {
  const csvText = 'date,description,amount,account,transaction_id\n2026-08-01,Coffee,1.00,Checking,shared-tx';
  const profile = id => ({id, signProfile:'positive_outflow', accountMappings:{Checking:'acct-1'}});
  const firstBatch = await createCsvMutationBatch({csvText, producedAt:V3A_NOW, profile:profile('profile-a')});
  const secondBatch = await createCsvMutationBatch({
    csvText,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile:profile('profile-b')
  });
  assert.equal(firstBatch.accountMutations[0].sourceAccountRef, secondBatch.accountMutations[0].sourceAccountRef);
  assert.notEqual(firstBatch.sourceNamespace, secondBatch.sourceNamespace);

  const first = await reconcileMutationBatch(freshState(), firstBatch, {idFactory:ids(), now:V3A_NOW});
  const second = await reconcileMutationBatch(first.state, secondBatch, {
    idFactory:ids(), now:'2026-08-12T16:00:00.000Z'
  });
  const accounts = second.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  const transactions = second.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.equal(accounts.length, 2);
  assert.equal(transactions.length, 2);
  assert.equal(new Set(accounts.map(item => item.id)).size, 2);
  assert.equal(new Set(transactions.map(item => item.accountId)).size, 2);
});

test('CSV explicit account ID is authoritative when a saved mapping is also available', async () => {
  const batch = await createCsvMutationBatch({
    rows:[{
      date:'2026-08-01', description:'Explicit wins', amount:'1.00', account:'Checking',
      account_id:'source-account', transaction_id:'source-transaction'
    }],
    producedAt:V3A_NOW,
    profile:{
      id:'explicit-precedence',
      signProfile:'positive_outflow',
      accountMappings:{Checking:'contradictory-mapping'}
    }
  });
  assert.equal(batch.accountMutations[0].sourceAccountRef, 'external:source-account');
  assert.equal(batch.accountMutations[0].sourceAccountIdentityDomain, SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL);
  assert.equal(batch.transactionMutations[0].sourceAccountRef, 'external:source-account');
  assert.equal(batch.transactionMutations[0].sourceAccountIdentityDomain, SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL);
  assert.equal(batch.accountMutations.some(item => item.sourceAccountRef.includes('contradictory-mapping')), false);
});

test('equal transaction external IDs remain distinct across external and mapping account domains', async () => {
  const batch = await createCsvMutationBatch({
    rows:[
      {date:'2026-08-01', amount:'1.00', account:'Explicit', account_id:'foo', transaction_id:'shared-tx'},
      {date:'2026-08-02', amount:'2.00', account:'Mapped', account_id:'', transaction_id:'shared-tx'}
    ],
    producedAt:V3A_NOW,
    profile:{id:'domain-scoped-transaction', accountMappings:{Mapped:'external:foo'}}
  });
  assert.equal(new Set(batch.transactionMutations.map(item => item.sourceRecordRef)).size, 1);
  assert.equal(new Set(batch.transactionMutations.map(item => item.sourceAccountRef)).size, 2);
  const applied = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  const transactions = applied.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.equal(transactions.length, 2);
  assert.equal(new Set(transactions.map(item => item.id)).size, 2);
  assert.equal(new Set(transactions.map(item => item.accountId)).size, 2);
  const replay = await reconcileMutationBatch(applied.state, batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(replay.changed, false);
  assert.equal(replay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 2);
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
    assert.equal(firstBatch.accountMutations[0].sourceAccountRef, 'mapping:mapped:bank-a-checking');
    assert.equal(secondBatch.accountMutations[0].sourceAccountRef, 'mapping:mapped:bank-a-checking');
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

  await t.test('mapping identity payloads remain opaque while mapping lookup labels normalize', async () => {
    const batch = await createCsvMutationBatch({
      rows:[
        {date:'2026-08-01', amount:'1.00', account:'First', transaction_id:'opaque-a'},
        {date:'2026-08-02', amount:'2.00', account:'Second', transaction_id:'opaque-b'},
        {date:'2026-08-03', amount:'3.00', account:'Third', transaction_id:'opaque-c'},
        {date:'2026-08-04', amount:'4.00', account:'Fourth', transaction_id:'opaque-d'}
      ],
      producedAt:V3A_NOW,
      profile:{
        id:'opaque-mapping-values',
        accountMappings:{First:'CaseSensitive', Second:'casesensitive', Third:'é:a  b', Fourth:'é:a b'}
      }
    });
    assert.deepEqual(
      batch.accountMutations.map(item => item.sourceAccountRef).sort(),
      ['mapping:CaseSensitive', 'mapping:casesensitive', 'mapping:é:a b', 'mapping:é:a  b'].sort()
    );
    assert.equal(new Set(batch.accountMutations.map(item => item.sourceAccountRef)).size, 4);
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

test('mixed external, mapped, and unresolved CSV batch is atomic and corrected retry preserves domain separation', async () => {
  const csv = [
    'date,description,amount,account_id,account,transaction_id,currency',
    '2026-08-01,Explicit row,5.25,foo,Explicit,tx-explicit,USD',
    '2026-08-02,Mapped row,7.50,,Mapped,tx-mapped,USD',
    '2026-08-03,Needs mapping,9.25,,Savings,tx-unresolved,USD'
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
      profile:{
        id:'atomic-account-mapping-profile',
        signProfile:'positive_outflow',
        accountMappings:{Mapped:'external:foo'}
      }
    }),
    error => error.code === 'CSV_ACCOUNT_IDENTITY_AMBIGUOUS'
  );
  assert.deepEqual(created.state, beforeState);
  assert.equal(await service.exportEncryptedBackup(), beforeBackup);

  const invalidBoundaryRows = [
    {date:'2026-08-01', amount:'1.00', account_id:'valid-external', account:'Explicit', transaction_id:'atomic-boundary-a'},
    {date:'2026-08-02', amount:'2.00', account_id:'', account:'Mapped', transaction_id:'atomic-boundary-b'},
    {date:'2026-08-03', amount:'3.00', account_id:'invalid\tidentity', account:'Invalid', transaction_id:'atomic-boundary-c'}
  ];
  await assert.rejects(
    () => createCsvMutationBatch({
      rows:invalidBoundaryRows,
      producedAt:V3A_NOW,
      profile:{id:'atomic-invalid-identity-boundary', accountMappings:{Mapped:' mapped '}}
    }),
    error => error.code === 'INVALID_RAW_EXTERNAL_REFERENCE'
  );
  assert.deepEqual(created.state, beforeState);
  assert.equal(await service.exportEncryptedBackup(), beforeBackup);

  const correctedBoundary = await createCsvMutationBatch({
    rows:invalidBoundaryRows.map(row => row.account_id === 'invalid\tidentity' ? {...row, account_id:'valid identity'} : row),
    producedAt:V3A_NOW,
    profile:{id:'atomic-invalid-identity-boundary', accountMappings:{Mapped:' mapped '}}
  });
  let persistedBoundaryState = null;
  const boundaryApplied = await applyMutationBatchAtomically(
    freshState(),
    correctedBoundary,
    async nextState => {
      persistedBoundaryState = structuredClone(nextState);
      return {saved:true};
    },
    {idFactory:ids(), now:V3A_NOW}
  );
  assert.equal(boundaryApplied.result.counts.accountsAdded, 3);
  assert.equal(boundaryApplied.result.counts.transactionsAdded, 3);
  assert.deepEqual(persistedBoundaryState, boundaryApplied.state);

  const corrected = await createCsvMutationBatch({
    csvText:csv,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile:{
      id:'atomic-account-mapping-profile',
      signProfile:'positive_outflow',
      accountMappings:{Mapped:'external:foo', Savings:'mapped:savings'}
    }
  });
  const applied = await service.applyIngestionBatch(created.state, created.key, created.meta, corrected, {
    expectedVaultGeneration:created.vaultGeneration,
    idFactory:ids(),
    now:'2026-08-12T16:00:00.000Z'
  });
  assert.equal(applied.result.counts.accountsAdded, 3);
  assert.equal(applied.result.counts.transactionsAdded, 3);
  assert.equal(applied.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 3);
  assert.equal(applied.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 3);
  assert.deepEqual(
    applied.state.domain.accounts.filter(item => item.sourceKind === 'csv').map(item => item.sourceAccountRef).sort(),
    ['external:foo', 'mapping:external:foo', 'mapping:mapped:savings']
  );
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
  assert.equal(validateDomainStore(applied.state.domain).ok, false);
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

test('unreleased schema-10 pre-canonical migrated external references fail closed instead of duplicating identities', async () => {
  const schema9 = toSchema9(freshState());
  schema9.domain.accounts.push({
    id:'candidate-account', institutionId:null, externalAccountId:'stable-account', friendlyName:'Checking', officialName:'Checking',
    mask:null, type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  schema9.domain.transactions.push({
    id:'candidate-transaction', accountId:'candidate-account', source:'csv', sourceTransactionId:'external:stable-tx',
    rawName:'Coffee', merchantName:'Coffee', amountCents:-1000, currency:'USD', authorizedAt:null, postedAt:'2026-08-01',
    displayDate:'2026-08-01', pendingStatus:'posted', movementType:'unclassified', reviewStatus:'pending',
    locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null, manualOverrides:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  const candidateState = migrateState(schema9, {now:V3A_NOW}).state;
  const account = candidateState.domain.accounts.find(item => item.id === 'candidate-account');
  const transaction = candidateState.domain.transactions.find(item => item.id === 'candidate-transaction');
  account.sourceAccountRef = 'stable-account';
  transaction.sourceAccountRef = 'stable-account';
  transaction.sourceRecordRef = 'external:stable-tx';
  transaction.sourceTransactionId = 'external:stable-tx';
  assert.equal(validateDomainStore(candidateState.domain).ok, false);
  const before = structuredClone(candidateState);
  const batch = await createCsvMutationBatch({
    csvText:'date,description,amount,account,account_id,transaction_id\n2026-08-01,Coffee,10.00,Checking,stable-account,external:stable-tx',
    producedAt:V3A_NOW,
    profile:{id:'legacy'}
  });
  await assert.rejects(
    () => reconcileMutationBatch(candidateState, batch, {idFactory:ids(), now:V3A_NOW}),
    error => error.code === 'CSV_LEGACY_EXTERNAL_REFERENCE_UNRESOLVED'
  );
  assert.deepEqual(candidateState, before);
});

test('unreleased account-only schema-10 external reference ambiguity fails closed', async () => {
  const candidateState = freshState();
  candidateState.domain.accounts.push({
    id:'candidate-account-only', institutionId:null, externalAccountId:'stable-account', friendlyName:'Checking', officialName:'Checking',
    mask:null, type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    sourceKind:'csv', sourceNamespace:'csv:account-only', sourceAccountRef:'stable-account',
    sourceAccountIdentityDomain:SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL, connectionId:null,
    institutionName:null, providerDisplayName:'Checking', enabled:true, hidden:false, sourceStatus:'active',
    connectionStatus:'not_applicable', sourceMetadata:{}, balances:null, sourceObservedAt:V3A_NOW,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  assert.equal(validateDomainStore(candidateState.domain).ok, false);
  const before = structuredClone(candidateState);
  const batch = await createCsvMutationBatch({
    rows:[{date:'2026-08-01', amount:'1.00', account:'Checking', account_id:'stable-account', transaction_id:'stable-tx'}],
    producedAt:V3A_NOW,
    sourceNamespace:'csv:account-only',
    profile:{id:'account-only'}
  });
  await assert.rejects(
    () => reconcileMutationBatch(candidateState, batch, {idFactory:ids(), now:V3A_NOW}),
    error => error.code === 'CSV_LEGACY_EXTERNAL_REFERENCE_UNRESOLVED'
  );
  assert.deepEqual(candidateState, before);
});

test('unreleased schema-10 CSV state without account-domain provenance fails closed without guessing', async () => {
  const csvText = 'date,description,amount,account,transaction_id\n2026-08-01,Coffee,1.00,Checking,legacy-domain-tx';
  const profile = {
    id:'legacy-domain-state',
    signProfile:'positive_outflow',
    accountMappings:{Checking:'external:foo'}
  };
  const original = await createCsvMutationBatch({csvText, producedAt:V3A_NOW, profile});
  const applied = await reconcileMutationBatch(freshState(), original, {idFactory:ids(), now:V3A_NOW});
  for (const account of applied.state.domain.accounts.filter(item => item.sourceKind === 'csv')) {
    delete account.sourceAccountIdentityDomain;
  }
  for (const transaction of applied.state.domain.transactions.filter(item => item.sourceKind === 'csv')) {
    delete transaction.sourceAccountIdentityDomain;
  }
  assert.equal(validateDomainStore(applied.state.domain).ok, false);
  const before = structuredClone(applied.state);
  const replay = await createCsvMutationBatch({
    csvText,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile
  });
  await assert.rejects(
    () => reconcileMutationBatch(applied.state, replay, {idFactory:ids(), now:'2026-08-12T16:00:00.000Z'}),
    error => error.code === 'CSV_LEGACY_ACCOUNT_IDENTITY_DOMAIN_UNRESOLVED'
  );
  assert.deepEqual(applied.state, before);
  assert.throws(
    () => migrateState(applied.state, {now:V3A_NOW}),
    error => error.code === 'CSV_LEGACY_ACCOUNT_IDENTITY_DOMAIN_UNRESOLVED'
  );
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
  assert.equal(restoredAccount.sourceAccountRef, 'mapping:mapped:bank-a-checking');
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

test('encrypted backup restore preserves collision-looking external and mapping domains without duplicates', async () => {
  const csvText = [
    'date,description,amount,account,account_id,transaction_id',
    '2026-08-01,Explicit,1.00,Explicit,foo,explicit-backup-tx',
    '2026-08-02,Mapped,2.00,Mapped,,mapped-backup-tx'
  ].join('\n');
  const profile = {
    id:'backup-domain-separation',
    signProfile:'positive_outflow',
    accountMappings:{Mapped:'external:foo'}
  };
  const batch = await createCsvMutationBatch({csvText, producedAt:V3A_NOW, profile});
  const imported = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  imported.state.review.importSettings.accountMappings = structuredClone(profile.accountMappings);
  const expectedAccountIds = new Map(imported.state.domain.accounts.filter(item => item.sourceKind === 'csv')
    .map(item => [item.sourceAccountRef, item.id]));
  const expectedTransactionAccounts = new Map(imported.state.domain.transactions.filter(item => item.sourceKind === 'csv')
    .map(item => [item.sourceRecordRef, item.accountId]));

  const repository = createVaultRepository();
  const service = createStateService({repository, seed:freshState()});
  const passphrase = 'correct horse battery staple';
  const created = await service.create(passphrase, imported.state);
  const backup = await service.exportEncryptedBackup();
  const changed = structuredClone(created.state);
  changed.preferences.monthlyIncome = 456;
  const saved = await service.save(changed, created.key, created.meta, {
    expectedVaultGeneration:created.vaultGeneration
  });
  const restored = await service.restore(backup, passphrase, {expectedVaultGeneration:saved.vaultGeneration});
  const later = await createCsvMutationBatch({
    csvText,
    producedAt:'2026-08-13T16:00:00.000Z',
    profile
  });
  const replay = await reconcileMutationBatch(restored.state, later, {
    idFactory:ids(), now:'2026-08-13T16:00:00.000Z'
  });
  const accounts = replay.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  const transactions = replay.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.equal(replay.result.status, 'already_applied');
  assert.deepEqual(accounts.map(item => item.sourceAccountRef).sort(), ['external:foo', 'mapping:external:foo']);
  assert.equal(accounts.length, 2);
  assert.equal(transactions.length, 2);
  for (const account of accounts) assert.equal(account.id, expectedAccountIds.get(account.sourceAccountRef));
  for (const transaction of transactions) {
    assert.equal(transaction.accountId, expectedTransactionAccounts.get(transaction.sourceRecordRef));
  }
  assert.deepEqual(replay.state.review.importSettings.accountMappings, profile.accountMappings);
});

test('encrypted backup restore preserves exact whitespace identities, domains, mappings, assignments, and replay', async () => {
  const csvText = [
    'date,description,amount,account,account_id,transaction_id',
    '2026-08-01,Plain,1.00,Checking,foo,backup-shared-tx',
    '2026-08-02,Leading,2.00,Checking," foo",backup-shared-tx',
    '2026-08-03,Mapped,3.00,Mapped,,backup-shared-tx'
  ].join('\n');
  const profile = {
    id:'candidate-7-backup-whitespace',
    signProfile:'positive_outflow',
    accountMappings:{Mapped:'foo '}
  };
  const batch = await createCsvMutationBatch({csvText, producedAt:V3A_NOW, profile});
  const imported = await reconcileMutationBatch(freshState(), batch, {idFactory:ids(), now:V3A_NOW});
  imported.state.review.importSettings.accountMappings = structuredClone(profile.accountMappings);
  const expectedAccounts = new Map(imported.state.domain.accounts.filter(item => item.sourceKind === 'csv')
    .map(item => [item.sourceAccountRef, {id:item.id, domain:item.sourceAccountIdentityDomain}]));
  const expectedAssignments = imported.state.domain.transactions.filter(item => item.sourceKind === 'csv')
    .map(item => ({id:item.id, accountId:item.accountId, sourceAccountRef:item.sourceAccountRef}));

  const repository = createVaultRepository();
  const service = createStateService({repository, seed:freshState()});
  const passphrase = 'candidate seven exact backup';
  const created = await service.create(passphrase, imported.state);
  const backup = await service.exportEncryptedBackup();
  const changed = structuredClone(created.state);
  changed.preferences.monthlyIncome = 789;
  const saved = await service.save(changed, created.key, created.meta, {
    expectedVaultGeneration:created.vaultGeneration
  });
  const restored = await service.restore(backup, passphrase, {expectedVaultGeneration:saved.vaultGeneration});
  const restoredAccounts = restored.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  assert.deepEqual(
    restoredAccounts.map(item => item.sourceAccountRef).sort(),
    ['external:foo', 'external: foo', 'mapping:foo '].sort()
  );
  for (const account of restoredAccounts) {
    assert.equal(account.id, expectedAccounts.get(account.sourceAccountRef)?.id);
    assert.equal(account.sourceAccountIdentityDomain, expectedAccounts.get(account.sourceAccountRef)?.domain);
  }
  for (const expected of expectedAssignments) {
    const transaction = restored.state.domain.transactions.find(item => item.id === expected.id);
    assert.equal(transaction.accountId, expected.accountId);
    assert.equal(transaction.sourceAccountRef, expected.sourceAccountRef);
  }
  assert.deepEqual(restored.state.review.importSettings.accountMappings, profile.accountMappings);

  const later = await createCsvMutationBatch({
    csvText,
    producedAt:'2026-08-13T16:00:00.000Z',
    profile
  });
  const replay = await reconcileMutationBatch(restored.state, later, {
    idFactory:ids(), now:'2026-08-13T16:00:00.000Z'
  });
  assert.equal(replay.result.status, 'already_applied');
  assert.equal(replay.state.domain.accounts.filter(item => item.sourceKind === 'csv').length, 3);
  assert.equal(replay.state.domain.transactions.filter(item => item.sourceKind === 'csv').length, 3);
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
  assert.equal(original.original.accountMutations[0].sourceAccountRef, 'mapping:mapped:legacy-checking');
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
  assert.equal(replay.state.domain.transactions.find(item => item.sourceKind === 'csv').sourceAccountRef, 'mapping:mapped:legacy-checking');
});

test('legacy receipt effect proof cannot substitute a boundary-distinct account identity', async () => {
  const original = await appliedCandidate1Csv({
    csv:'date,description,amount,account_id,transaction_id,currency\n2026-08-01,Coffee,5.25,foo,legacy-space-proof,USD',
    profile:{id:'legacy-whitespace-effect-proof', signProfile:'positive_outflow'}
  });
  const boundaryDistinct = structuredClone(original.original);
  for (const mutation of boundaryDistinct.accountMutations) mutation.sourceAccountRef = 'external:foo ';
  for (const mutation of boundaryDistinct.transactionMutations) mutation.sourceAccountRef = 'external:foo ';
  boundaryDistinct.payloadDigest = '';
  const finalized = await finalizeMutationBatch(boundaryDistinct);
  const before = structuredClone(original.state);
  await assert.rejects(
    () => reconcileMutationBatch(original.state, finalized, {idFactory:ids(), now:V3A_NOW}),
    error => error.code === 'BATCH_ID_COLLISION'
  );
  assert.deepEqual(original.state, before);
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
    if (item.name === 'transaction effect on wrong source account') {
      assert.equal(validateDomainStore(state.domain).ok, false, item.name);
    } else {
      assert.equal(validateDomainStore(state.domain).ok, true, item.name);
    }
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
        sourceAccountIdentityDomain:originalMutation.sourceAccountIdentityDomain,
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
  assert.equal(first.state.domain.transactions.find(item => item.id === transaction.id).sourceRecordRef, 'external:csv-transaction-id');
  assert.equal(first.state.domain.transactions.find(item => item.id === secondTransaction.id).sourceRecordRef, 'external:csv-transaction-id');
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

test('schema 9 CSV identities survive migration and identical adapter reimport without duplicate canonical entities', async () => {
  const schema9 = toSchema9(freshState());
  const account = {
    id:'legacy-stable-account', institutionId:null, externalAccountId:'stable-account', friendlyName:'Checking', officialName:'Checking',
    mask:'1234', type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  const transaction = {
    id:'legacy-stable-transaction', accountId:account.id, source:'csv', sourceTransactionId:'stable-tx',
    rawName:'Coffee', merchantName:'Coffee', amountCents:-1000, currency:'USD', authorizedAt:null, postedAt:'2026-08-01',
    displayDate:'2026-08-01', pendingStatus:'posted', movementType:'expense', reviewStatus:'reviewed',
    locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null, manualOverrides:{merchantName:'User Coffee'},
    userNote:'Keep this note',
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  schema9.domain.accounts.push(account);
  schema9.domain.transactions.push(transaction);
  const bucket = schema9.domain.buckets.find(item => !item.system && item.parentId === null);
  schema9.domain.allocations.push({
    id:'legacy-stable-allocation', transactionId:transaction.id, bucketId:bucket.id, subBucketId:null, amountCents:1000,
    ownershipType:'mine', note:'Keep this allocation', reimbursementClaimId:null, createdAt:V3A_NOW, updatedAt:V3A_NOW
  });

  const migrated = migrateState(schema9, {now:V3A_NOW}).state;
  const migratedAccount = migrated.domain.accounts.find(item => item.id === account.id);
  const migratedTransaction = migrated.domain.transactions.find(item => item.id === transaction.id);

  const batch = await createCsvMutationBatch({
    csvText:'date,description,amount,account_name,account_id,transaction_id,mask,account_type,account_subtype\n2026-08-01,Coffee,10.00,Checking,stable-account,stable-tx,1234,depository,checking',
    producedAt:V3A_NOW,
    profile:{id:'legacy'}
  });
  const beforeCounts = {accounts:migrated.domain.accounts.length, transactions:migrated.domain.transactions.length};
  const reapplied = await reconcileMutationBatch(migrated, batch, {idFactory:ids(), now:V3A_NOW});

  assert.equal(reapplied.result.counts.transactionsAdded, 0);
  assert.equal(reapplied.result.counts.accountsAdded, 0);
  assert.equal(migratedAccount.sourceAccountRef, 'external:stable-account');
  assert.equal(migratedTransaction.sourceRecordRef, 'external:stable-tx');
  assert.equal(reapplied.state.domain.accounts.length, beforeCounts.accounts);
  assert.equal(reapplied.state.domain.transactions.length, beforeCounts.transactions);
  assert.equal(reapplied.state.domain.accounts.find(item => item.sourceAccountRef === 'external:stable-account').id, account.id);
  const retained = reapplied.state.domain.transactions.find(item => item.sourceRecordRef === 'external:stable-tx');
  assert.equal(retained.id, transaction.id);
  assert.equal(retained.movementType, 'expense');
  assert.equal(retained.reviewStatus, 'reviewed');
  assert.deepEqual(retained.manualOverrides, {merchantName:'User Coffee'});
  assert.equal(retained.userNote, 'Keep this note');
  assert.equal(retained.interpretationConflictId, null);
  assert.equal(reapplied.result.counts.interpretationConflicts, 0);
  assert.equal(reapplied.state.domain.allocations.find(item => item.id === 'legacy-stable-allocation').status, 'active');
  assert.equal(reapplied.state.domain.allocations.find(item => item.id === 'legacy-stable-allocation').transactionId, transaction.id);
  const firstHistoryLength = retained.sourceHistory.length;
  const replay = await reconcileMutationBatch(reapplied.state, batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(replay.changed, false);
  assert.equal(replay.state.domain.transactions.find(item => item.id === transaction.id).sourceHistory.length, firstHistoryLength);

  const changedAmount = structuredClone(batch);
  changedAmount.batchId = 'changed-migrated-add';
  changedAmount.transactionMutations[0].record.amountCents = -1100;
  changedAmount.transactionMutations[0].record.sourceAmount.decimal = '11.00';
  changedAmount.payloadDigest = '';
  const finalizedChangedAmount = await finalizeMutationBatch(changedAmount);
  const beforeChangedAmount = structuredClone(migrated);
  await assert.rejects(
    () => reconcileMutationBatch(migrated, finalizedChangedAmount, {idFactory:ids(), now:V3A_NOW}),
    error => error.code === 'TRANSACTION_ADD_CONFLICT'
  );
  assert.deepEqual(migrated, beforeChangedAmount);
});

test('schema 9 whitespace identities migrate exactly and identical CSV reimport preserves user meaning and local IDs', async () => {
  const schema9 = toSchema9(freshState());
  const account = {
    id:'legacy-whitespace-account', institutionId:null, externalAccountId:' stable-account ',
    friendlyName:'Whitespace Checking', officialName:'Whitespace Checking', mask:'4321', type:'depository',
    subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  const transaction = {
    id:'legacy-whitespace-transaction', accountId:account.id, source:'csv', sourceTransactionId:' stable-tx ',
    rawName:'Exact Coffee', merchantName:'Exact Coffee', amountCents:-1000, currency:'USD', authorizedAt:null,
    postedAt:'2026-08-01', displayDate:'2026-08-01', pendingStatus:'posted', movementType:'expense',
    reviewStatus:'reviewed', locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null,
    manualOverrides:{merchantName:'User Exact Coffee'}, userNote:'Preserve exact identity note',
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  schema9.domain.accounts.push(account);
  schema9.domain.transactions.push(transaction);
  const bucket = schema9.domain.buckets.find(item => !item.system && item.parentId === null);
  schema9.domain.allocations.push({
    id:'legacy-whitespace-allocation', transactionId:transaction.id, bucketId:bucket.id, subBucketId:null,
    amountCents:1000, ownershipType:'mine', note:'Preserve exact allocation', reimbursementClaimId:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  });

  const migrated = migrateState(schema9, {now:V3A_NOW}).state;
  assert.equal(migrated.domain.accounts.find(item => item.id === account.id).sourceAccountRef, 'external: stable-account ');
  assert.equal(migrated.domain.transactions.find(item => item.id === transaction.id).sourceRecordRef, 'external: stable-tx ');
  const batch = await createCsvMutationBatch({
    csvText:[
      'date,description,amount,account_name,account_id,transaction_id,mask,account_type,account_subtype',
      '2026-08-01,Exact Coffee,10.00,Whitespace Checking," stable-account "," stable-tx ",4321,depository,checking'
    ].join('\n'),
    producedAt:V3A_NOW,
    profile:{id:'legacy'}
  });
  const reapplied = await reconcileMutationBatch(migrated, batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(reapplied.result.counts.accountsAdded, 0);
  assert.equal(reapplied.result.counts.transactionsAdded, 0);
  assert.equal(reapplied.state.domain.accounts.find(item => item.sourceAccountRef === 'external: stable-account ').id, account.id);
  const retained = reapplied.state.domain.transactions.find(item => item.sourceRecordRef === 'external: stable-tx ');
  assert.equal(retained.id, transaction.id);
  assert.equal(retained.accountId, account.id);
  assert.equal(retained.movementType, 'expense');
  assert.equal(retained.reviewStatus, 'reviewed');
  assert.deepEqual(retained.manualOverrides, {merchantName:'User Exact Coffee'});
  assert.equal(retained.userNote, 'Preserve exact identity note');
  assert.equal(retained.interpretationConflictId, null);
  const allocation = reapplied.state.domain.allocations.find(item => item.id === 'legacy-whitespace-allocation');
  assert.equal(allocation.transactionId, transaction.id);
  assert.equal(allocation.status, 'active');
  assert.equal(allocation.note, 'Preserve exact allocation');
});

test('migrated schema-9 external identity remains distinct from collision-looking saved mapping identity', async () => {
  const schema9 = toSchema9(freshState());
  const account = {
    id:'migrated-external-account', institutionId:null, externalAccountId:'foo', friendlyName:'External', officialName:'External',
    mask:'1111', type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  const transaction = {
    id:'migrated-external-transaction', accountId:account.id, source:'csv', sourceTransactionId:'shared-tx',
    rawName:'Existing', merchantName:'Existing', amountCents:-100, currency:'USD', authorizedAt:null,
    postedAt:'2026-08-01', displayDate:'2026-08-01', pendingStatus:'posted', movementType:'unclassified',
    reviewStatus:'pending', locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null,
    manualOverrides:null, createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  schema9.domain.accounts.push(account);
  schema9.domain.transactions.push(transaction);
  const migrated = migrateState(schema9, {now:V3A_NOW}).state;
  const mappingBatch = await createCsvMutationBatch({
    rows:[{
      date:'2026-08-02', description:'Mapped', amount:'2.00', account:'Mapped',
      transaction_id:'shared-tx', mask:'2222'
    }],
    producedAt:V3A_NOW,
    sourceNamespace:'csv:legacy',
    profile:{id:'legacy', accountMappings:{Mapped:'external:foo'}}
  });
  const applied = await reconcileMutationBatch(migrated, mappingBatch, {idFactory:ids(), now:V3A_NOW});
  const accounts = applied.state.domain.accounts.filter(item => item.sourceKind === 'csv');
  const transactions = applied.state.domain.transactions.filter(item => item.sourceKind === 'csv');
  assert.deepEqual(
    accounts.map(item => item.sourceAccountRef).sort(),
    ['external:foo', 'mapping:external:foo']
  );
  assert.deepEqual(
    accounts.map(item => item.sourceAccountIdentityDomain).sort(),
    [SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL, SOURCE_ACCOUNT_IDENTITY_DOMAINS.MAPPING].sort()
  );
  assert.equal(accounts.find(item => item.sourceAccountRef === 'external:foo').id, account.id);
  assert.equal(accounts.length, 2);
  assert.equal(transactions.length, 2);
  assert.equal(new Set(transactions.map(item => item.id)).size, 2);
  assert.equal(new Set(transactions.map(item => item.accountId)).size, 2);
  assert.equal(new Set(transactions.map(item => item.sourceRecordRef)).size, 1);
});

test('populated schema-9 CSV variants preserve multi-account, lifecycle, and manual history on reimport', async () => {
  const schema9 = toSchema9(freshState());
  const accountA = {
    id:'migration-account-a', institutionId:null, externalAccountId:'bank-a', friendlyName:'A', officialName:'A', mask:'1111',
    type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  const accountB = {...accountA, id:'migration-account-b', externalAccountId:'bank-b', friendlyName:'B', officialName:'B', mask:'2222'};
  const transaction = (id, accountId, sourceTransactionId, pendingStatus, date) => ({
    id, accountId, source:'csv', sourceTransactionId, rawName:null, merchantName:null, amountCents:-100,
    currency:'USD', authorizedAt:null, postedAt:date, displayDate:date, pendingStatus,
    movementType:'unclassified', reviewStatus:'pending', locationRegion:null, locationCountry:null,
    locationSource:null, providerCategory:null, manualOverrides:null, createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  const csvTransactions = [
    transaction('migration-tx-a-shared', accountA.id, 'shared-tx', 'posted', '2026-08-01'),
    transaction('migration-tx-b-shared', accountB.id, 'shared-tx', 'posted', '2026-08-02'),
    transaction('migration-tx-pending', accountA.id, 'pending-tx', 'pending', '2026-08-03'),
    transaction('migration-tx-removed', accountA.id, 'removed-tx', 'removed', '2026-08-04')
  ];
  const manualAccount = {...accountA, id:'migration-manual-account', externalAccountId:'manual-account-ref', source:'manual', friendlyName:'Manual'};
  const manualTransaction = {
    ...transaction('migration-manual-tx', manualAccount.id, 'manual-tx-ref', 'posted', '2026-08-05'),
    source:'manual'
  };
  schema9.domain.accounts.push(accountA, accountB, manualAccount);
  schema9.domain.transactions.push(...csvTransactions, manualTransaction);

  const migrated = migrateState(schema9, {now:V3A_NOW}).state;
  const batch = await createCsvMutationBatch({
    rows:[
      {date:'2026-08-01', amount:'1.00', account_name:'A', account_id:'bank-a', transaction_id:'shared-tx', mask:'1111'},
      {date:'2026-08-02', amount:'1.00', account_name:'B', account_id:'bank-b', transaction_id:'shared-tx', mask:'2222'},
      {date:'2026-08-04', amount:'1.00', account_name:'A', account_id:'bank-a', transaction_id:'removed-tx', mask:'1111'}
    ],
    producedAt:V3A_NOW,
    sourceNamespace:'csv:legacy',
    profile:{id:'legacy'}
  });
  const result = await reconcileMutationBatch(migrated, batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(result.result.counts.accountsAdded, 0);
  assert.equal(result.result.counts.transactionsAdded, 0);
  assert.equal(result.state.domain.accounts.filter(item => item.sourceKind === 'csv' && item.sourceNamespace === 'csv:legacy').length, 2);
  assert.equal(result.state.domain.transactions.filter(item => item.sourceKind === 'csv' && item.sourceNamespace === 'csv:legacy').length, 4);
  assert.deepEqual(
    result.state.domain.transactions.filter(item => item.sourceRecordRef === 'external:shared-tx').map(item => item.id).sort(),
    ['migration-tx-a-shared', 'migration-tx-b-shared']
  );
  assert.equal(result.state.domain.transactions.find(item => item.id === 'migration-tx-pending').sourceLifecycle, 'pending');
  assert.equal(result.state.domain.transactions.find(item => item.id === 'migration-tx-removed').sourceLifecycle, 'posted');
  assert.equal(result.state.domain.accounts.find(item => item.id === manualAccount.id).sourceAccountRef, 'direct:manual-account-ref');
  assert.equal(result.state.domain.transactions.find(item => item.id === manualTransaction.id).sourceRecordRef, 'manual-tx-ref');
  assert.equal(validateDomainStore(result.state.domain).ok, true);
});

test('schema-9 migration backup and restore retains canonical CSV identity for later identical reimport', async () => {
  const schema9 = toSchema9(freshState());
  const account = {
    id:'restore-migrated-account', institutionId:null, externalAccountId:'restore-account', friendlyName:'Restore', officialName:'Restore',
    mask:null, type:'depository', subtype:'checking', currency:'USD', source:'csv', active:true, balanceCents:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  const transaction = {
    id:'restore-migrated-transaction', accountId:account.id, source:'csv', sourceTransactionId:'restore-tx',
    rawName:'Restored purchase', merchantName:'Restored purchase', amountCents:-250, currency:'USD', authorizedAt:null,
    postedAt:'2026-08-06', displayDate:'2026-08-06', pendingStatus:'posted', movementType:'expense', reviewStatus:'reviewed',
    locationRegion:null, locationCountry:null, locationSource:null, providerCategory:null, manualOverrides:null,
    createdAt:V3A_NOW, updatedAt:V3A_NOW
  };
  schema9.domain.accounts.push(account);
  schema9.domain.transactions.push(transaction);
  const bucket = schema9.domain.buckets.find(item => !item.system && item.parentId === null);
  schema9.domain.allocations.push({
    id:'restore-migrated-allocation', transactionId:transaction.id, bucketId:bucket.id, subBucketId:null, amountCents:250,
    ownershipType:'mine', note:null, reimbursementClaimId:null, createdAt:V3A_NOW, updatedAt:V3A_NOW
  });
  const migrated = migrateState(schema9, {now:V3A_NOW}).state;
  const repository = createVaultRepository();
  const service = createStateService({repository, seed:freshState()});
  const passphrase = 'correct horse battery staple';
  const created = await service.create(passphrase, migrated);
  const backup = await service.exportEncryptedBackup();
  const changed = structuredClone(created.state);
  changed.preferences.monthlyIncome = 321;
  const saved = await service.save(changed, created.key, created.meta, {expectedVaultGeneration:created.vaultGeneration});
  const restored = await service.restore(backup, passphrase, {expectedVaultGeneration:saved.vaultGeneration});
  const batch = await createCsvMutationBatch({
    csvText:'date,description,amount,account,account_id,transaction_id\n2026-08-06,Restored purchase,2.50,Restore,restore-account,restore-tx',
    producedAt:V3A_NOW,
    profile:{id:'legacy'}
  });
  const reapplied = await reconcileMutationBatch(restored.state, batch, {idFactory:ids(), now:V3A_NOW});
  assert.equal(reapplied.result.counts.accountsAdded, 0);
  assert.equal(reapplied.result.counts.transactionsAdded, 0);
  assert.equal(reapplied.state.domain.accounts.find(item => item.sourceAccountRef === 'external:restore-account').id, account.id);
  const retained = reapplied.state.domain.transactions.find(item => item.sourceRecordRef === 'external:restore-tx');
  assert.equal(retained.id, transaction.id);
  assert.equal(retained.movementType, 'expense');
  assert.equal(retained.reviewStatus, 'reviewed');
  assert.equal(retained.interpretationConflictId, null);
  assert.equal(reapplied.state.domain.allocations.find(item => item.id === 'restore-migrated-allocation').transactionId, transaction.id);
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
  assert.equal(transactions[0].sourceRecordRef, 'external:shared-external-id');
  assert.equal(transactions[1].sourceRecordRef, 'external:shared-external-id');
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

test('semantic batch identity includes source-account domain while excluding observation timestamps', async () => {
  const csvText = 'date,description,amount,account,transaction_id\n2026-08-01,Coffee,1.00,Checking,semantic-tx';
  const profile = {id:'semantic-domain', accountMappings:{Checking:'foo'}};
  const mappingBatch = await createCsvMutationBatch({csvText, producedAt:V3A_NOW, profile});
  const laterMappingBatch = await createCsvMutationBatch({
    csvText,
    producedAt:'2026-08-12T16:00:00.000Z',
    profile
  });
  assert.equal(mappingBatch.payloadDigest, laterMappingBatch.payloadDigest);

  const externalBatch = structuredClone(mappingBatch);
  for (const mutation of externalBatch.accountMutations) {
    mutation.sourceAccountRef = encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL, 'foo');
    mutation.sourceAccountIdentityDomain = SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL;
  }
  for (const mutation of externalBatch.transactionMutations) {
    mutation.sourceAccountRef = encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL, 'foo');
    mutation.sourceAccountIdentityDomain = SOURCE_ACCOUNT_IDENTITY_DOMAINS.EXTERNAL;
  }
  externalBatch.payloadDigest = '';
  const finalizedExternal = await finalizeMutationBatch(externalBatch);
  assert.notEqual(mappingBatch.payloadDigest, finalizedExternal.payloadDigest);

  const applied = await reconcileMutationBatch(freshState(), mappingBatch, {idFactory:ids(), now:V3A_NOW});
  await assert.rejects(
    () => reconcileMutationBatch(applied.state, finalizedExternal, {idFactory:ids(), now:V3A_NOW}),
    error => error.code === 'BATCH_ID_COLLISION'
  );
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
