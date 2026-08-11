import {DEFAULT_CURRENCY, UNKNOWN_ACCOUNT_ID} from '../domain/constants.js';
import {isAllocationActive, isTransactionActiveForReporting, validateAllocation, validateDomainStore} from '../domain/models.js';
import {advanceStateRevision} from './stateRevision.js';

export class AllocationOperationError extends Error {
  constructor(message, code = 'ALLOCATION_OPERATION_FAILED', validation = null) {
    super(message);
    this.name = 'AllocationOperationError';
    this.code = code;
    this.validation = validation;
  }
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const clean = value => String(value ?? '').trim();

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, snapshot);
}

function hash(value) {
  let result = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function domain(state) {
  if (!state?.domain || !Array.isArray(state.domain.transactions) || !Array.isArray(state.domain.allocations)) {
    throw new AllocationOperationError('Allocation data is unavailable.', 'INVALID_STATE');
  }
  return state.domain;
}

function legacyTransaction(state, transactionId) {
  return (state.review?.transactions || []).find(item => item.id === transactionId) || null;
}

function timestamp(value, fallback) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function validDate(value) {
  const candidate = clean(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) && !Number.isNaN(Date.parse(`${candidate}T12:00:00.000Z`)) ? candidate : null;
}

function legacyAmountCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : 0;
}

function reviewStatus(value) {
  return ['pending', 'suggested', 'deferred', 'reviewed', 'needs_resolution'].includes(value) ? value : 'pending';
}

export function deterministicAllocationId(transactionId, bucketId, subBucketId = null) {
  return `allocation-v1-${hash(`${transactionId}|${bucketId}|${subBucketId || ''}`)}`;
}

export function canonicalTransactionFromLegacy(legacy, {now = '1970-01-01T00:00:00.000Z', accountId = UNKNOWN_ACCOUNT_ID} = {}) {
  const id = clean(legacy?.id);
  const magnitude = legacyAmountCents(legacy?.amount);
  if (!id || !magnitude) return null;
  const inflow = legacy.flow === 'inflow';
  const transfer = legacy.flow === 'transfer';
  const date = validDate(legacy.date);
  const createdAt = timestamp(legacy.importedAt, now);
  return {
    id,
    accountId:clean(accountId) || UNKNOWN_ACCOUNT_ID,
    source:'migration',
    sourceTransactionId:clean(legacy.transactionId) || null,
    rawName:clean(legacy.name || legacy.merchant) || null,
    merchantName:clean(legacy.merchant || legacy.name) || null,
    amountCents:inflow ? magnitude : -magnitude,
    currency:DEFAULT_CURRENCY,
    authorizedAt:null,
    postedAt:date,
    displayDate:date,
    pendingStatus:legacy.pending === true ? 'pending' : 'posted',
    movementType:transfer ? 'internal_transfer' : (inflow ? 'other_inflow' : 'expense'),
    reviewStatus:reviewStatus(legacy.reviewStatus),
    locationRegion:clean(legacy.locationRegion || legacy.state) || null,
    locationCountry:clean(legacy.locationCountry || legacy.country) || null,
    locationSource:null,
    providerCategory:clean(legacy.providerCategory) || null,
    manualOverrides:null,
    createdAt,
    updatedAt:createdAt
  };
}

