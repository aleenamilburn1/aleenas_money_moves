import {UNKNOWN_ACCOUNT_ID} from '../domain/constants.js';
import {projectReimbursementClaim, validateDomainStore} from '../domain/models.js';
import {advanceStateRevision, getStateRevision} from './stateRevision.js';

export const REIMBURSEMENT_ERROR_CODES = Object.freeze({
  STALE_STATE:'STALE_STATE',
  CLAIM_NOT_FOUND:'CLAIM_NOT_FOUND',
  CLAIM_CANCELLED:'CLAIM_CANCELLED',
  CLAIM_ALREADY_CANCELLED:'CLAIM_ALREADY_CANCELLED',
  INVALID_PAYER_LABEL:'INVALID_PAYER_LABEL',
  INVALID_CURRENCY:'INVALID_CURRENCY',
  MIXED_CURRENCY:'MIXED_CURRENCY',
  ALLOCATION_NOT_FOUND:'ALLOCATION_NOT_FOUND',
  ALLOCATION_NOT_REIMBURSABLE:'ALLOCATION_NOT_REIMBURSABLE',
  ALLOCATION_ALREADY_CLAIMED:'ALLOCATION_ALREADY_CLAIMED',
  CLAIM_AMOUNT_EXCEEDS_ALLOCATION:'CLAIM_AMOUNT_EXCEEDS_ALLOCATION',
  CLAIM_AMOUNT_BELOW_SETTLED_FACTS:'CLAIM_AMOUNT_BELOW_SETTLED_FACTS',
  PAYMENT_NOT_FOUND:'PAYMENT_NOT_FOUND',
  PAYMENT_ALREADY_VOIDED:'PAYMENT_ALREADY_VOIDED',
  INVALID_REIMBURSEMENT_INFLOW:'INVALID_REIMBURSEMENT_INFLOW',
  PAYMENT_EXCEEDS_CLAIM:'PAYMENT_EXCEEDS_CLAIM',
  PAYMENT_EXCEEDS_INFLOW:'PAYMENT_EXCEEDS_INFLOW',
  WRITE_OFF_EXCEEDS_REMAINING:'WRITE_OFF_EXCEEDS_REMAINING',
  ACTIVE_PAYMENTS_PREVENT_CANCELLATION:'ACTIVE_PAYMENTS_PREVENT_CANCELLATION',
  ACTIVE_WRITE_OFFS_PREVENT_CANCELLATION:'ACTIVE_WRITE_OFFS_PREVENT_CANCELLATION',
  INVALID_ACCOUNT:'INVALID_ACCOUNT',
  PERSISTENCE_FAILED:'PERSISTENCE_FAILED',
  DOMAIN_INVALID:'DOMAIN_INVALID',
  INVALID_CLAIM_AMOUNT:'INVALID_CLAIM_AMOUNT',
  FINAL_CLAIM_ALLOCATION_REQUIRED:'FINAL_CLAIM_ALLOCATION_REQUIRED',
  DUPLICATE_PAYMENT_CLAIM:'DUPLICATE_PAYMENT_CLAIM',
  DUPLICATE_PAYMENT_ROW:'DUPLICATE_PAYMENT_ROW',
  INVALID_PAYMENT_ROW:'INVALID_PAYMENT_ROW',
  DUPLICATE_PAYMENT_LINK:'DUPLICATE_PAYMENT_LINK',
  WRITE_OFF_NOT_FOUND:'WRITE_OFF_NOT_FOUND',
  WRITE_OFF_ALREADY_REVERSED:'WRITE_OFF_ALREADY_REVERSED',
  INVALID_ADJUSTMENT_CHRONOLOGY:'INVALID_ADJUSTMENT_CHRONOLOGY',
  INVALID_REASON:'INVALID_REASON',
  INVALID_DATE:'INVALID_DATE',
  INVALID_OPERATION:'INVALID_OPERATION'
});

export class ReimbursementServiceError extends Error {
  constructor(message, code = REIMBURSEMENT_ERROR_CODES.INVALID_OPERATION, details = null) {
    super(message);
    this.name = 'ReimbursementServiceError';
    this.code = code;
    this.details = details;
  }
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const clean = value => String(value ?? '').trim();
const isCents = value => Number.isSafeInteger(value) && value > 0;
const isCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const isTimestamp = value => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function calendarDateFromInput(value) {
  if (isCalendarDate(value)) return value;
  if (isTimestamp(value)) return new Date(value).toISOString().slice(0, 10);
  return null;
}

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, snapshot);
}

function serviceError(code, message, details = null) {
  return new ReimbursementServiceError(message, code, details);
}

function domain(state) {
  const d = state?.domain;
  if (!d || !Array.isArray(d.reimbursementClaims) || !Array.isArray(d.reimbursementClaimAllocations)
    || !Array.isArray(d.reimbursementPaymentLinks) || !Array.isArray(d.reimbursementAdjustments)
    || !Array.isArray(d.auditEvents)) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.DOMAIN_INVALID, 'Reimbursement data is unavailable.');
  }
  return d;
}

