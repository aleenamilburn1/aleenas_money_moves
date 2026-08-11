import {DEFAULT_CURRENCY, UNKNOWN_ACCOUNT_ID} from '../domain/constants.js';
import {isAllocationActive, isTransactionActiveForReporting, validateBucketTree, validateDomainStore} from '../domain/models.js';
import {canonicalAllocationRows} from './allocationService.js';
import {advanceStateRevision} from './stateRevision.js';

export class BucketOperationError extends Error {
  constructor(message, code = 'BUCKET_OPERATION_FAILED') {
    super(message);
    this.name = 'BucketOperationError';
    this.code = code;
  }
}

function restoreObject(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, snapshot);
}

const clone = value => JSON.parse(JSON.stringify(value));
const cents = value => Math.round(Math.abs(Number(value || 0)) * 100);
const clean = value => String(value || '').trim();
const nowIso = value => value || new Date().toISOString();

export function bucketSemanticType(item) {
  return item?.semanticType || 'spending';
}

function domain(state) {
  if (!state?.domain || !Array.isArray(state.domain.buckets)) throw new BucketOperationError('Bucket data is unavailable.', 'INVALID_STATE');
  return state.domain;
}

function bucket(state, id) {
  const found = domain(state).buckets.find(item => item.id === id);
  if (!found) throw new BucketOperationError('Bucket not found.', 'NOT_FOUND');
  return found;
}

function siblings(state, parentId) {
  return domain(state).buckets.filter(item => (item.parentId || null) === (parentId || null));
}

function assertUniqueName(state, name, parentId, exceptId = null) {
  const key = clean(name).toLocaleLowerCase();
  if (!key) throw new BucketOperationError('Enter a bucket name.', 'INVALID_NAME');
  if (siblings(state, parentId).some(item => item.id !== exceptId && clean(item.name).toLocaleLowerCase() === key)) {
    throw new BucketOperationError('Bucket names must be unique within the same level.', 'DUPLICATE_NAME');
  }
}

function nextOrder(state, parentId) {
  return Math.max(-1, ...siblings(state, parentId).map(item => Number(item.order) || 0)) + 1;
}

function stableId(state, name, parentId) {
  const base = clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bucket';
  const prefix = parentId ? `${parentId}-${base}` : base;
  let id = prefix;
  let suffix = 2;
  const ids = new Set(domain(state).buckets.map(item => item.id));
  while (ids.has(id)) id = `${prefix}-${suffix++}`;
  return id;
}