export function parseCurrencyToCents(value) {
  const text = clean(value).replace(/[$,\s]/g, '');
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function getTransactionContext(state, transactionId) {
  const canonical = domain(state).transactions.find(item => item.id === transactionId) || null;
  const legacy = legacyTransaction(state, transactionId);
  if (!canonical && !legacy) throw new AllocationOperationError('Transaction not found.', 'TRANSACTION_NOT_FOUND');
  const magnitudeCents = canonical ? Math.abs(canonical.amountCents) : legacyAmountCents(legacy.amount);
  if (!magnitudeCents) throw new AllocationOperationError('Transaction amount must be greater than zero.', 'INVALID_TRANSACTION_AMOUNT');
  return {canonical, legacy, magnitudeCents};
}

function bucketSelection(state, selectedId) {
  const selected = domain(state).buckets.find(item => item.id === selectedId);
  if (!selected) return {bucketId:selectedId || '', subBucketId:null};
  return selected.parentId ? {bucketId:selected.parentId, subBucketId:selected.id} : {bucketId:selected.id, subBucketId:null};
}

function bucketSemanticType(bucket) {
  return bucket?.semanticType || 'spending';
}

function movementTypeForSemanticType(semanticType) {
  if (semanticType === 'income') return 'earned_income';
  if (semanticType === 'transfer') return 'internal_transfer';
  if (semanticType === 'debt_payment') return 'debt_payment';
  return 'expense';
}

function legacyFlowForSemanticType(semanticType) {
  if (semanticType === 'income') return 'inflow';
  if (semanticType === 'transfer') return 'transfer';
  return 'outflow';
}

function newId(idFactory) {
  const id = typeof idFactory === 'function' ? clean(idFactory()) : '';
  if (!id) throw new AllocationOperationError('Could not create an allocation identifier.', 'INVALID_ALLOCATION_ID');
  return id;
}

export function getTransactionAllocations(state, transactionId) {
  return domain(state).allocations.filter(item => item.transactionId === transactionId && isAllocationActive(item))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map(clone);
}

export function createAllocationDraft(state, transactionId, {idFactory = () => crypto.randomUUID()} = {}) {
  const context = getTransactionContext(state, transactionId);
  const existing = getTransactionAllocations(state, transactionId);
  let rows = existing.map(item => ({
    id:item.id, bucketId:item.bucketId, subBucketId:item.subBucketId, amountCents:item.amountCents,
    ownershipType:item.ownershipType === 'personal' ? 'mine' : item.ownershipType,
    note:item.note || '', createdAt:item.createdAt
  }));
  if (!rows.length) {
    const selection = bucketSelection(state, context.legacy?.bucketId || '');
    const id = selection.bucketId
      ? deterministicAllocationId(transactionId, selection.bucketId, selection.subBucketId)
      : newId(idFactory);
    rows = [{id, ...selection, amountCents:context.magnitudeCents, ownershipType:'mine', note:'', createdAt:null}];
  }
  return {transactionId, magnitudeCents:context.magnitudeCents, rows};
}

export function addAllocationDraftRow(draft, {idFactory = () => crypto.randomUUID()} = {}) {
  const allocated = draft.rows.reduce((sum, item) => sum + (Number.isSafeInteger(item.amountCents) ? item.amountCents : 0), 0);
  const remaining = Math.max(0, draft.magnitudeCents - allocated);
  draft.rows.push({id:newId(idFactory), bucketId:'', subBucketId:null, amountCents:remaining, ownershipType:'mine', note:'', createdAt:null});
  return draft.rows.at(-1).id;
}

export function allocationTotals(rows) {
  return rows.reduce((totals, row) => {
    const amount = Number.isSafeInteger(row.amountCents) ? row.amountCents : 0;
    totals.grossCents += amount;
    if (row.ownershipType === 'reimbursable') totals.reimbursableCents += amount;
    else totals.mineCents += amount;
    return totals;
  }, {grossCents:0, mineCents:0, reimbursableCents:0});
}

export function validateAllocationDraft(state, transactionId, rows) {
  const context = getTransactionContext(state, transactionId);
  const candidateRows = Array.isArray(rows) ? rows : [];
  const errors = [];
  const rowErrors = candidateRows.map(() => []);
  const ids = new Set();
  const currentById = new Map(getTransactionAllocations(state, transactionId).map(item => [item.id, item]));
  if (!candidateRows.length) errors.push('Add at least one allocation.');
  for (const [index, row] of candidateRows.entries()) {
    if (!clean(row.id) || ids.has(row.id)) rowErrors[index].push('Allocation IDs must be present and unique.');
    ids.add(row.id);
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0) rowErrors[index].push('Enter an amount greater than $0.00.');
    if (!['mine', 'reimbursable'].includes(row.ownershipType)) rowErrors[index].push('Choose Mine or Reimbursable.');
    const parent = domain(state).buckets.find(item => item.id === row.bucketId);
    if (!parent || parent.parentId) rowErrors[index].push('Choose a bucket for every allocation.');
    const child = row.subBucketId ? domain(state).buckets.find(item => item.id === row.subBucketId) : null;
    if (row.subBucketId && (!child || child.parentId !== row.bucketId)) rowErrors[index].push('The child bucket must belong to the selected parent.');
    const prior = currentById.get(row.id);
    if (parent?.active === false && (!prior || prior.bucketId !== row.bucketId)) rowErrors[index].push('Choose an active parent bucket.');
    if (child?.active === false && (!prior || prior.subBucketId !== row.subBucketId)) rowErrors[index].push('Choose an active child bucket.');
    if (bucketSemanticType(parent) !== 'spending') {
      if (!parent.system) rowErrors[index].push('Only protected system classifications may use a special transaction type.');
      if (row.subBucketId) rowErrors[index].push('System classifications cannot use a child bucket.');
    }
  }
  const semanticParents = candidateRows.filter(row => {
    const parent = domain(state).buckets.find(item => item.id === row.bucketId);
    return bucketSemanticType(parent) !== 'spending';
  });
  if (semanticParents.length && candidateRows.length !== 1) {
    errors.push('Income, money transfers, and debt payments must use one full transaction classification.');
  }
  if (rowErrors.some(items => items.some(message => message === 'Choose a bucket for every allocation.'))) {
    errors.push('Choose a bucket for every allocation.');
  }
  for (const message of rowErrors.flat()) if (!errors.includes(message)) errors.push(message);
  const totals = allocationTotals(candidateRows);
  const balanceCents = context.magnitudeCents - totals.grossCents;
  if (balanceCents > 0) errors.push(`${formatCurrencyCents(balanceCents)} remains to be allocated.`);
  if (balanceCents < 0) errors.push(`Allocations exceed the transaction by ${formatCurrencyCents(Math.abs(balanceCents))}.`);
  return {ok:errors.length === 0, errors, rowErrors, balanceCents, magnitudeCents:context.magnitudeCents, ...totals};
}