function nowFrom(options) {
  const value = typeof options?.now === 'function' ? options.now() : options?.now;
  if (value !== undefined && !isTimestamp(value)) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_DATE, 'The operation timestamp is invalid.');
  }
  return value || new Date().toISOString();
}

function revisionFromDraft(draft) {
  return Number.isSafeInteger(draft?.expectedRevision) && draft.expectedRevision >= 0
    ? draft.expectedRevision
    : null;
}

function assertExpectedRevision(state, expectedRevision) {
  const currentRevision = state?.stateRevision;
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.DOMAIN_INVALID, 'The state revision is invalid.');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== currentRevision) {
    throw serviceError(
      REIMBURSEMENT_ERROR_CODES.STALE_STATE,
      'This draft is stale. Reload the latest saved state before trying again.',
      {expectedRevision, currentRevision}
    );
  }
  return currentRevision;
}

function assertDomainValid(state) {
  const validation = validateDomainStore(domain(state));
  if (!validation.ok) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.DOMAIN_INVALID, 'The reimbursement state is invalid.', {errors:validation.errors});
  }
}

function relationshipIds(d) {
  return new Set([
    ...d.reimbursementClaims,
    ...d.reimbursementClaimAllocations,
    ...d.reimbursementPaymentLinks,
    ...d.reimbursementAdjustments,
    ...d.auditEvents
  ].map(item => item.id));
}

function identifierFactory(options, d) {
  const factory = options?.idFactory || (() => crypto.randomUUID());
  const used = relationshipIds(d);
  return prefix => {
    const raw = clean(factory(prefix));
    if (!raw || used.has(raw)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_OPERATION, 'A unique operation identifier could not be created.');
    }
    used.add(raw);
    return raw;
  };
}

function audit(id, entityType, entityId, action, relatedEntityIds, occurredAt, monetaryFacts = null, operationGroupId = null, reason = null) {
  return {
    id, entityType, entityId, action, relatedEntityIds:[...new Set(relatedEntityIds)], occurredAt,
    source:'user', reason, monetaryFacts, operationGroupId
  };
}

async function mutateAtomically(state, expectedRevision, persist, options, operation) {
  if (typeof persist !== 'function') {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_OPERATION, 'A persistence callback is required.');
  }
  assertExpectedRevision(state, expectedRevision);
  assertDomainValid(state);
  const before = clone(state);
  try {
    const d = domain(state);
    const now = nowFrom(options);
    const nextId = identifierFactory(options, d);
    const result = operation({d, now, nextId});
    assertDomainValid(state);
    advanceStateRevision(state);
    try {
      await persist();
    } catch (error) {
      if (error?.code === 'VAULT_CONFLICT') throw error;
      throw new ReimbursementServiceError(
        'The reimbursement change could not be saved.',
        REIMBURSEMENT_ERROR_CODES.PERSISTENCE_FAILED
      );
    }
    return typeof result === 'function' ? result() : clone(result);
  } catch (error) {
    restoreObject(state, before);
    if (error?.code === 'VAULT_CONFLICT') throw error;
    if (error instanceof ReimbursementServiceError) throw error;
    throw new ReimbursementServiceError('The reimbursement operation failed.', REIMBURSEMENT_ERROR_CODES.DOMAIN_INVALID);
  }
}

function claimById(d, claimId, {active = false} = {}) {
  const claim = d.reimbursementClaims.find(item => item.id === claimId);
  if (!claim) throw serviceError(REIMBURSEMENT_ERROR_CODES.CLAIM_NOT_FOUND, `Claim ${claimId || '(missing)'} was not found.`);
  if (active && claim.cancelledAt !== null) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.CLAIM_CANCELLED, `Claim ${claim.id} is cancelled.`);
  }
  return claim;
}

function allocationFacts(d, allocationId, claimId = null) {
  const allocation = d.allocations.find(item => item.id === allocationId);
  if (!allocation) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.ALLOCATION_NOT_FOUND, `Allocation ${allocationId || '(missing)'} was not found.`);
  }
  if (allocation.ownershipType !== 'reimbursable') {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.ALLOCATION_NOT_REIMBURSABLE, `Allocation ${allocation.id} is not reimbursable.`);
  }
  const transaction = d.transactions.find(item => item.id === allocation.transactionId);
  if (!transaction || transaction.amountCents >= 0 || transaction.movementType !== 'expense') {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.ALLOCATION_NOT_REIMBURSABLE, `Allocation ${allocation.id} is not attached to an expense.`);
  }
  if (!isCurrency(transaction.currency)) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_CURRENCY, `Allocation ${allocation.id} has no known currency.`);
  }
  const competing = d.reimbursementClaimAllocations.find(item => item.allocationId === allocation.id && item.claimId !== claimId);
  if (competing) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.ALLOCATION_ALREADY_CLAIMED, `Allocation ${allocation.id} already belongs to claim ${competing.claimId}.`);
  }
  return {allocation, transaction};
}