function normalizeOrders(state, parentId) {
  siblings(state, parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .forEach((item, index) => { item.order = index; syncLegacyBucket(state, item); });
}

function syncLegacyBucket(state, item) {
  state.review ||= {};
  state.review.buckets = Array.isArray(state.review.buckets) ? state.review.buckets : [];
  let legacy = state.review.buckets.find(value => value.id === item.id);
  if (!legacy) {
    legacy = {id:item.id, system:false};
    state.review.buckets.push(legacy);
  }
  Object.assign(legacy, {
    name:item.name,
    group:item.group,
    target:item.targetCents / 100,
    order:item.order,
    parentId:item.parentId,
    active:item.active,
    archivedAt:item.archivedAt,
    description:item.description,
    protected:item.protected,
    semanticType:bucketSemanticType(item),
    system:Boolean(item.system)
  });
}

function assertValidBuckets(state) {
  const result = validateBucketTree(domain(state).buckets);
  if (!result.ok) throw new BucketOperationError(result.errors.join('; '), 'INVALID_HIERARCHY');
}

export function listBuckets(state, {includeArchived = false, parentId} = {}) {
  return domain(state).buckets.filter(item => includeArchived || item.active !== false)
    .filter(item => parentId === undefined || (item.parentId || null) === (parentId || null))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function createBucket(state, input, options = {}) {
  const parentId = input.parentId || null;
  if (parentId) {
    const parent = bucket(state, parentId);
    if (parent.parentId) throw new BucketOperationError('A child bucket cannot contain another child bucket.', 'MAX_DEPTH');
    if (parent.system || bucketSemanticType(parent) !== 'spending') throw new BucketOperationError('System classifications cannot have child buckets.', 'SYSTEM_CLASSIFICATION');
    if (!parent.active) throw new BucketOperationError('Restore the parent bucket before adding a child.', 'PARENT_ARCHIVED');
  }
  assertUniqueName(state, input.name, parentId);
  const timestamp = nowIso(options.now);
  const item = {
    id:options.id || stableId(state, input.name, parentId), parentId, name:clean(input.name),
    group:clean(input.group) || (parentId ? bucket(state, parentId).group : 'Wants'),
    order:nextOrder(state, parentId), targetCents:Math.max(0, Number.isSafeInteger(input.targetCents) ? input.targetCents : cents(input.target)),
    protected:Boolean(input.protected), semanticType:'spending', system:false, active:true, description:clean(input.description) || null, archivedAt:null,
    createdAt:timestamp, updatedAt:timestamp
  };
  domain(state).buckets.push(item);
  assertValidBuckets(state);
  syncLegacyBucket(state, item);
  return item.id;
}

export function updateBucket(state, id, patch, options = {}) {
  const item = bucket(state, id);
  if (patch.semanticType !== undefined && patch.semanticType !== bucketSemanticType(item)) {
    throw new BucketOperationError('A bucket classification cannot be converted after it is created.', 'SEMANTIC_TYPE_IMMUTABLE');
  }
  if (patch.system !== undefined && Boolean(patch.system) !== Boolean(item.system)) {
    throw new BucketOperationError('A bucket cannot be converted to or from a system classification.', 'SYSTEM_CLASSIFICATION_IMMUTABLE');
  }
  if (item.system && ['name', 'group', 'targetCents', 'description'].some(field => patch[field] !== undefined)) {
    throw new BucketOperationError('System classifications are protected and cannot be edited.', 'SYSTEM_CLASSIFICATION');
  }
  if (patch.name !== undefined) assertUniqueName(state, patch.name, item.parentId, id);
  if (patch.name !== undefined) item.name = clean(patch.name);
  if (patch.group !== undefined) item.group = clean(patch.group) || item.group;
  if (patch.description !== undefined) item.description = clean(patch.description) || null;
  if (patch.targetCents !== undefined) item.targetCents = Math.max(0, Number(patch.targetCents) || 0);
  item.updatedAt = nowIso(options.now);
  assertValidBuckets(state);
  syncLegacyBucket(state, item);
  return true;
}

export function reorderBucket(state, id, direction, options = {}) {
  const item = bucket(state, id);
  const ordered = siblings(state, item.parentId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const from = ordered.findIndex(value => value.id === id);
  const to = direction === 'up' || direction === -1 ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ordered.length) return false;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  ordered.forEach((value, index) => { value.order = index; value.updatedAt = nowIso(options.now); syncLegacyBucket(state, value); });
  return true;
}

export function moveChildBucket(state, id, newParentId, options = {}) {
  const item = bucket(state, id);
  if (!item.parentId) throw new BucketOperationError('Only child buckets can be moved between parents.', 'NOT_CHILD');
  const parent = bucket(state, newParentId);
  if (parent.parentId || parent.id === item.id) throw new BucketOperationError('Child buckets can only move to a top-level parent.', 'MAX_DEPTH');
  if (parent.system || bucketSemanticType(parent) !== 'spending') throw new BucketOperationError('A child cannot be moved into a system classification.', 'SYSTEM_CLASSIFICATION');
  if (!parent.active) throw new BucketOperationError('Restore the destination parent before moving a child.', 'PARENT_ARCHIVED');
  assertUniqueName(state, item.name, parent.id, item.id);
  const oldParentId = item.parentId;
  item.parentId = parent.id;
  item.group = parent.group;
  item.order = nextOrder(state, parent.id);
  item.updatedAt = nowIso(options.now);
  normalizeOrders(state, oldParentId);
  assertValidBuckets(state);
  syncLegacyBucket(state, item);
  return true;
}

export function archiveBucket(state, id, options = {}) {
  const item = bucket(state, id);
  if (item.protected) throw new BucketOperationError('This protected bucket cannot be archived.', 'PROTECTED');
  const timestamp = nowIso(options.now);
  const affected = item.parentId ? [item] : [item, ...siblings(state, item.id)];
  for (const value of affected) {
    value.active = false; value.archivedAt = timestamp; value.updatedAt = timestamp; syncLegacyBucket(state, value);
  }
  return affected.map(value => value.id);
}

export function restoreBucket(state, id, options = {}) {
  const item = bucket(state, id);
  if (item.parentId && !bucket(state, item.parentId).active) throw new BucketOperationError('Restore the parent bucket first.', 'PARENT_ARCHIVED');
  item.active = true; item.archivedAt = null; item.updatedAt = nowIso(options.now); syncLegacyBucket(state, item);
  return true;
}

export function isBucketReferenced(state, id) {
  const d = domain(state);
  return d.allocations.some(value => value.bucketId === id || value.subBucketId === id)
    || (state.review?.transactions || []).some(value => value.bucketId === id)
    || (d.merchantRules || []).some(value => value.action?.bucketId === id)
    || (state.review?.merchantRules || []).some(value => value.bucketId === id);
}

export function deleteBucket(state, id) {
  const item = bucket(state, id);
  if (item.protected || item.system || bucketSemanticType(item) !== 'spending') {
    throw new BucketOperationError('This protected classification cannot be deleted.', 'PROTECTED');
  }
  if (isBucketReferenced(state, id)) throw new BucketOperationError('This bucket has history or rules and cannot be deleted. Archive it instead.', 'BUCKET_REFERENCED');
  throw new BucketOperationError('Buckets are archived, not deleted, so stable identifiers and history are preserved.', 'ARCHIVE_REQUIRED');
}

function transactionDate(tx) { return String(tx.displayDate || tx.postedAt || tx.authorizedAt || tx.date || '').slice(0, 10); }
function transactionLabel(tx) { return clean(tx.merchantName || tx.merchant || tx.rawName || tx.name) || 'Unknown merchant'; }
function legacyAccountKey(tx) {
  const label = clean(tx.account);
  return tx.accountId || (label ? `legacy-account:${label.toLocaleLowerCase()}` : UNKNOWN_ACCOUNT_ID);
}

function legacyRows(state, canonicalTransactionIds) {
  const buckets = new Map(domain(state).buckets.map(item => [item.id, item]));
  return (state.review?.transactions || []).flatMap(tx => {
    if (!tx.bucketId || canonicalTransactionIds.has(tx.id)) return [];
    const assigned = buckets.get(tx.bucketId);
    const parentBucketId = assigned?.parentId || tx.bucketId;
    return [{
      rowId:`legacy:${tx.id}`, transactionId:tx.id, allocationId:null, assignedBucketId:tx.bucketId, parentBucketId,
      date:transactionDate(tx), merchant:transactionLabel(tx), amountCents:cents(tx.amount), currency:DEFAULT_CURRENCY,
      transactionName:clean(tx.name || tx.merchant) || transactionLabel(tx),
      accountId:legacyAccountKey(tx), accountName:clean(tx.account) || 'Unknown account',
      reviewStatus:tx.reviewStatus || 'pending', assignment:assigned?.parentId ? 'child' : 'direct',
      ownershipType:'mine', movementType:tx.flow === 'transfer' ? 'internal_transfer' : (tx.flow === 'inflow' ? 'other_inflow' : 'expense'),
      locationRegion:tx.locationRegion ?? null, locationCountry:tx.locationCountry ?? null,
      source:'legacy-v1-assignment', trace:{transactionId:tx.id, legacyField:'review.transactions[].bucketId'}
    }];
  });
}

export function bucketLedgerRows(state) {
  const canonical = canonicalAllocationRows(state);
  const canonicalIds = new Set(canonical.map(row => row.transactionId));
  return [...canonical, ...legacyRows(state, canonicalIds)];
}

// Every allocation row is counted once. A child allocation contributes to that
// child and its immediate parent, while a direct allocation contributes only to
// its parent. This keeps parent totals traceable without double-counting spend.
export function aggregateMonthlyBucketActivity(state, month) {
  const actualsCents = {};
  let spendCents = 0;
  let incomeCents = 0;
  let debtPaymentCents = 0;
  let reviewedSpendCents = 0;
  let provisionalSpendCents = 0;
  const buckets = new Map(domain(state).buckets.map(item => [item.id, item]));
  for (const row of bucketLedgerRows(state)) {
    if (!String(row.date || '').startsWith(`${month}-`)) continue;
    const parent = buckets.get(row.parentBucketId);
    const semanticType = bucketSemanticType(parent);
    if (semanticType === 'income') {
      incomeCents += row.amountCents;
      continue;
    }
    if (semanticType === 'transfer') continue;
    if (semanticType === 'debt_payment') {
      debtPaymentCents += row.amountCents;
      continue;
    }
    const amountCents = row.amountCents;
    actualsCents[row.assignedBucketId] = (actualsCents[row.assignedBucketId] || 0) + amountCents;
    if (row.parentBucketId && row.parentBucketId !== row.assignedBucketId) {
      actualsCents[row.parentBucketId] = (actualsCents[row.parentBucketId] || 0) + amountCents;
    }
    spendCents += amountCents;
    if (row.reviewStatus === 'reviewed') reviewedSpendCents += amountCents;
    else provisionalSpendCents += amountCents;
  }
  return {actualsCents, spendCents, incomeCents, debtPaymentCents, reviewedSpendCents, provisionalSpendCents};
}

function matches(row, filters) {
  if (filters.from && row.date < filters.from) return false;
  if (filters.to && row.date > filters.to) return false;
  if (filters.accountId && row.accountId !== filters.accountId) return false;
  if (filters.reviewStatus === 'unreviewed' && row.reviewStatus === 'reviewed') return false;
  if (filters.reviewStatus && filters.reviewStatus !== 'unreviewed' && row.reviewStatus !== filters.reviewStatus) return false;
  if (filters.assignment && row.assignment !== filters.assignment) return false;
  if (filters.search && !`${row.merchant} ${row.transactionName || ''} ${row.accountName}`.toLocaleLowerCase().includes(clean(filters.search).toLocaleLowerCase())) return false;
  return true;
}

export function queryBucketDetail(state, bucketId, filters = {}) {
  const selected = bucket(state, bucketId);
  const bucketNames = new Map(domain(state).buckets.map(item => [item.id, item.name]));
  const all = bucketLedgerRows(state);
  const relevant = selected.parentId ? all.filter(row => row.assignedBucketId === selected.id) : all.filter(row => row.parentBucketId === selected.id);
  const rows = relevant.filter(row => matches(row, filters)).map(row => ({...row, assignedBucketName:bucketNames.get(row.assignedBucketId) || 'Unknown bucket'}))
    .sort((a, b) => b.date.localeCompare(a.date) || a.rowId.localeCompare(b.rowId));
  const directCents = rows.filter(row => row.assignedBucketId === selected.id).reduce((sum, row) => sum + row.amountCents, 0);
  const childTotals = selected.parentId ? [] : siblings(state, selected.id).map(child => ({
    bucket:clone(child), amountCents:rows.filter(row => row.assignedBucketId === child.id).reduce((sum, row) => sum + row.amountCents, 0)
  }));
  let legacyAggregateCents = 0;
  if (!rows.length && !Object.values(filters).some(Boolean)) {
    legacyAggregateCents = (domain(state).legacyMonthlySnapshots || []).reduce((sum, snapshot) => sum + Number(snapshot.bucketActualsCents?.[selected.id] || 0), 0);
  }
  return {
    bucket:clone(selected), rows, directCents, rolledUpCents:rows.reduce((sum, row) => sum + row.amountCents, 0),
    childTotals, transactionCount:new Set(rows.map(row => row.transactionId)).size,
    legacyAggregateCents, hasLegacyAggregate:legacyAggregateCents > 0,
    accountOptions:[...new Map(relevant.map(row => [row.accountId, row.accountName])).entries()].map(([id, name]) => ({id, name}))
  };
}

export function queryUnassignedTransactions(state, filters = {}) {
  const d = domain(state), allocated = new Set(d.allocations.filter(isAllocationActive).map(item => item.transactionId));
  const canonical = d.transactions.filter(tx => isTransactionActiveForReporting(tx) && !allocated.has(tx.id)).map(tx => ({
    rowId:`unassigned:${tx.id}`, transactionId:tx.id, date:transactionDate(tx), merchant:transactionLabel(tx),
    amountCents:Math.abs(tx.amountCents), accountId:tx.accountId || UNKNOWN_ACCOUNT_ID,
    accountName:d.accounts.find(account => account.id === tx.accountId)?.friendlyName || 'Unknown account',
    reviewStatus:tx.reviewStatus || 'unknown', assignment:'unassigned', source:'canonical-transaction'
  }));
  const canonicalIds = new Set(d.transactions.map(tx => tx.id));
  const legacy = (state.review?.transactions || []).filter(tx => !tx.bucketId && !canonicalIds.has(tx.id)).map(tx => ({
    rowId:`legacy-unassigned:${tx.id}`, transactionId:tx.id, date:transactionDate(tx), merchant:transactionLabel(tx),
    amountCents:cents(tx.amount), accountId:legacyAccountKey(tx), accountName:clean(tx.account) || 'Unknown account',
    reviewStatus:tx.reviewStatus || 'pending', assignment:'unassigned', source:'legacy-v1-transaction'
  }));
  return [...canonical, ...legacy].filter(row => matches(row, filters)).sort((a, b) => b.date.localeCompare(a.date));
}

export function assertBucketStatePersistable(state) {
  const result = validateDomainStore(domain(state));
  if (!result.ok) throw new BucketOperationError(result.errors.join('; '), 'INVALID_STATE');
  return true;
}

export async function applyBucketChangeWithRollback(state, change, persist) {
  if (typeof change !== 'function' || typeof persist !== 'function') {
    throw new BucketOperationError('Bucket change and persistence callbacks are required.', 'INVALID_OPERATION');
  }
  const before = clone(state);
  try {
    const result = change();
    assertBucketStatePersistable(state);
    advanceStateRevision(state);
    await persist();
    return result;
  } catch (error) {
    restoreObject(state, before);
    throw error;
  }
}
