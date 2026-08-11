import assert from 'node:assert/strict';
import test from 'node:test';
import {STATE_SCHEMA_VERSION} from '../js/domain/constants.js';
import {deterministicReimbursementId, migrateState} from '../js/domain/migrations.js';
import {saveAllocationDraft} from '../js/services/allocationService.js';
import {
  projectReimbursementClaim,
  validateAuditEvent,
  validateDomainStore,
  validateReimbursementAdjustment,
  validateReimbursementClaim,
  validateReimbursementClaimAllocation,
  validateReimbursementPaymentLink
} from '../js/domain/models.js';
import {schema6ReimbursementFixtures as fixtures} from './fixtures/schema6-reimbursements.js';

const migrationNow = '2026-07-31T12:00:00.000Z';
const createdAt = '2026-07-31T12:00:00.000Z';
const updatedAt = '2026-07-31T12:01:00.000Z';

function migrate(name) {
  return migrateState(fixtures[name](), {now:migrationNow});
}

function openDomain() {
  return migrate('safeSingle').state.domain;
}

function payment(id, amountCents, overrides = {}) {
  return {
    id, claimId:'claim-single', inflowTransactionId:'repayment-target', appliedAmountCents:amountCents,
    source:'user_linked', note:null, voidedAt:null, voidReason:null, createdAt, updatedAt, ...overrides
  };
}

function addRepaymentTransaction(domain, {id = 'repayment-target', amountCents = 500, currency = 'USD', movementType = 'reimbursement'} = {}) {
  domain.transactions.push({
    id, accountId:'synthetic-account', source:'manual', sourceTransactionId:null, rawName:'Synthetic repayment', merchantName:null,
    amountCents, currency, authorizedAt:null, postedAt:'2026-07-31', displayDate:'2026-07-31', pendingStatus:'posted',
    movementType, reviewStatus:'reviewed', locationRegion:null, locationCountry:null, locationSource:null,
    providerCategory:null, manualOverrides:null, createdAt, updatedAt
  });
}

test('schema 6 to current initializes canonical collections and is clone-first, deterministic, and idempotent', () => {
  const source = fixtures.empty();
  const before = structuredClone(source);
  const first = migrateState(source, {now:migrationNow});
  const sameInput = migrateState(source, {now:migrationNow});
  const repeated = migrateState(first.state, {now:migrationNow});

  assert.deepEqual(source, before);
  assert.equal(first.fromVersion, 6);
  assert.equal(first.toVersion, STATE_SCHEMA_VERSION);
  assert.equal(first.state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(first.applied, ['v2a-reimbursement-relationship-foundation', 'v2b-desktop-beta-bucket-workflow', 'v2c-faith-money-devotional-state', 'v3a-provider-neutral-ingestion']);
  assert.deepEqual(first.state, sameInput.state);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.state, first.state);
  for (const field of ['reimbursementClaims', 'reimbursementClaimAllocations', 'reimbursementPaymentLinks', 'reimbursementAdjustments', 'auditEvents']) {
    assert.deepEqual(first.state.domain[field], []);
  }
  assert.equal(first.state.migration.appliedMigrations.at(-1), 'v3a-provider-neutral-ingestion');
  assert.deepEqual(first.state.migration.reimbursementSchema7, {convertedClaimCount:0, unresolvedClaimCount:0});
});

test('safe single-allocation migration creates one exact standalone relationship and preserves schema-6 evidence', () => {
  const source = fixtures.safeSingle();
  const originalClaim = structuredClone(source.domain.reimbursementClaims[0]);
  const result = migrateState(source, {now:migrationNow}).state;
  const claim = result.domain.reimbursementClaims[0];
  const link = result.domain.reimbursementClaimAllocations[0];

  assert.deepEqual(source.domain.reimbursementClaims[0], originalClaim);
  assert.deepEqual(claim, {
    id:'claim-single', payerLabel:'Synthetic payer', currency:'USD', dueDate:null, note:null,
    cancelledAt:null, cancellationReason:null, createdAt:originalClaim.createdAt, updatedAt:originalClaim.updatedAt
  });
  assert.deepEqual(link, {
    id:deterministicReimbursementId('reimbursement-claim-allocation', 'claim-single', 'allocation-single'),
    claimId:'claim-single', allocationId:'allocation-single', amountCents:500, createdAt:migrationNow, updatedAt:migrationNow
  });
  assert.equal(result.domain.allocations[0].reimbursementClaimId, null);
  assert.deepEqual(result.legacyFoundation.reimbursementSchema6.claims, [originalClaim]);
  assert.deepEqual(result.legacyFoundation.reimbursementSchema6.allocationPointers, [{allocationId:'allocation-single', reimbursementClaimId:'claim-single'}]);
  assert.equal(Object.hasOwn(claim, 'expectedAmountCents'), false);
  assert.equal(Object.hasOwn(claim, 'status'), false);
  assert.equal(validateDomainStore(result.domain).ok, true);
});