function normalizeClaimRows(d, rows, claimId = null) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.FINAL_CLAIM_ALLOCATION_REQUIRED, 'A claim needs at least one allocation.');
  }
  const seen = new Set();
  let currency = null;
  return rows.map(row => {
    const allocationId = clean(row?.allocationId);
    if (!allocationId || seen.has(allocationId)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_CLAIM_AMOUNT, 'Claim allocation rows must be unique.');
    }
    seen.add(allocationId);
    const {allocation, transaction} = allocationFacts(d, allocationId, claimId);
    if (!isCents(row.amountCents)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_CLAIM_AMOUNT, `Allocation ${allocationId} needs a positive claim amount.`);
    }
    if (row.amountCents > allocation.amountCents) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.CLAIM_AMOUNT_EXCEEDS_ALLOCATION, `Claim amount exceeds allocation ${allocationId}.`);
    }
    if (currency !== null && currency !== transaction.currency) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.MIXED_CURRENCY, 'A claim cannot combine currencies.');
    }
    currency = transaction.currency;
    return {allocationId, amountCents:row.amountCents, currency};
  });
}

function validateClaimMetadata(draft) {
  if (!clean(draft?.payerLabel)) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_PAYER_LABEL, 'Enter a payer label.');
  }
  if (draft.dueDate !== null && draft.dueDate !== undefined && !isCalendarDate(draft.dueDate)) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_DATE, 'The due date is invalid.');
  }
  if (draft.note !== null && draft.note !== undefined && typeof draft.note !== 'string') {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_OPERATION, 'The claim note is invalid.');
  }
}

export function createClaimDraft(state, input = {}) {
  const d = domain(state);
  const sourceRows = Array.isArray(input.rows)
    ? input.rows
    : (Array.isArray(input.allocationIds) ? input.allocationIds.map(allocationId => ({allocationId})) : []);
  const rows = sourceRows.map(row => {
    const {allocation} = allocationFacts(d, clean(row?.allocationId));
    return {allocationId:allocation.id, amountCents:row.amountCents ?? allocation.amountCents};
  });
  return {
    expectedRevision:getStateRevision(state), payerLabel:input.payerLabel ?? '', dueDate:input.dueDate ?? null,
    note:input.note ?? null, rows
  };
}

export function validateClaimDraft(state, draft) {
  try {
    validateClaimMetadata(draft);
    const rows = normalizeClaimRows(domain(state), draft?.rows);
    return {ok:true, errors:[], currency:rows[0].currency, expectedAmountCents:rows.reduce((sum, row) => sum + row.amountCents, 0), rows};
  } catch (error) {
    if (!(error instanceof ReimbursementServiceError)) throw error;
    return {ok:false, errors:[{code:error.code, message:error.message}], currency:null, expectedAmountCents:0, rows:[]};
  }
}

export async function createClaim(state, draft, persist, options = {}) {
  return mutateAtomically(state, revisionFromDraft(draft), persist, options, ({d, now, nextId}) => {
    // Re-run against the current domain after the revision check.
    validateClaimMetadata(draft);
    const rows = normalizeClaimRows(d, draft.rows);
    const claimId = nextId('claim');
    const operationGroupId = nextId('operation-group');
    const claim = {
      id:claimId, payerLabel:clean(draft.payerLabel), currency:rows[0].currency,
      dueDate:draft.dueDate ?? null, note:clean(draft.note) || null,
      cancelledAt:null, cancellationReason:null, createdAt:now, updatedAt:now
    };
    d.reimbursementClaims.push(claim);
    const linkIds = [];
    for (const row of rows) {
      const id = nextId('claim-allocation');
      linkIds.push(id);
      d.reimbursementClaimAllocations.push({id, claimId, allocationId:row.allocationId, amountCents:row.amountCents, createdAt:now, updatedAt:now});
      d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaimAllocation', id, 'claim_allocation_created', [claimId, row.allocationId], now, {amountCents:row.amountCents}, operationGroupId));
    }
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaim', claimId, 'claim_created', linkIds, now, {expectedAmountCents:rows.reduce((sum, row) => sum + row.amountCents, 0)}, operationGroupId));
    return () => projectClaim(state, claimId);
  });
}

export function createClaimMetadataDraft(state, claimId) {
  const claim = claimById(domain(state), claimId, {active:true});
  return {expectedRevision:getStateRevision(state), claimId, payerLabel:claim.payerLabel, dueDate:claim.dueDate, note:claim.note};
}