export function formatCurrencyCents(value, currency = DEFAULT_CURRENCY) {
  return new Intl.NumberFormat('en-US', {style:'currency', currency}).format(Number(value || 0) / 100);
}

function persistedAllocations(state, transactionId, rows, now) {
  const existing = new Map(getTransactionAllocations(state, transactionId).map(item => [item.id, item]));
  return rows.map(row => {
    const prior = existing.get(row.id);
    const allocation = {
      id:row.id,
      transactionId,
      bucketId:row.bucketId,
      subBucketId:row.subBucketId || null,
      amountCents:row.amountCents,
      ownershipType:row.ownershipType,
      note:clean(row.note) || null,
      // Schema 7 claim authority lives only in reimbursementClaimAllocations.
      reimbursementClaimId:null,
      createdAt:prior?.createdAt || now,
      updatedAt:now
    };
    const validation = validateAllocation(allocation);
    if (!validation.ok) throw new AllocationOperationError(validation.errors.join('; '), 'INVALID_ALLOCATION');
    return allocation;
  });
}

function ensureCanonicalTransaction(state, transactionId, now) {
  const d = domain(state);
  let transaction = d.transactions.find(item => item.id === transactionId);
  if (transaction) return transaction;
  const legacy = legacyTransaction(state, transactionId);
  transaction = canonicalTransactionFromLegacy(legacy, {now});
  if (!transaction) throw new AllocationOperationError('This transaction cannot be converted safely.', 'UNTRACEABLE_TRANSACTION');
  d.transactions.push(transaction);
  return transaction;
}

export async function saveAllocationDraft(state, transactionId, rows, persist, options = {}) {
  if (typeof persist !== 'function') throw new AllocationOperationError('A persistence callback is required.', 'INVALID_OPERATION');
  const validation = validateAllocationDraft(state, transactionId, rows);
  if (!validation.ok) throw new AllocationOperationError(validation.errors[0], 'INVALID_ALLOCATION_SET', validation);
  const before = clone(state);
  try {
    const now = timestamp(options.now, new Date().toISOString());
    const d = domain(state);
    const existing = d.allocations.filter(item => item.transactionId === transactionId);
    const canonicalClaimAllocationIds = new Set((d.reimbursementClaimAllocations || []).map(item => item.allocationId));
    if (existing.some(item => canonicalClaimAllocationIds.has(item.id))) {
      throw new AllocationOperationError('Allocations linked to a reimbursement claim cannot be edited in this phase.', 'CLAIM_LINKED');
    }
    const transaction = ensureCanonicalTransaction(state, transactionId, now);
    const replacements = persistedAllocations(state, transactionId, rows, now);
    d.allocations = [...d.allocations.filter(item => item.transactionId !== transactionId || !isAllocationActive(item)), ...replacements];
    if (transaction.interpretationConflictId) {
      const conflict = d.interpretationConflicts?.find(item => item.id === transaction.interpretationConflictId);
      if (conflict) {
        conflict.status = 'resolved';
        conflict.updatedAt = now;
      }
      transaction.interpretationConflictId = null;
    }

    const selectedParent = d.buckets.find(item => item.id === replacements[0].bucketId);
    const semanticType = bucketSemanticType(selectedParent);
    if (semanticType !== 'spending') {
      transaction.movementType = movementTypeForSemanticType(semanticType);
      transaction.amountCents = semanticType === 'income'
        ? Math.abs(transaction.amountCents)
        : -Math.abs(transaction.amountCents);
      transaction.manualOverrides = {...(transaction.manualOverrides || {}), bucketSemanticType:semanticType};
    }

    const legacy = legacyTransaction(state, transactionId);
    if (legacy) {
      legacy.bucketId = replacements.length === 1 ? (replacements[0].subBucketId || replacements[0].bucketId) : null;
      if (semanticType !== 'spending') legacy.flow = legacyFlowForSemanticType(semanticType);
      if (options.markReviewed) {
        legacy.reviewStatus = 'reviewed';
        legacy.reviewedAt = now;
      }
    }
    if (options.markReviewed) {
      transaction.reviewStatus = 'reviewed';
      transaction.updatedAt = now;
    }
    if (typeof options.afterReplace === 'function') options.afterReplace(state, replacements);
    const domainValidation = validateDomainStore(d);
    if (!domainValidation.ok) throw new AllocationOperationError(domainValidation.errors.join('; '), 'INVALID_STATE');
    advanceStateRevision(state);
    await persist();
    return replacements.map(clone);
  } catch (error) {
    restoreObject(state, before);
    throw error;
  }
}