test('safe multi-allocation migration uses full source cents in deterministic order', () => {
  const result = migrate('safeMulti').state;
  assert.equal(result.domain.reimbursementClaims.length, 1);
  assert.deepEqual(Object.fromEntries(result.domain.reimbursementClaimAllocations.map(link => [link.allocationId, link.amountCents])), {
    'allocation-multi-a':400,
    'allocation-multi-b':600
  });
  assert.deepEqual(result.domain.reimbursementClaimAllocations.map(link => link.id),
    result.domain.reimbursementClaimAllocations.map(link => link.id).toSorted());
  assert.deepEqual(projectReimbursementClaim(result.domain, 'claim-multi'), {
    claimId:'claim-multi', expectedAmountCents:1000, receivedAmountCents:0, writtenOffAmountCents:0,
    remainingAmountCents:1000, status:'open', isOverdue:false
  });
});

test('safe embedded repayment becomes a deterministic migrated-foundation payment link', () => {
  const result = migrate('safeRepayment').state;
  const link = result.domain.reimbursementPaymentLinks[0];
  assert.equal(link.id, deterministicReimbursementId('reimbursement-payment', 'claim-single', 'repayment-safe', 500, 0));
  assert.equal(link.source, 'migrated_foundation');
  assert.equal(link.appliedAmountCents, 500);
  assert.equal(projectReimbursementClaim(result.domain, 'claim-single').status, 'settled');
});

const unresolvedCases = [
  ['ambiguousMulti', 'ambiguous_multi_allocation_distribution', 1],
  ['missingAllocation', 'missing_allocation', 1],
  ['pointerDisagreement', 'allocation_pointer_mismatch', 1],
  ['nonReimbursable', 'allocation_not_reimbursable', 1],
  ['expectedExceedsAllocation', 'expected_exceeds_allocation', 1],
  ['unknownCurrency', 'unknown_currency', 1],
  ['malformedCurrency', 'unknown_currency', 1],
  ['mixedCurrencies', 'mixed_currency', 1],
  ['duplicateRepayments', 'duplicate_repayment', 1],
  ['missingRepaymentTransaction', 'missing_repayment_transaction', 1],
  ['invalidRepaymentAmount', 'invalid_repayment_amount', 1],
  ['wrongRepaymentDirection', 'invalid_repayment_direction', 1],
  ['repaymentWrongType', 'repayment_not_reimbursement', 1],
  ['repaymentsExceedClaim', 'repayment_exceeds_claim', 1],
  ['sharedAndExcludedOwnership', 'allocation_not_reimbursable', 2],
  ['duplicateIdentifiers', 'duplicate_claim_id', 2]
];

for (const [name, reason, expectedUnresolved] of unresolvedCases) {
  test(`unsafe schema-6 fixture ${name} is preserved unresolved without partial canonical facts`, () => {
    const result = migrate(name).state;
    assert.equal(result.domain.reimbursementClaims.length, 0);
    assert.equal(result.domain.reimbursementClaimAllocations.length, 0);
    assert.equal(result.domain.reimbursementPaymentLinks.length, 0);
    assert.equal(result.legacyFoundation.unresolvedReimbursementClaims.length, expectedUnresolved);
    assert.equal(result.legacyFoundation.unresolvedReimbursementClaims.some(item => item.reasonCodes.includes(reason)), true);
    assert.equal(result.legacyFoundation.unresolvedReimbursementClaims.every(item => item.sourceSchemaVersion === 6 && item.migratedAt === migrationNow), true);
    assert.equal(validateDomainStore(result.domain).ok, true);
  });
}