export async function updateClaimMetadata(state, draft, persist, options = {}) {
  return mutateAtomically(state, revisionFromDraft(draft), persist, options, ({d, now, nextId}) => {
    const claim = claimById(d, draft.claimId, {active:true});
    validateClaimMetadata(draft);
    const changes = [];
    const next = {payerLabel:clean(draft.payerLabel), dueDate:draft.dueDate ?? null, note:clean(draft.note) || null};
    for (const field of ['payerLabel', 'dueDate', 'note']) if (claim[field] !== next[field]) changes.push(field);
    Object.assign(claim, next, {updatedAt:now});
    const operationGroupId = nextId('operation-group');
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaim', claim.id, 'claim_metadata_updated', [], now, null, operationGroupId, changes.join(',') || 'no_fields_changed'));
    return () => projectClaim(state, claim.id);
  });
}

export function createClaimAmountsDraft(state, claimId) {
  const d = domain(state);
  claimById(d, claimId, {active:true});
  const rows = d.reimbursementClaimAllocations.filter(item => item.claimId === claimId)
    .map(item => ({relationshipId:item.id, allocationId:item.allocationId, amountCents:item.amountCents}));
  return {expectedRevision:getStateRevision(state), claimId, rows:clone(rows)};
}

export function validateClaimAmountsDraft(state, draft) {
  try {
    const d = domain(state);
    claimById(d, draft?.claimId, {active:true});
    const rows = normalizeClaimRows(d, draft?.rows, draft?.claimId);
    const expectedAmountCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    const facts = projectReimbursementClaim(d, draft.claimId);
    const settledFactsCents = facts.receivedAmountCents + facts.writtenOffAmountCents;
    if (expectedAmountCents < settledFactsCents) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.CLAIM_AMOUNT_BELOW_SETTLED_FACTS, `Claim ${draft.claimId} cannot be reduced below ${settledFactsCents} cents.`);
    }
    return {ok:true, errors:[], rows, expectedAmountCents, settledFactsCents};
  } catch (error) {
    if (!(error instanceof ReimbursementServiceError)) throw error;
    return {ok:false, errors:[{code:error.code, message:error.message}], rows:[], expectedAmountCents:0, settledFactsCents:0};
  }
}

export async function updateClaimAmounts(state, draft, persist, options = {}) {
  return mutateAtomically(state, revisionFromDraft(draft), persist, options, ({d, now, nextId}) => {
    const claim = claimById(d, draft.claimId, {active:true});
    const validation = validateClaimAmountsDraft(state, draft);
    if (!validation.ok) throw serviceError(validation.errors[0].code, validation.errors[0].message);
    const operationGroupId = nextId('operation-group');
    const currentLinks = d.reimbursementClaimAllocations.filter(item => item.claimId === claim.id);
    const beforeExpectedAmountCents = currentLinks.reduce((sum, item) => sum + item.amountCents, 0);
    const existing = new Map(currentLinks.map(item => [item.allocationId, item]));
    const replacements = [];
    for (const row of validation.rows) {
      const prior = existing.get(row.allocationId);
      const relationship = prior
        ? {...prior, amountCents:row.amountCents, updatedAt:now}
        : {id:nextId('claim-allocation'), claimId:claim.id, allocationId:row.allocationId, amountCents:row.amountCents, createdAt:now, updatedAt:now};
      replacements.push(relationship);
      d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaimAllocation', relationship.id, prior ? 'claim_allocation_amount_updated' : 'claim_allocation_created', [claim.id, row.allocationId], now, {beforeAmountCents:prior?.amountCents || 0, afterAmountCents:row.amountCents}, operationGroupId));
      existing.delete(row.allocationId);
    }
    for (const removed of existing.values()) {
      d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaimAllocation', removed.id, 'claim_allocation_removed', [claim.id, removed.allocationId], now, {beforeAmountCents:removed.amountCents, afterAmountCents:0}, operationGroupId));
    }
    d.reimbursementClaimAllocations = [...d.reimbursementClaimAllocations.filter(item => item.claimId !== claim.id), ...replacements];
    claim.updatedAt = now;
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaim', claim.id, 'claim_amounts_updated', replacements.map(item => item.id), now, {beforeExpectedAmountCents, afterExpectedAmountCents:validation.expectedAmountCents}, operationGroupId));
    return () => projectClaim(state, claim.id);
  });
}

function activeWriteOffCents(d, claimId) {
  const items = d.reimbursementAdjustments.filter(item => item.claimId === claimId);
  return items.filter(item => item.type === 'write_off').reduce((sum, item) => sum + item.amountCents, 0)
    - items.filter(item => item.type === 'write_off_reversal').reduce((sum, item) => sum + item.amountCents, 0);
}