export function canonicalAllocationRows(state) {
  const d = domain(state);
  const transactions = new Map(d.transactions.map(item => [item.id, item]));
  const accounts = new Map(d.accounts.map(item => [item.id, item]));
  const legacyTransactions = new Map((state.review?.transactions || []).map(item => [item.id, item]));
  return d.allocations.filter(isAllocationActive).flatMap(allocation => {
    const transaction = transactions.get(allocation.transactionId);
    if (!transaction || !isTransactionActiveForReporting(transaction) || transaction.interpretationConflictId) return [];
    const account = accounts.get(transaction.accountId);
    return [{
      rowId:`allocation:${allocation.id}`,
      transactionId:transaction.id,
      allocationId:allocation.id,
      assignedBucketId:allocation.subBucketId || allocation.bucketId,
      parentBucketId:allocation.bucketId,
      date:clean(transaction.displayDate || transaction.postedAt || transaction.authorizedAt).slice(0, 10),
      merchant:clean(transaction.merchantName || transaction.rawName) || 'Unknown merchant',
      transactionName:clean(transaction.rawName || transaction.merchantName) || 'Unknown merchant',
      amountCents:allocation.amountCents,
      currency:transaction.currency || DEFAULT_CURRENCY,
      accountId:transaction.accountId || UNKNOWN_ACCOUNT_ID,
      accountName:account?.id === UNKNOWN_ACCOUNT_ID
        ? (clean(legacyTransactions.get(transaction.id)?.account) || 'Unknown account')
        : (account?.friendlyName || 'Unknown account'),
      reviewStatus:transaction.reviewStatus || 'unknown',
      assignment:allocation.subBucketId ? 'child' : 'direct',
      ownershipType:allocation.ownershipType === 'personal' ? 'mine' : allocation.ownershipType,
      note:allocation.note,
      movementType:transaction.movementType,
      locationRegion:transaction.locationRegion ?? null,
      locationCountry:transaction.locationCountry ?? null,
      source:'canonical-allocation',
      trace:{transactionId:transaction.id, allocationId:allocation.id}
    }];
  });
}

export function transactionAllocationSummary(state, transactionId) {
  const allocations = getTransactionAllocations(state, transactionId);
  const buckets = new Map(domain(state).buckets.map(item => [item.id, item]));
  let normalized = allocations.map(item => ({...item, ownershipType:item.ownershipType === 'personal' ? 'mine' : item.ownershipType}));
  if (!normalized.length) {
    const legacy = legacyTransaction(state, transactionId);
    const selected = buckets.get(legacy?.bucketId);
    const parent = selected?.parentId ? buckets.get(selected.parentId) : selected;
    if (legacy && selected && parent) {
      normalized = [{
        id:`legacy:${transactionId}`,
        transactionId,
        bucketId:parent.id,
        subBucketId:selected.parentId ? selected.id : null,
        amountCents:legacyAmountCents(legacy.amount),
        ownershipType:'mine',
        note:null
      }];
    }
  }
  const totals = allocationTotals(normalized);
  const lines = normalized.map(item => {
    const parent = buckets.get(item.bucketId);
    const child = item.subBucketId ? buckets.get(item.subBucketId) : null;
    return {
      id:item.id,
      label:`${parent?.name || 'Unknown bucket'}${child ? ` › ${child.name}` : ''}`,
      amountCents:item.amountCents,
      ownershipType:item.ownershipType,
      archived:parent?.active === false || child?.active === false
    };
  });
  return {
    transactionId,
    status:lines.length === 0 ? 'unassigned' : (lines.length === 1 ? 'single' : 'split'),
    lines,
    ...totals
  };
}