test('same inflow over-applied across claims converts only the deterministic safe claim and preserves the other whole', () => {
  const first = migrate('inflowOverAppliedAcrossClaims').state;
  const second = migrate('inflowOverAppliedAcrossClaims').state;
  assert.deepEqual(first, second);
  assert.deepEqual(first.domain.reimbursementClaims.map(claim => claim.id), ['claim-a']);
  assert.equal(first.domain.reimbursementPaymentLinks.length, 1);
  assert.equal(first.legacyFoundation.unresolvedReimbursementClaims.length, 1);
  assert.deepEqual(first.legacyFoundation.unresolvedReimbursementClaims[0].reasonCodes, ['repayment_exceeds_inflow']);
});

test('the independent synthetic migration matrix yields eight safe conversions and nineteen unresolved records', () => {
  const safeNames = ['safeSingle', 'safeMulti', 'safeRepayment', 'contradictoryStatus', 'invalidCancellationEvidence', 'validCancellationEvidence', 'existingAuditEvents'];
  const safeConverted = safeNames.reduce((sum, name) => sum + migrate(name).state.migration.reimbursementSchema7.convertedClaimCount, 0);
  const unsafeUnresolved = unresolvedCases.reduce((sum, [name]) => sum + migrate(name).state.migration.reimbursementSchema7.unresolvedClaimCount, 0);
  const crossClaim = migrate('inflowOverAppliedAcrossClaims').state.migration.reimbursementSchema7;
  assert.equal(safeConverted + crossClaim.convertedClaimCount, 8);
  assert.equal(unsafeUnresolved + crossClaim.unresolvedClaimCount, 19);
});

test('malformed schema-6 currency becomes explicit unknown only after exact encrypted compatibility preservation', () => {
  const source = fixtures.malformedCurrency();
  const result = migrateState(source, {now:migrationNow}).state;
  assert.equal(source.domain.transactions[0].currency, 'usd');
  assert.equal(result.domain.transactions[0].currency, null);
  assert.deepEqual(result.legacyFoundation.reimbursementSchema6.transactionCurrencyFacts, [{
    transactionId:'expense-single', currencyFieldPresent:true, currency:'usd'
  }]);
  assert.deepEqual(result.domain.reimbursementClaims, []);
  assert.deepEqual(result.legacyFoundation.unresolvedReimbursementClaims[0].reasonCodes, ['unknown_currency']);
});

test('legacy status is evidence only, invalid cancellation is not inferred, and compatible audit events survive', () => {
  const contradictory = migrate('contradictoryStatus').state;
  assert.equal(projectReimbursementClaim(contradictory.domain, 'claim-single').status, 'open');
  assert.equal(contradictory.legacyFoundation.reimbursementSchema6.claims[0].status, 'settled');

  const invalidCancellation = migrate('invalidCancellationEvidence').state;
  assert.equal(invalidCancellation.domain.reimbursementClaims[0].cancelledAt, null);
  assert.equal(projectReimbursementClaim(invalidCancellation.domain, 'claim-single').status, 'open');
  assert.equal(invalidCancellation.legacyFoundation.reimbursementSchema6.claims[0].status, 'cancelled');

  const validCancellation = migrate('validCancellationEvidence').state;
  assert.equal(validCancellation.domain.reimbursementClaims[0].cancelledAt, '2026-07-30T13:00:00.000Z');
  assert.equal(validCancellation.domain.reimbursementClaims[0].cancellationReason, 'Synthetic cancellation');
  assert.deepEqual(validCancellation.domain.reimbursementClaimAllocations, []);
  assert.equal(projectReimbursementClaim(validCancellation.domain, 'claim-single').status, 'cancelled');

  const audited = migrate('existingAuditEvents').state;
  assert.deepEqual(audited.domain.auditEvents.map(event => event.id), ['audit-existing']);
  assert.deepEqual(audited.legacyFoundation.reimbursementSchema6.auditEvents, fixtures.existingAuditEvents().domain.auditEvents);
});

test('legacy shared and excluded ownership and unrelated state survive without claim inference', () => {
  const source = fixtures.sharedAndExcludedOwnership();
  const result = migrateState(source, {now:migrationNow}).state;
  assert.deepEqual(result.domain.allocations.map(item => item.ownershipType), ['shared', 'excluded']);
  assert.equal(result.domain.allocations.every(item => item.reimbursementClaimId === null), true);
  assert.deepEqual(result.preferences, source.preferences);
  assert.deepEqual(result.monthly, source.monthly);
  assert.deepEqual(result.travel, source.travel);
  assert.deepEqual(result.debts, source.debts);
  assert.deepEqual(result.goals, source.goals);
});