export async function cancelClaim(state, input, persist, options = {}) {
  return mutateAtomically(state, input?.expectedRevision, persist, options, ({d, now, nextId}) => {
    const claim = claimById(d, input?.claimId);
    if (claim.cancelledAt !== null) throw serviceError(REIMBURSEMENT_ERROR_CODES.CLAIM_ALREADY_CANCELLED, `Claim ${claim.id} is already cancelled.`);
    const reason = clean(input?.reason);
    if (!reason) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_REASON, 'A cancellation reason is required.');
    if (d.reimbursementPaymentLinks.some(item => item.claimId === claim.id && item.voidedAt === null)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.ACTIVE_PAYMENTS_PREVENT_CANCELLATION, `Claim ${claim.id} has active payments.`);
    }
    if (activeWriteOffCents(d, claim.id) !== 0) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.ACTIVE_WRITE_OFFS_PREVENT_CANCELLATION, `Claim ${claim.id} has active write-offs.`);
    }
    const operationGroupId = nextId('operation-group');
    const removed = d.reimbursementClaimAllocations.filter(item => item.claimId === claim.id);
    d.reimbursementClaimAllocations = d.reimbursementClaimAllocations.filter(item => item.claimId !== claim.id);
    claim.cancelledAt = now;
    claim.cancellationReason = reason;
    claim.updatedAt = now;
    for (const link of removed) {
      d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaimAllocation', link.id, 'claim_allocation_removed_on_cancellation', [claim.id, link.allocationId], now, {amountCents:link.amountCents}, operationGroupId));
    }
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementClaim', claim.id, 'claim_cancelled', removed.map(item => item.id), now, {expectedAmountCents:removed.reduce((sum, item) => sum + item.amountCents, 0)}, operationGroupId));
    return () => projectClaim(state, claim.id);
  });
}

export function createWriteOffDraft(state, claimId, input = {}) {
  const projection = projectClaim(state, claimId, {asOf:input.asOf ?? null});
  if (projection.status === 'cancelled') throw serviceError(REIMBURSEMENT_ERROR_CODES.CLAIM_CANCELLED, `Claim ${claimId} is cancelled.`);
  return {
    expectedRevision:getStateRevision(state), claimId, amountCents:input.amountCents ?? projection.remainingAmountCents,
    reason:input.reason ?? '', effectiveAt:input.effectiveAt ?? null
  };
}

export async function createWriteOff(state, draft, persist, options = {}) {
  return mutateAtomically(state, revisionFromDraft(draft), persist, options, ({d, now, nextId}) => {
    const claim = claimById(d, draft?.claimId, {active:true});
    const reason = clean(draft?.reason);
    if (!reason) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_REASON, 'A write-off reason is required.');
    const effectiveAt = draft?.effectiveAt;
    if (!isTimestamp(effectiveAt)) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_DATE, 'The write-off date is invalid.');
    const remaining = projectReimbursementClaim(d, claim.id).remainingAmountCents;
    if (!isCents(draft?.amountCents) || draft.amountCents > remaining) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.WRITE_OFF_EXCEEDS_REMAINING, `Write-off exceeds the ${remaining}-cent remaining amount for claim ${claim.id}.`);
    }
    const operationGroupId = nextId('operation-group');
    const id = nextId('adjustment');
    d.reimbursementAdjustments.push({id, claimId:claim.id, type:'write_off', amountCents:draft.amountCents, reason, effectiveAt, reversesAdjustmentId:null, createdAt:now});
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementAdjustment', id, 'write_off_created', [claim.id], now, {amountCents:draft.amountCents}, operationGroupId));
    claim.updatedAt = now;
    return () => projectClaim(state, claim.id);
  });
}

export async function reverseWriteOff(state, input, persist, options = {}) {
  return mutateAtomically(state, input?.expectedRevision, persist, options, ({d, now, nextId}) => {
    const original = d.reimbursementAdjustments.find(item => item.id === input?.adjustmentId && item.type === 'write_off');
    if (!original) throw serviceError(REIMBURSEMENT_ERROR_CODES.WRITE_OFF_NOT_FOUND, `Write-off ${input?.adjustmentId || '(missing)'} was not found.`);
    const claim = claimById(d, original.claimId, {active:true});
    if (d.reimbursementAdjustments.some(item => item.type === 'write_off_reversal' && item.reversesAdjustmentId === original.id)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.WRITE_OFF_ALREADY_REVERSED, `Write-off ${original.id} is already reversed.`);
    }
    const reason = clean(input?.reason);
    if (!reason) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_REASON, 'A reversal reason is required.');
    const amountCents = input?.amountCents ?? original.amountCents;
    const effectiveAt = input?.effectiveAt;
    if (!isCents(amountCents) || amountCents > original.amountCents || !isTimestamp(effectiveAt)
      || Date.parse(effectiveAt) < Date.parse(original.effectiveAt) || Date.parse(now) < Date.parse(original.createdAt)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_ADJUSTMENT_CHRONOLOGY, `Write-off ${original.id} cannot be reversed with these facts.`);
    }
    const operationGroupId = nextId('operation-group');
    const id = nextId('adjustment');
    d.reimbursementAdjustments.push({id, claimId:claim.id, type:'write_off_reversal', amountCents, reason, effectiveAt, reversesAdjustmentId:original.id, createdAt:now});
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementAdjustment', id, 'write_off_reversed', [claim.id, original.id], now, {amountCents}, operationGroupId));
    claim.updatedAt = now;
    return () => projectClaim(state, claim.id);
  });
}

function reimbursementInflow(d, inflowTransactionId) {
  const transaction = d.transactions.find(item => item.id === inflowTransactionId);
  if (!transaction || transaction.amountCents <= 0 || transaction.movementType !== 'reimbursement' || !isCurrency(transaction.currency)) {
    throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_REIMBURSEMENT_INFLOW, `Transaction ${inflowTransactionId || '(missing)'} is not a valid reimbursement inflow.`);
  }
  return transaction;
}

function activeInflowApplied(d, inflowTransactionId) {
  return d.reimbursementPaymentLinks.filter(item => item.inflowTransactionId === inflowTransactionId && item.voidedAt === null)
    .reduce((sum, item) => sum + item.appliedAmountCents, 0);
}

export function projectInflowAvailability(state, inflowTransactionId, {asOf = null} = {}) {
  const d = domain(state);
  const transaction = reimbursementInflow(d, inflowTransactionId);
  if (asOf !== null && !isCalendarDate(asOf)) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_DATE, 'The as-of date is invalid.');
  const date = transactionCalendarDate(transaction);
  const effective = asOf === null || (date !== null && date <= asOf);
  const appliedAmountCents = effective ? activeInflowApplied(d, transaction.id) : 0;
  const inflowAmountCents = effective ? transaction.amountCents : 0;
  return {inflowTransactionId:transaction.id, currency:transaction.currency, inflowAmountCents, appliedAmountCents, availableAmountCents:inflowAmountCents - appliedAmountCents, effectiveDate:date};
}

function transactionCalendarDate(transaction) {
  for (const value of [transaction?.displayDate, transaction?.postedAt, transaction?.authorizedAt]) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) continue;
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
  }
  return null;
}

export function createPaymentDistributionDraft(state, inflowTransactionId, input = {}) {
  reimbursementInflow(domain(state), inflowTransactionId);
  const rows = clone(input.rows || []).map(row => ({...row, id:row?.id ?? crypto.randomUUID()}));
  return {expectedRevision:getStateRevision(state), inflowTransactionId, source:input.source ?? 'user_linked', rows};
}

export function validatePaymentDistribution(state, draft) {
  try {
    const d = domain(state);
    const inflow = reimbursementInflow(d, draft?.inflowTransactionId);
    if (!['user_linked', 'suggestion_confirmed'].includes(draft?.source)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_OPERATION, 'The payment-link source is invalid.');
    }
    if (!Array.isArray(draft?.rows) || draft.rows.length === 0) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_CLAIM_AMOUNT, 'Add at least one payment distribution row.');
    }
    const seenRows = new Set();
    const seenClaims = new Set();
    let totalAmountCents = 0;
    const rows = draft.rows.map(row => {
      const id = clean(row?.id);
      if (!id) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_PAYMENT_ROW, 'Each payment distribution row needs an identifier.');
      if (seenRows.has(id)) throw serviceError(REIMBURSEMENT_ERROR_CODES.DUPLICATE_PAYMENT_ROW, `Payment distribution row ${id} appears more than once.`);
      seenRows.add(id);
      const claimId = clean(row?.claimId);
      if (!claimId || seenClaims.has(claimId)) throw serviceError(REIMBURSEMENT_ERROR_CODES.DUPLICATE_PAYMENT_CLAIM, 'Each claim may appear once in a distribution.');
      seenClaims.add(claimId);
      const claim = claimById(d, claimId, {active:true});
      if (claim.currency !== inflow.currency) throw serviceError(REIMBURSEMENT_ERROR_CODES.MIXED_CURRENCY, `Claim ${claim.id} does not match inflow currency.`);
      if (!isCents(row?.amountCents)) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_CLAIM_AMOUNT, `Claim ${claim.id} needs a positive payment amount.`);
      if (d.reimbursementPaymentLinks.some(item => item.voidedAt === null && item.claimId === claim.id
        && item.inflowTransactionId === inflow.id && item.appliedAmountCents === row.amountCents)) {
        throw serviceError(REIMBURSEMENT_ERROR_CODES.DUPLICATE_PAYMENT_LINK, `Claim ${claim.id} already has this active payment link.`);
      }
      const remaining = projectReimbursementClaim(d, claim.id).remainingAmountCents;
      if (row.amountCents > remaining) throw serviceError(REIMBURSEMENT_ERROR_CODES.PAYMENT_EXCEEDS_CLAIM, `Payment exceeds the ${remaining}-cent remaining amount for claim ${claim.id}.`);
      totalAmountCents += row.amountCents;
      return {id, claimId, amountCents:row.amountCents, note:clean(row.note) || null};
    });
    const availableAmountCents = inflow.amountCents - activeInflowApplied(d, inflow.id);
    if (totalAmountCents > availableAmountCents) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.PAYMENT_EXCEEDS_INFLOW, `Distribution exceeds the ${availableAmountCents}-cent available inflow amount.`);
    }
    return {ok:true, errors:[], rows, totalAmountCents, availableAmountCents, remainingInflowAmountCents:availableAmountCents - totalAmountCents, currency:inflow.currency};
  } catch (error) {
    if (!(error instanceof ReimbursementServiceError)) throw error;
    return {ok:false, errors:[{code:error.code, message:error.message}], rows:[], totalAmountCents:0, availableAmountCents:0, remainingInflowAmountCents:0, currency:null};
  }
}