test('future schema versions remain rejected', () => {
  const future=fixtures.futureSchema();
  future.schemaVersion=STATE_SCHEMA_VERSION+1;
  assert.throws(() => migrateState(future), new RegExp(`newer than supported schema ${STATE_SCHEMA_VERSION}`));
});

test('claim validation rejects missing payer, invalid currency, unpaired cancellation, and schema-6 authority fields', () => {
  const valid = {
    id:'claim-target', payerLabel:'Synthetic payer', currency:'USD', dueDate:null, note:null,
    cancelledAt:null, cancellationReason:null, createdAt, updatedAt
  };
  assert.equal(validateReimbursementClaim(valid).ok, true);
  assert.match(validateReimbursementClaim({...valid, payerLabel:''}).errors.join(' '), /payerLabel/);
  assert.match(validateReimbursementClaim({...valid, currency:'usd'}).errors.join(' '), /currency/);
  assert.match(validateReimbursementClaim({...valid, cancelledAt:createdAt}).errors.join(' '), /both exist/);
  assert.match(validateReimbursementClaim({...valid, expectedAmountCents:100}).errors.join(' '), /legacy compatibility/);
  assert.match(validateReimbursementClaim({...valid, payerId:'payer-entity'}).errors.join(' '), /not an allowed field/);
  for (const extra of ['payerEmail', 'institutionId', 'locationCountry', 'state', 'accountId']) {
    assert.match(validateReimbursementClaim({...valid, [extra]:'fabricated'}).errors.join(' '), /not an allowed field/);
  }
});

test('claim-allocation validation enforces amount, ownership, uniqueness, direction, currency, and active claim rules', () => {
  const amount = openDomain();
  amount.reimbursementClaimAllocations[0].amountCents = 1001;
  assert.match(validateDomainStore(amount).errors.join(' '), /amount exceeds allocation/);

  const ownership = openDomain();
  ownership.allocations[0].ownershipType = 'mine';
  assert.match(validateDomainStore(ownership).errors.join(' '), /requires reimbursable/);

  const duplicate = openDomain();
  duplicate.reimbursementClaims.push({...duplicate.reimbursementClaims[0], id:'claim-second'});
  duplicate.reimbursementClaimAllocations.push({...duplicate.reimbursementClaimAllocations[0], id:'claim-allocation-second', claimId:'claim-second'});
  assert.match(validateDomainStore(duplicate).errors.join(' '), /more than one active reimbursement claim/);

  const direction = openDomain();
  direction.transactions[0].movementType = 'other';
  assert.match(validateDomainStore(direction).errors.join(' '), /expense outflow/);

  const currency = openDomain();
  currency.reimbursementClaims[0].currency = 'EUR';
  assert.match(validateDomainStore(currency).errors.join(' '), /currency does not match/);

  assert.equal(validateReimbursementClaimAllocation({id:'link', claimId:'claim', allocationId:'allocation', amountCents:1, createdAt, updatedAt}).ok, true);
});

test('payment validation enforces movement, currency, availability, claim balance, duplicate, and void metadata rules', () => {
  const wrongType = openDomain();
  addRepaymentTransaction(wrongType, {movementType:'other_inflow'});
  wrongType.reimbursementPaymentLinks.push(payment('payment-wrong', 100));
  assert.match(validateDomainStore(wrongType).errors.join(' '), /requires a reimbursement inflow/);

  const currency = openDomain();
  addRepaymentTransaction(currency, {currency:'EUR'});
  currency.reimbursementPaymentLinks.push(payment('payment-currency', 100));
  assert.match(validateDomainStore(currency).errors.join(' '), /currency does not match/);

  const inflow = openDomain();
  addRepaymentTransaction(inflow, {amountCents:300});
  inflow.reimbursementPaymentLinks.push(payment('payment-a', 200), payment('payment-b', 200, {claimId:'claim-single'}));
  assert.match(validateDomainStore(inflow).errors.join(' '), /over-applied across claims/);

  const claim = openDomain();
  addRepaymentTransaction(claim, {amountCents:600});
  claim.reimbursementPaymentLinks.push(payment('payment-too-much', 600));
  assert.match(validateDomainStore(claim).errors.join(' '), /exceed expected/);

  const duplicate = openDomain();
  addRepaymentTransaction(duplicate);
  duplicate.reimbursementPaymentLinks.push(payment('payment-duplicate-a', 100), payment('payment-duplicate-b', 100));
  assert.match(validateDomainStore(duplicate).errors.join(' '), /duplicates another active payment relationship/);

  const invalidVoid = payment('payment-void', 100, {voidedAt:createdAt});
  assert.match(validateReimbursementPaymentLink(invalidVoid).errors.join(' '), /both exist/);

  const voided = openDomain();
  addRepaymentTransaction(voided);
  voided.reimbursementPaymentLinks.push(
    payment('payment-voided', 500, {voidedAt:createdAt, voidReason:'Synthetic correction'}),
    payment('payment-voided-again', 500, {voidedAt:updatedAt, voidReason:'Second synthetic correction'})
  );
  assert.equal(validateDomainStore(voided).ok, true);
  assert.equal(projectReimbursementClaim(voided, 'claim-single').receivedAmountCents, 0);
});