export async function applyPaymentDistribution(state, draft, persist, options = {}) {
  return mutateAtomically(state, revisionFromDraft(draft), persist, options, ({d, now, nextId}) => {
    const validation = validatePaymentDistribution(state, draft);
    if (!validation.ok) throw serviceError(validation.errors[0].code, validation.errors[0].message);
    const operationGroupId = nextId('operation-group');
    const links = validation.rows.map(row => {
      const id = nextId('payment-link');
      const link = {id, claimId:row.claimId, inflowTransactionId:draft.inflowTransactionId, appliedAmountCents:row.amountCents, source:draft.source, note:row.note, voidedAt:null, voidReason:null, createdAt:now, updatedAt:now};
      d.reimbursementPaymentLinks.push(link);
      d.auditEvents.push(audit(nextId('audit'), 'reimbursementPaymentLink', id, 'payment_linked', [row.claimId, draft.inflowTransactionId], now, {appliedAmountCents:row.amountCents}, operationGroupId));
      return link;
    });
    for (const row of validation.rows) claimById(d, row.claimId).updatedAt = now;
    return () => ({links:clone(links), inflow:projectInflowAvailability(state, draft.inflowTransactionId), claims:validation.rows.map(row => projectClaim(state, row.claimId))});
  });
}

export async function voidPaymentLink(state, input, persist, options = {}) {
  return mutateAtomically(state, input?.expectedRevision, persist, options, ({d, now, nextId}) => {
    const link = d.reimbursementPaymentLinks.find(item => item.id === input?.paymentLinkId);
    if (!link) throw serviceError(REIMBURSEMENT_ERROR_CODES.PAYMENT_NOT_FOUND, `Payment link ${input?.paymentLinkId || '(missing)'} was not found.`);
    if (link.voidedAt !== null) throw serviceError(REIMBURSEMENT_ERROR_CODES.PAYMENT_ALREADY_VOIDED, `Payment link ${link.id} is already voided.`);
    const reason = clean(input?.reason);
    if (!reason) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_REASON, 'A void reason is required.');
    link.voidedAt = now;
    link.voidReason = reason;
    link.updatedAt = now;
    claimById(d, link.claimId).updatedAt = now;
    const operationGroupId = nextId('operation-group');
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementPaymentLink', link.id, 'payment_link_voided', [link.claimId, link.inflowTransactionId], now, {appliedAmountCents:link.appliedAmountCents}, operationGroupId));
    return () => ({link:clone(link), claim:projectClaim(state, link.claimId), inflow:projectInflowAvailability(state, link.inflowTransactionId)});
  });
}

export function createManualRepaymentDraft(state, claimId, input = {}) {
  const claim = claimById(domain(state), claimId, {active:true});
  const remaining = projectReimbursementClaim(domain(state), claim.id).remainingAmountCents;
  return {
    expectedRevision:getStateRevision(state), claimId, amountCents:input.amountCents ?? remaining,
    date:input.date ?? null, accountId:input.accountId ?? UNKNOWN_ACCOUNT_ID, note:input.note ?? null
  };
}