test('migration treats incomplete pointers, malformed repayment fragments, and generated-ID collisions as whole unresolved claims', () => {
  for (const [name, reason] of [
    ['pointerOnlyOnClaim', 'allocation_pointer_mismatch'],
    ['pointerOnlyOnAllocation', 'allocation_pointer_mismatch'],
    ['malformedRepaymentFragment', 'malformed_claim'],
    ['relationshipIdCollision', 'relationship_id_collision']
  ]) {
    const source = fixtures[name]();
    const result = migrateState(source, {now:migrationNow}).state;
    assert.deepEqual(result.domain.reimbursementClaims, [], name);
    assert.deepEqual(result.domain.reimbursementClaimAllocations, [], name);
    assert.deepEqual(result.domain.reimbursementPaymentLinks, [], name);
    assert.deepEqual(result.domain.auditEvents, [], name);
    assert.equal(result.legacyFoundation.unresolvedReimbursementClaims.length, 1, name);
    assert.equal(result.legacyFoundation.unresolvedReimbursementClaims[0].reasonCodes.includes(reason), true, name);
    assert.deepEqual(result.legacyFoundation.reimbursementSchema6.claims, source.domain.reimbursementClaims, name);
  }

  const claimIdCollision = fixtures.inflowOverAppliedAcrossClaims();
  for (const claim of claimIdCollision.domain.reimbursementClaims) claim.repaymentLinks = [];
  const reservedClaimId = deterministicReimbursementId(
    'reimbursement-claim-allocation', 'claim-a', 'allocation-a'
  );
  claimIdCollision.domain.reimbursementClaims[1].id = reservedClaimId;
  claimIdCollision.domain.allocations[1].reimbursementClaimId = reservedClaimId;
  const collisionResult = migrateState(claimIdCollision, {now:migrationNow}).state;
  assert.deepEqual(collisionResult.domain.reimbursementClaims.map(claim => claim.id), [reservedClaimId]);
  assert.equal(collisionResult.legacyFoundation.unresolvedReimbursementClaims.length, 1);
  assert.deepEqual(collisionResult.legacyFoundation.unresolvedReimbursementClaims[0].reasonCodes, ['relationship_id_collision']);

  const competingAllocation = fixtures.inflowOverAppliedAcrossClaims();
  for (const claim of competingAllocation.domain.reimbursementClaims) claim.repaymentLinks = [];
  competingAllocation.domain.reimbursementClaims[1].allocationIds = ['allocation-a'];
  const competingResult = migrateState(competingAllocation, {now:migrationNow}).state;
  assert.deepEqual(competingResult.domain.reimbursementClaims.map(claim => claim.id), ['claim-a']);
  assert.deepEqual(competingResult.domain.reimbursementClaimAllocations.map(link => link.claimId), ['claim-a']);
  assert.equal(competingResult.legacyFoundation.unresolvedReimbursementClaims.length, 1);
  assert.equal(competingResult.legacyFoundation.unresolvedReimbursementClaims[0].reasonCodes.includes('duplicate_allocation_claim'), true);
});

test('canonical migration output and unresolved identities are stable when semantically unordered source arrays are reordered', () => {
  const source = fixtures.inflowOverAppliedAcrossClaims();
  const reordered = structuredClone(source);
  reordered.domain.reimbursementClaims.reverse();
  reordered.domain.allocations.reverse();
  reordered.domain.transactions.reverse();
  for (const claim of reordered.domain.reimbursementClaims) claim.allocationIds.reverse();

  const first = migrateState(source, {now:migrationNow}).state;
  const second = migrateState(reordered, {now:migrationNow}).state;
  for (const field of ['reimbursementClaims', 'reimbursementClaimAllocations', 'reimbursementPaymentLinks']) {
    assert.deepEqual(second.domain[field], first.domain[field], field);
  }
  assert.deepEqual(second.legacyFoundation.unresolvedReimbursementClaims, first.legacyFoundation.unresolvedReimbursementClaims);

  const payments = fixtures.safeSingle();
  const repaymentTemplate = fixtures.safeRepayment().domain.transactions.find(item => item.id === 'repayment-safe');
  payments.domain.transactions.push(
    {...structuredClone(repaymentTemplate), id:'repayment-200', amountCents:200},
    {...structuredClone(repaymentTemplate), id:'repayment-300', amountCents:300}
  );
  payments.domain.reimbursementClaims[0].repaymentLinks = [
    {transactionId:'repayment-300', amountCents:300},
    {transactionId:'repayment-200', amountCents:200}
  ];
  const paymentsReordered = structuredClone(payments);
  paymentsReordered.domain.reimbursementClaims[0].repaymentLinks.reverse();
  const migratedPayments = migrateState(payments, {now:migrationNow}).state.domain.reimbursementPaymentLinks;
  const migratedPaymentsReordered = migrateState(paymentsReordered, {now:migrationNow}).state.domain.reimbursementPaymentLinks;
  assert.deepEqual(migratedPaymentsReordered, migratedPayments);
});

test('one inflow can fund several claims and several inflows can fund one claim without over-application', () => {
  const domain = openDomain();
  domain.allocations.push({...structuredClone(domain.allocations[0]), id:'allocation-second', transactionId:'expense-second'});
  domain.transactions.push({
    ...structuredClone(domain.transactions[0]),
    id:'expense-second',
    sourceTransactionId:'expense-second',
    sourceRecordRef:'transaction:expense-second'
  });
  domain.reimbursementClaims.push({...structuredClone(domain.reimbursementClaims[0]), id:'claim-second'});
  domain.reimbursementClaimAllocations.push({
    ...structuredClone(domain.reimbursementClaimAllocations[0]), id:'claim-allocation-second', claimId:'claim-second', allocationId:'allocation-second'
  });
  addRepaymentTransaction(domain, {id:'shared-repayment', amountCents:600});
  addRepaymentTransaction(domain, {id:'second-repayment', amountCents:200});
  domain.reimbursementPaymentLinks.push(
    payment('payment-shared-a', 300, {inflowTransactionId:'shared-repayment'}),
    payment('payment-shared-b', 300, {claimId:'claim-second', inflowTransactionId:'shared-repayment'}),
    payment('payment-second', 200, {inflowTransactionId:'second-repayment'})
  );
  assert.equal(validateDomainStore(domain).ok, true);
  assert.equal(projectReimbursementClaim(domain, 'claim-single').status, 'settled');
  assert.equal(projectReimbursementClaim(domain, 'claim-second').remainingAmountCents, 200);
});

test('write-offs, reversals, derived status, and overdue projections are pure and exact', () => {
  const domain = openDomain();
  domain.reimbursementClaims[0].dueDate = '2026-07-30';
  const before = structuredClone(domain);
  assert.deepEqual(projectReimbursementClaim(domain, 'claim-single', {asOf:'2026-07-31'}), {
    claimId:'claim-single', expectedAmountCents:500, receivedAmountCents:0, writtenOffAmountCents:0,
    remainingAmountCents:500, status:'open', isOverdue:true
  });
  assert.deepEqual(domain, before);

  domain.reimbursementAdjustments.push({
    id:'write-off-1', claimId:'claim-single', type:'write_off', amountCents:500, reason:'Synthetic write-off',
    effectiveAt:createdAt, reversesAdjustmentId:null, createdAt
  });
  assert.equal(validateDomainStore(domain).ok, true);
  assert.equal(projectReimbursementClaim(domain, 'claim-single').status, 'written_off');

  domain.reimbursementAdjustments.push({
    id:'write-off-reversal-1', claimId:'claim-single', type:'write_off_reversal', amountCents:500,
    reason:'Synthetic reversal', effectiveAt:updatedAt, reversesAdjustmentId:'write-off-1', createdAt:updatedAt
  });
  assert.equal(validateDomainStore(domain).ok, true);
  assert.deepEqual(projectReimbursementClaim(domain, 'claim-single'), {
    claimId:'claim-single', expectedAmountCents:500, receivedAmountCents:0, writtenOffAmountCents:0,
    remainingAmountCents:500, status:'open', isOverdue:false
  });

  const duplicateReversal = structuredClone(domain);
  duplicateReversal.reimbursementAdjustments.push({...duplicateReversal.reimbursementAdjustments[1], id:'write-off-reversal-2'});
  assert.match(validateDomainStore(duplicateReversal).errors.join(' '), /may not be reversed more than once/);

  const excessiveWriteOff = openDomain();
  excessiveWriteOff.reimbursementAdjustments.push({
    id:'write-off-excess', claimId:'claim-single', type:'write_off', amountCents:501, reason:'Synthetic excess',
    effectiveAt:createdAt, reversesAdjustmentId:null, createdAt
  });
  assert.match(validateDomainStore(excessiveWriteOff).errors.join(' '), /exceeds collectible remaining/);

  assert.equal(validateReimbursementAdjustment({
    id:'adjustment-valid', claimId:'claim-single', type:'write_off', amountCents:1, reason:'Synthetic',
    effectiveAt:createdAt, reversesAdjustmentId:null, createdAt
  }).ok, true);
});