export async function recordManualRepayment(state, draft, persist, options = {}) {
  return mutateAtomically(state, revisionFromDraft(draft), persist, options, ({d, now, nextId}) => {
    const claim = claimById(d, draft?.claimId, {active:true});
    const remaining = projectReimbursementClaim(d, claim.id).remainingAmountCents;
    if (!isCents(draft?.amountCents) || draft.amountCents > remaining) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.PAYMENT_EXCEEDS_CLAIM, `Manual repayment exceeds the ${remaining}-cent remaining amount for claim ${claim.id}.`);
    }
    const repaymentDate = calendarDateFromInput(draft?.date);
    if (!repaymentDate) throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_DATE, 'The repayment date is invalid.');
    const accountId = clean(draft?.accountId) || UNKNOWN_ACCOUNT_ID;
    const account = d.accounts.find(item => item.id === accountId);
    if (!account || (account.id !== UNKNOWN_ACCOUNT_ID && account.currency !== claim.currency)) {
      throw serviceError(REIMBURSEMENT_ERROR_CODES.INVALID_ACCOUNT, `Account ${accountId} cannot receive this reimbursement.`);
    }
    const operationGroupId = nextId('operation-group');
    const transactionId = nextId('transaction');
    const linkId = nextId('payment-link');
    const transaction = {
      id:transactionId, accountId, source:'manual', sourceTransactionId:null, rawName:'Manual reimbursement',
      merchantName:null, amountCents:draft.amountCents, currency:claim.currency, authorizedAt:null,
      postedAt:repaymentDate, displayDate:repaymentDate, pendingStatus:'posted', movementType:'reimbursement',
      reviewStatus:'reviewed', locationRegion:null, locationCountry:null, locationSource:null,
      providerCategory:null, manualOverrides:{reimbursementEntry:true}, createdAt:now, updatedAt:now
    };
    const link = {
      id:linkId, claimId:claim.id, inflowTransactionId:transactionId, appliedAmountCents:draft.amountCents,
      source:'user_linked', note:clean(draft.note) || null, voidedAt:null, voidReason:null, createdAt:now, updatedAt:now
    };
    d.transactions.push(transaction);
    d.reimbursementPaymentLinks.push(link);
    claim.updatedAt = now;
    d.auditEvents.push(audit(nextId('audit'), 'transaction', transactionId, 'manual_repayment_created', [claim.id, linkId], now, {amountCents:draft.amountCents}, operationGroupId));
    d.auditEvents.push(audit(nextId('audit'), 'reimbursementPaymentLink', linkId, 'payment_linked', [claim.id, transactionId], now, {appliedAmountCents:draft.amountCents}, operationGroupId));
    return () => ({transaction:clone(transaction), link:clone(link), claim:projectClaim(state, claim.id)});
  });
}

export function projectClaim(state, claimId, {asOf = null} = {}) {
  const d = domain(state);
  const claim = claimById(d, claimId);
  const projection = projectReimbursementClaim(d, claimId, {asOf});
  const needsResolution = (d.interpretationConflicts || []).some(item => item.status === 'unresolved' && item.relatedClaimIds?.includes(claimId));
  return {
    ...clone(claim), ...projection, needsResolution,
    allocationLinks:clone(d.reimbursementClaimAllocations.filter(item => item.claimId === claimId)),
    paymentLinks:clone(d.reimbursementPaymentLinks.filter(item => item.claimId === claimId)),
    adjustments:clone(d.reimbursementAdjustments.filter(item => item.claimId === claimId))
  };
}

export function projectClaims(state, {asOf = null} = {}) {
  return domain(state).reimbursementClaims.map(claim => projectClaim(state, claim.id, {asOf}));
}

export function projectOpenClaims(state, options = {}) {
  return projectClaims(state, options).filter(item => !item.needsResolution && (item.status === 'open' || item.status === 'partially_paid'));
}

export function projectSettledClaims(state, options = {}) {
  return projectClaims(state, options).filter(item => item.status === 'settled' || item.status === 'written_off');
}

export function projectCancelledClaims(state, options = {}) {
  return projectClaims(state, options).filter(item => item.status === 'cancelled');
}

export function projectClaimsNeedingResolution(state) {
  const legacy = clone(state?.legacyFoundation?.unresolvedReimbursementClaims || []).map(item => ({
    id:item.id, status:'needs_resolution', reasonCodes:clone(item.reasonCodes || []), sourceSchemaVersion:item.sourceSchemaVersion,
    migratedAt:item.migratedAt, originalClaimId:clean(item.originalClaim?.id) || null
  }));
  const ingestion = (domain(state).interpretationConflicts || []).filter(item => item.status === 'unresolved')
    .flatMap(item => (item.relatedClaimIds || []).map(claimId => ({
      id:`${item.id}:${claimId}`, status:'needs_resolution', reasonCodes:[item.kind], sourceSchemaVersion:null,
      migratedAt:item.createdAt, originalClaimId:claimId
    })));
  return [...legacy, ...ingestion];
}

export function projectUnmatchedReimbursementInflows(state, {asOf = null} = {}) {
  return domain(state).transactions
    .filter(item => item.amountCents > 0 && item.movementType === 'reimbursement' && item.sourceLifecycle !== 'removed' && item.pendingStatus !== 'removed')
    .map(item => projectInflowAvailability(state, item.id, {asOf}))
    .filter(item => item.availableAmountCents > 0);
}

export function aggregateOutstandingReimbursement(state, {asOf = null} = {}) {
  const claims = projectOpenClaims(state, {asOf});
  return {
    outstandingAmountCents:claims.reduce((sum, claim) => sum + claim.remainingAmountCents, 0),
    claimCount:claims.length,
    asOf
  };
}