test('as-of projections honor payment and adjustment effective dates and adjustment chronology', () => {
  const domain = openDomain();
  addRepaymentTransaction(domain, {amountCents:200});
  domain.transactions.find(item => item.id === 'repayment-target').displayDate = '2026-07-31';
  domain.transactions.find(item => item.id === 'repayment-target').postedAt = '2026-07-31';
  domain.reimbursementPaymentLinks.push(payment('payment-dated', 200));
  domain.reimbursementAdjustments.push({
    id:'write-off-dated', claimId:'claim-single', type:'write_off', amountCents:300, reason:'Synthetic dated write-off',
    effectiveAt:'2026-08-02T12:00:00.000Z', reversesAdjustmentId:null, createdAt:'2026-08-02T12:00:00.000Z'
  });
  assert.equal(validateDomainStore(domain).ok, true);
  const before = structuredClone(domain);
  assert.deepEqual(projectReimbursementClaim(domain, 'claim-single', {asOf:'2026-07-30'}), {
    claimId:'claim-single', expectedAmountCents:500, receivedAmountCents:0, writtenOffAmountCents:0,
    remainingAmountCents:500, status:'open', isOverdue:false
  });
  assert.equal(projectReimbursementClaim(domain, 'claim-single', {asOf:'2026-07-31'}).status, 'partially_paid');
  assert.equal(projectReimbursementClaim(domain, 'claim-single', {asOf:'2026-08-02'}).status, 'written_off');
  assert.deepEqual(domain, before);

  const invalidChronology = structuredClone(domain);
  invalidChronology.reimbursementAdjustments.push({
    id:'write-off-dated-reversal', claimId:'claim-single', type:'write_off_reversal', amountCents:300,
    reason:'Synthetic invalid chronology', effectiveAt:'2026-08-01T12:00:00.000Z',
    reversesAdjustmentId:'write-off-dated', createdAt:'2026-08-03T12:00:00.000Z'
  });
  assert.match(validateDomainStore(invalidChronology).errors.join(' '), /cannot take effect before its write_off/);
});

test('partial, settled, cancelled, and invalid negative-remaining projections follow authoritative relationships', () => {
  const partial = openDomain();
  addRepaymentTransaction(partial);
  partial.reimbursementPaymentLinks.push(payment('payment-partial', 200));
  assert.equal(validateDomainStore(partial).ok, true);
  assert.deepEqual(projectReimbursementClaim(partial, 'claim-single'), {
    claimId:'claim-single', expectedAmountCents:500, receivedAmountCents:200, writtenOffAmountCents:0,
    remainingAmountCents:300, status:'partially_paid', isOverdue:false
  });

  partial.reimbursementPaymentLinks[0].appliedAmountCents = 500;
  assert.equal(projectReimbursementClaim(partial, 'claim-single').status, 'settled');

  const cancelled = openDomain();
  cancelled.reimbursementClaimAllocations = [];
  cancelled.reimbursementClaims[0].cancelledAt = createdAt;
  cancelled.reimbursementClaims[0].cancellationReason = 'Created in error';
  assert.equal(validateDomainStore(cancelled).ok, true);
  assert.equal(projectReimbursementClaim(cancelled, 'claim-single').status, 'cancelled');

  const negative = openDomain();
  addRepaymentTransaction(negative, {amountCents:600});
  negative.reimbursementPaymentLinks.push(payment('payment-negative', 600));
  assert.match(validateDomainStore(negative).errors.join(' '), /exceed expected/);
});

test('audit-event validation requires compact cent facts and excludes copied descriptive payloads', () => {
  const valid = {
    id:'audit-target', entityType:'reimbursement_claim', entityId:'claim-single', action:'validated',
    relatedEntityIds:['allocation-single'], occurredAt:createdAt, source:'migration', reason:null,
    monetaryFacts:{expectedAmountCents:500}, operationGroupId:null
  };
  assert.equal(validateAuditEvent(valid).ok, true);
  assert.match(validateAuditEvent({...valid, monetaryFacts:{merchantDescription:'Synthetic'}}).errors.join(' '), /Cents field name|safe integer cents/);
  assert.match(validateAuditEvent({...valid, providerPayload:{synthetic:true}}).errors.join(' '), /not an allowed field/);
  assert.match(validateAuditEvent({...valid, source:'automatic'}).errors.join(' '), /must be one of/);

  const matchingUnrelatedId = openDomain();
  matchingUnrelatedId.auditEvents.push({...valid, id:'expense-single'});
  assert.equal(validateDomainStore(matchingUnrelatedId).ok, true);
});

test('migration keeps invalid or unresolved audit evidence only in compatibility storage', () => {
  const source = fixtures.unresolvedMigrationAudit();
  source.domain.auditEvents.push({id:'malformed-audit', copiedPayerNote:'Synthetic private note'});
  const result = migrateState(source, {now:migrationNow}).state;
  assert.deepEqual(result.domain.auditEvents, []);
  assert.deepEqual(result.legacyFoundation.reimbursementSchema6.auditEvents, source.domain.auditEvents);
  assert.equal(result.legacyFoundation.unresolvedReimbursementClaims.length, 1);

  const malformedCollection = fixtures.empty();
  malformedCollection.domain.auditEvents = {legacyShape:'preserve exactly'};
  const malformedResult = migrateState(malformedCollection, {now:migrationNow}).state;
  assert.deepEqual(malformedResult.domain.auditEvents, []);
  assert.deepEqual(malformedResult.legacyFoundation.reimbursementSchema6.auditEvents, {legacyShape:'preserve exactly'});
});

test('relationship IDs are unique across canonical reimbursement collections and unresolved evidence is excluded from totals', () => {
  const duplicate = openDomain();
  duplicate.reimbursementClaimAllocations[0].id = 'claim-single';
  assert.match(validateDomainStore(duplicate).errors.join(' '), /duplicates reimbursementClaims id/);

  const unresolved = migrate('ambiguousMulti').state;
  assert.equal(unresolved.legacyFoundation.unresolvedReimbursementClaims.length, 1);
  assert.deepEqual(unresolved.domain.reimbursementClaims, []);
  assert.deepEqual(unresolved.domain.reimbursementClaimAllocations, []);
});

test('schema-7 claim relationships keep the existing linked-allocation edit guard active', async () => {
  const state = migrate('safeSingle').state;
  const allocation = state.domain.allocations[0];
  const rows = [{
    id:allocation.id, bucketId:allocation.bucketId, subBucketId:allocation.subBucketId,
    amountCents:allocation.amountCents, ownershipType:allocation.ownershipType, note:allocation.note
  }];
  await assert.rejects(
    () => saveAllocationDraft(state, allocation.transactionId, rows, async () => {}, {now:migrationNow}),
    error => error?.code === 'CLAIM_LINKED'
  );
});

test('schema 7 rejects deprecated embedded pointers while unclaimed allocation editing remains available', async () => {
  const invalid = migrate('safeSingle').state;
  invalid.domain.allocations[0].reimbursementClaimId = 'claim-single';
  assert.match(validateDomainStore(invalid.domain).errors.join(' '), /deprecated reimbursementClaimId/);

  const state = migrate('safeSingle').state;
  state.domain.reimbursementClaims = [];
  state.domain.reimbursementClaimAllocations = [];
  const allocation = state.domain.allocations[0];
  const rows = [{
    id:allocation.id, bucketId:allocation.bucketId, subBucketId:allocation.subBucketId,
    amountCents:allocation.amountCents, ownershipType:'mine', note:'Accepted unclaimed edit'
  }];
  const saved = await saveAllocationDraft(state, allocation.transactionId, rows, async () => {}, {now:migrationNow});
  assert.equal(saved[0].note, 'Accepted unclaimed edit');
  assert.equal(state.domain.allocations[0].reimbursementClaimId, null);
});
