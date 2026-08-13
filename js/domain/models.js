import {
  BUCKET_SEMANTIC_TYPES, DEFAULT_CURRENCY, DEVOTIONAL_PRIVATE_NOTES_MAX_CHARS,
  DEVOTIONAL_RESPONSE_MAX_CHARS, SYSTEM_BUCKET_IDS, UNKNOWN_ACCOUNT_ID
} from './constants.js';
import {FAITH_MONEY_DEVOTIONALS, devotionalById} from '../content/faithMoneyDevotionals.js';
import {SOURCE_ACCOUNT_IDENTITY_DOMAINS, sourceAccountReferenceMatchesDomain} from './ingestionContract.js';

export const ACCOUNT_TYPES = new Set(['cash', 'depository', 'credit', 'loan', 'savings', 'investment', 'other', 'unknown']);
export const TRANSACTION_SOURCES = new Set(['manual', 'csv', 'migration', 'provider']);
export const PENDING_STATUSES = new Set(['pending', 'posted', 'removed', 'unknown']);
export const MOVEMENT_TYPES = new Set([
  'unclassified', 'expense', 'earned_income', 'reimbursement', 'merchant_refund', 'internal_transfer',
  'gift', 'debt_payment', 'savings_contribution', 'interest', 'sale_proceeds',
  'other_inflow', 'other', 'excluded'
]);
export const REVIEW_STATUSES = new Set(['pending', 'suggested', 'deferred', 'reviewed', 'needs_resolution']);
// `personal`, `shared`, and `excluded` remain readable for encrypted-vault compatibility.
// Current allocation writes use only `mine` and `reimbursable`.
export const OWNERSHIP_TYPES = new Set(['mine', 'reimbursable', 'personal', 'shared', 'excluded']);
export const PAYMENT_LINK_SOURCES = new Set(['user_linked', 'suggestion_confirmed', 'migrated_foundation']);
export const REIMBURSEMENT_ADJUSTMENT_TYPES = new Set(['write_off', 'write_off_reversal']);
export const AUDIT_EVENT_SOURCES = new Set(['user', 'migration', 'reconciliation']);
export const REIMBURSEMENT_STATUSES = new Set(['cancelled', 'open', 'partially_paid', 'settled', 'written_off']);
export const SOURCE_KINDS = new Set(['manual', 'csv', 'provider']);
export const SOURCE_ACCOUNT_IDENTITY_DOMAIN_SET = new Set(Object.values(SOURCE_ACCOUNT_IDENTITY_DOMAINS));
export const SOURCE_LIFECYCLES = new Set(['pending', 'posted', 'removed', 'unknown']);
export const ALLOCATION_STATUSES = new Set(['active', 'superseded']);
export const INGESTION_RESULT_COUNT_FIELDS = Object.freeze([
  'accountsAdded',
  'accountsUpdated',
  'accountsDisconnected',
  'transactionsAdded',
  'transactionsUpdated',
  'transactionsTombstoned',
  'pendingPostedTransitions',
  'interpretationConflicts',
  'sourceRecordsQuarantined'
]);

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const SYSTEM_BUCKET_SEMANTICS = Object.freeze({
  [SYSTEM_BUCKET_IDS.income]:'income',
  [SYSTEM_BUCKET_IDS.transfer]:'transfer',
  [SYSTEM_BUCKET_IDS.debtPayment]:'debt_payment'
});

export class ModelValidationError extends Error {
  constructor(modelName, errors) {
    super(`${modelName} is invalid: ${errors.join('; ')}`);
    this.name = 'ModelValidationError';
    this.modelName = modelName;
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, field, errors) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function optionalString(value, field, errors) {
  if (value !== undefined && value !== null && typeof value !== 'string') errors.push(`${field} must be a string or null`);
}

function optionalNonEmptyString(value, field, errors) {
  if (value !== undefined && value !== null) requiredString(value, field, errors);
}

function optionalObject(value, field, errors) {
  if (value !== undefined && value !== null && !isPlainObject(value)) errors.push(`${field} must be an object or null`);
}

function requireField(value, field, errors) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${field} is required`);
}

function rejectUnknownFields(value, allowed, modelName, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${modelName}.${field} is not an allowed field`);
  }
}

function requiredBoolean(value, field, errors) {
  if (typeof value !== 'boolean') errors.push(`${field} must be a boolean`);
}

function requiredInteger(value, field, errors, {min = Number.MIN_SAFE_INTEGER, nonZero = false} = {}) {
  if (!Number.isSafeInteger(value)) errors.push(`${field} must be a safe integer`);
  else if (value < min) errors.push(`${field} must be at least ${min}`);
  else if (nonZero && value === 0) errors.push(`${field} must not be zero`);
}

function optionalInteger(value, field, errors, {min = Number.MIN_SAFE_INTEGER} = {}) {
  if (value !== undefined && value !== null) requiredInteger(value, field, errors, {min});
}

function requiredEnum(value, field, allowed, errors) {
  if (!allowed.has(value)) errors.push(`${field} must be one of: ${[...allowed].join(', ')}`);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function requiredTimestamp(value, field, errors) {
  requiredString(value, field, errors);
  if (typeof value === 'string' && !isTimestamp(value)) errors.push(`${field} must be an ISO-compatible timestamp`);
}

function optionalTimestamp(value, field, errors) {
  if (value !== undefined && value !== null && !isTimestamp(value)) errors.push(`${field} must be an ISO-compatible timestamp or null`);
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function optionalDate(value, field, errors) {
  if (value !== undefined && value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) errors.push(`${field} must be an ISO-compatible date or null`);
}

function optionalCalendarDate(value, field, errors) {
  if (value !== undefined && value !== null && !isCalendarDate(value)) errors.push(`${field} must be a valid YYYY-MM-DD calendar date or null`);
}

function requiredCurrency(value, errors) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) errors.push('currency must be a three-letter uppercase ISO code');
}

function optionalCurrency(value, errors) {
  if (value !== null && (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value))) errors.push('currency must be a three-letter uppercase ISO code or null');
}

function validationResult(modelName, value, errors) {
  return {ok: errors.length === 0, modelName, value, errors};
}

function validateBaseEntity(value, modelName, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${modelName} must be an object`);
    return false;
  }
  requiredString(value.id, 'id', errors);
  requiredTimestamp(value.createdAt, 'createdAt', errors);
  requiredTimestamp(value.updatedAt, 'updatedAt', errors);
  return true;
}

function rejectLegacyClaimFields(value, errors) {
  for (const field of ['expectedAmountCents', 'status', 'allocationIds', 'repaymentLinks']) {
    if (Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${field} is legacy compatibility data and is not authoritative in schema 7`);
  }
}

export function validateAccount(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'Account', errors)) return validationResult('Account', value, errors);
  optionalString(value.institutionId, 'institutionId', errors);
  optionalString(value.externalAccountId, 'externalAccountId', errors);
  requiredString(value.friendlyName, 'friendlyName', errors);
  optionalString(value.officialName, 'officialName', errors);
  optionalString(value.mask, 'mask', errors);
  requiredEnum(value.type, 'type', ACCOUNT_TYPES, errors);
  optionalString(value.subtype, 'subtype', errors);
  optionalCurrency(value.currency, errors);
  requiredEnum(value.source, 'source', new Set(['manual', 'csv', 'migration', 'system', 'provider']), errors);
  requiredBoolean(value.active, 'active', errors);
  optionalInteger(value.balanceCents, 'balanceCents', errors);
  if (Object.prototype.hasOwnProperty.call(value, 'sourceKind')) {
    requiredEnum(value.sourceKind, 'sourceKind', SOURCE_KINDS, errors);
    requiredString(value.sourceNamespace, 'sourceNamespace', errors);
    requiredString(value.sourceAccountRef, 'sourceAccountRef', errors);
    requiredEnum(value.sourceAccountIdentityDomain, 'sourceAccountIdentityDomain', SOURCE_ACCOUNT_IDENTITY_DOMAIN_SET, errors);
    if (!sourceAccountReferenceMatchesDomain(value.sourceAccountIdentityDomain, value.sourceAccountRef)) {
      errors.push('sourceAccountRef does not match sourceAccountIdentityDomain');
    }
    optionalString(value.connectionId, 'connectionId', errors);
    optionalString(value.institutionName, 'institutionName', errors);
    optionalString(value.providerDisplayName, 'providerDisplayName', errors);
    requiredBoolean(value.enabled, 'enabled', errors);
    requiredBoolean(value.hidden, 'hidden', errors);
    requiredEnum(value.sourceStatus, 'sourceStatus', new Set(['active', 'disconnected', 'closed', 'unknown']), errors);
    requiredString(value.connectionStatus, 'connectionStatus', errors);
    optionalObject(value.sourceMetadata, 'sourceMetadata', errors);
    optionalObject(value.balances, 'balances', errors);
    requiredTimestamp(value.sourceObservedAt, 'sourceObservedAt', errors);
  }
  return validationResult('Account', value, errors);
}

export function validateTransaction(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'Transaction', errors)) return validationResult('Transaction', value, errors);
  requiredString(value.accountId, 'accountId', errors);
  requiredEnum(value.source, 'source', TRANSACTION_SOURCES, errors);
  optionalString(value.sourceTransactionId, 'sourceTransactionId', errors);
  optionalString(value.rawName, 'rawName', errors);
  optionalString(value.merchantName, 'merchantName', errors);
  requiredInteger(value.amountCents, 'amountCents', errors, {nonZero:true});
  optionalCurrency(value.currency, errors);
  optionalDate(value.authorizedAt, 'authorizedAt', errors);
  optionalDate(value.postedAt, 'postedAt', errors);
  optionalDate(value.displayDate, 'displayDate', errors);
  requiredEnum(value.pendingStatus, 'pendingStatus', PENDING_STATUSES, errors);
  requiredEnum(value.movementType, 'movementType', MOVEMENT_TYPES, errors);
  requiredEnum(value.reviewStatus, 'reviewStatus', REVIEW_STATUSES, errors);
  optionalString(value.locationRegion, 'locationRegion', errors);
  optionalString(value.locationCountry, 'locationCountry', errors);
  optionalString(value.locationSource, 'locationSource', errors);
  optionalString(value.providerCategory, 'providerCategory', errors);
  optionalObject(value.manualOverrides, 'manualOverrides', errors);
  if (Object.prototype.hasOwnProperty.call(value, 'sourceKind')) {
    requiredEnum(value.sourceKind, 'sourceKind', SOURCE_KINDS, errors);
    requiredString(value.sourceNamespace, 'sourceNamespace', errors);
    requiredString(value.sourceRecordRef, 'sourceRecordRef', errors);
    requiredString(value.sourceAccountRef, 'sourceAccountRef', errors);
    requiredEnum(value.sourceAccountIdentityDomain, 'sourceAccountIdentityDomain', SOURCE_ACCOUNT_IDENTITY_DOMAIN_SET, errors);
    if (!sourceAccountReferenceMatchesDomain(value.sourceAccountIdentityDomain, value.sourceAccountRef)) {
      errors.push('sourceAccountRef does not match sourceAccountIdentityDomain');
    }
    requiredEnum(value.sourceLifecycle, 'sourceLifecycle', SOURCE_LIFECYCLES, errors);
    optionalObject(value.sourceAmount, 'sourceAmount', errors);
    if (isPlainObject(value.sourceAmount)) {
      requiredString(value.sourceAmount.decimal, 'sourceAmount.decimal', errors);
      optionalCurrency(value.sourceAmount.currency, errors);
      requiredEnum(value.sourceAmount.signConvention, 'sourceAmount.signConvention', new Set([
        'money_moves_signed', 'positive_outflow', 'positive_inflow', 'debit_credit'
      ]), errors);
    }
    optionalCalendarDate(value.sourceDate, 'sourceDate', errors);
    optionalCalendarDate(value.authorizedDate, 'authorizedDate', errors);
    optionalTimestamp(value.sourceAuthorizedAt, 'sourceAuthorizedAt', errors);
    optionalCalendarDate(value.postedDate, 'postedDate', errors);
    optionalTimestamp(value.sourcePostedAt, 'sourcePostedAt', errors);
    optionalString(value.rawDescription, 'rawDescription', errors);
    optionalString(value.displayDescription, 'displayDescription', errors);
    optionalObject(value.providerCategoryMetadata, 'providerCategoryMetadata', errors);
    optionalObject(value.sourceProvenance, 'sourceProvenance', errors);
    if (!Array.isArray(value.sourceRefAliases)) errors.push('sourceRefAliases must be an array');
    else for (const alias of value.sourceRefAliases) {
      if (!isPlainObject(alias)) { errors.push('sourceRefAliases must contain objects'); continue; }
      requiredString(alias.sourceRecordRef, 'sourceRefAliases.sourceRecordRef', errors);
      requiredString(alias.lifecycle, 'sourceRefAliases.lifecycle', errors);
      requiredTimestamp(alias.observedAt, 'sourceRefAliases.observedAt', errors);
    }
    optionalString(value.predecessorTransactionId, 'predecessorTransactionId', errors);
    optionalObject(value.tombstone, 'tombstone', errors);
    optionalString(value.interpretationConflictId, 'interpretationConflictId', errors);
    if (!Array.isArray(value.sourceHistory)) errors.push('sourceHistory must be an array');
    else for (const history of value.sourceHistory) {
      if (!isPlainObject(history)) { errors.push('sourceHistory must contain objects'); continue; }
      requiredTimestamp(history.observedAt, 'sourceHistory.observedAt', errors);
      requiredString(history.batchId, 'sourceHistory.batchId', errors);
      requiredString(history.sourceRecordRef, 'sourceHistory.sourceRecordRef', errors);
    }
  }
  return validationResult('Transaction', value, errors);
}

function validateLegacyTransaction(value) {
  if (!isPlainObject(value)) return validateTransaction(value);
  const candidate = {...value};
  if (candidate.currency !== null && (typeof candidate.currency !== 'string' || !/^[A-Z]{3}$/.test(candidate.currency))) {
    candidate.currency = null;
  }
  return validateTransaction(candidate);
}

export function validateBucket(value, {legacySemanticType = false} = {}) {
  const errors = [];
  if (!validateBaseEntity(value, 'Bucket', errors)) return validationResult('Bucket', value, errors);
  optionalString(value.parentId, 'parentId', errors);
  requiredString(value.name, 'name', errors);
  requiredString(value.group, 'group', errors);
  requiredInteger(value.order, 'order', errors, {min:0});
  requiredInteger(value.targetCents, 'targetCents', errors, {min:0});
  requiredBoolean(value.protected, 'protected', errors);
  requiredBoolean(value.active, 'active', errors);
  if (!legacySemanticType) {
    requiredEnum(value.semanticType, 'semanticType', BUCKET_SEMANTIC_TYPES, errors);
    requiredBoolean(value.system, 'system', errors);
    const expectedSemanticType = SYSTEM_BUCKET_SEMANTICS[value.id] || null;
    if (expectedSemanticType) {
      if (value.system !== true) errors.push(`reserved system bucket ${value.id} must be a system classification`);
      if (value.protected !== true) errors.push(`reserved system bucket ${value.id} must be protected`);
      if (value.parentId !== null) errors.push(`reserved system bucket ${value.id} must be top-level`);
      if (value.semanticType !== expectedSemanticType) errors.push(`reserved system bucket ${value.id} must use ${expectedSemanticType} semantics`);
    } else {
      if (value.system === true) errors.push('only reserved bucket IDs may be system classifications');
      if (value.semanticType !== 'spending') errors.push('user-owned buckets must use spending semantics');
    }
  }
  optionalString(value.description, 'description', errors);
  optionalDate(value.archivedAt, 'archivedAt', errors);
  return validationResult('Bucket', value, errors);
}

export function validateAllocation(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'Allocation', errors)) return validationResult('Allocation', value, errors);
  requiredString(value.transactionId, 'transactionId', errors);
  requiredString(value.bucketId, 'bucketId', errors);
  optionalString(value.subBucketId, 'subBucketId', errors);
  requiredInteger(value.amountCents, 'amountCents', errors, {min:1});
  requiredEnum(value.ownershipType, 'ownershipType', OWNERSHIP_TYPES, errors);
  optionalString(value.note, 'note', errors);
  // Readable only for schema-6 compatibility. Schema 7 relationships are standalone.
  optionalString(value.reimbursementClaimId, 'reimbursementClaimId', errors);
  if (value.status !== undefined) requiredEnum(value.status, 'status', ALLOCATION_STATUSES, errors);
  optionalString(value.supersededByConflictId, 'supersededByConflictId', errors);
  return validationResult('Allocation', value, errors);
}

export function validateDevotionalState(value) {
  const errors = [];
  if (!isPlainObject(value)) return validationResult('DevotionalState', value, ['devotionalState must be an object']);
  rejectUnknownFields(value, new Set([
    'activeDevotionalId', 'rotationStartedAt', 'lastOpenedAt', 'completedDevotionalIds', 'savedDevotionalIds', 'entries'
  ]), 'DevotionalState', errors);
  requiredString(value.activeDevotionalId, 'activeDevotionalId', errors);
  if (typeof value.activeDevotionalId === 'string' && !devotionalById(value.activeDevotionalId)) errors.push('activeDevotionalId must reference library content');
  requiredTimestamp(value.rotationStartedAt, 'rotationStartedAt', errors);
  optionalTimestamp(value.lastOpenedAt, 'lastOpenedAt', errors);
  for (const field of ['completedDevotionalIds', 'savedDevotionalIds', 'entries']) {
    if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
  }
  const validateIdList = (items, field) => {
    const seen = new Set();
    for (const devotionalId of items || []) {
      if (typeof devotionalId !== 'string' || !devotionalById(devotionalId)) errors.push(`${field} contains an unknown devotional`);
      else if (seen.has(devotionalId)) errors.push(`${field} contains duplicate devotional id`);
      seen.add(devotionalId);
    }
  };
  validateIdList(value.completedDevotionalIds, 'completedDevotionalIds');
  validateIdList(value.savedDevotionalIds, 'savedDevotionalIds');
  const activeDevotional = devotionalById(value.activeDevotionalId);
  if (activeDevotional && Array.isArray(value.completedDevotionalIds)) {
    // Completion is a contiguous prefix of the static library. The active item
    // may be the one just completed (before an explicit Continue action), but
    // no vault can legitimately skip ahead or mark a later item complete.
    const completedCount = value.completedDevotionalIds.length;
    const permittedCounts = new Set([activeDevotional.sequence - 1, activeDevotional.sequence]);
    if (!permittedCounts.has(completedCount)) errors.push('completedDevotionalIds must match the active devotional progression');
    const expectedCompletedIds = FAITH_MONEY_DEVOTIONALS
      .filter(item => item.sequence <= completedCount)
      .map(item => item.id);
    if (expectedCompletedIds.some(id => !value.completedDevotionalIds.includes(id))) {
      errors.push('completedDevotionalIds must be a contiguous library prefix');
    }
  }
  const entryIds = new Set();
  const entryDevotionalIds = new Set();
  for (const entry of value.entries || []) {
    if (!isPlainObject(entry)) { errors.push('devotional entry must be an object'); continue; }
    rejectUnknownFields(entry, new Set([
      'id', 'devotionalId', 'promptResponses', 'privateNotes', 'startedAt', 'updatedAt', 'completedAt', 'contentVersion'
    ]), 'DevotionalEntry', errors);
    requiredString(entry.id, 'entry.id', errors);
    requiredString(entry.devotionalId, 'entry.devotionalId', errors);
    if (entryIds.has(entry.id)) errors.push('devotional entries contain duplicate id');
    entryIds.add(entry.id);
    if (entryDevotionalIds.has(entry.devotionalId)) errors.push('devotional entries contain duplicate devotionalId');
    entryDevotionalIds.add(entry.devotionalId);
    const content = devotionalById(entry.devotionalId);
    if (!content) errors.push('devotional entry references unknown devotional');
    if (!Array.isArray(entry.promptResponses) || entry.promptResponses.length > 3) errors.push('promptResponses must contain at most three items');
    const promptIds = new Set();
    for (const response of entry.promptResponses || []) {
      if (!isPlainObject(response)) { errors.push('prompt response must be an object'); continue; }
      rejectUnknownFields(response, new Set(['promptId', 'response']), 'PromptResponse', errors);
      requiredString(response.promptId, 'promptId', errors);
      if (!content?.prompts.some(prompt => prompt.id === response.promptId)) errors.push('prompt response references unknown prompt');
      if (promptIds.has(response.promptId)) errors.push('promptResponses contain duplicate prompt id');
      promptIds.add(response.promptId);
      if (typeof response.response !== 'string') errors.push('prompt response must be plain text');
      else if (response.response.length > DEVOTIONAL_RESPONSE_MAX_CHARS) errors.push('prompt response exceeds the size limit');
    }
    if (typeof entry.privateNotes !== 'string') errors.push('privateNotes must be plain text');
    else if (entry.privateNotes.length > DEVOTIONAL_PRIVATE_NOTES_MAX_CHARS) errors.push('privateNotes exceeds the size limit');
    requiredTimestamp(entry.startedAt, 'startedAt', errors);
    requiredTimestamp(entry.updatedAt, 'updatedAt', errors);
    optionalTimestamp(entry.completedAt, 'completedAt', errors);
    requiredInteger(entry.contentVersion, 'contentVersion', errors, {min:1});
    if (entry.completedAt !== null && entry.completedAt !== undefined && !value.completedDevotionalIds?.includes(entry.devotionalId)) {
      errors.push('completed devotional entry must appear in completedDevotionalIds');
    }
  }
  for (const devotionalId of value.completedDevotionalIds || []) {
    const entry = (value.entries || []).find(item => item?.devotionalId === devotionalId);
    if (!entry?.completedAt) errors.push('completedDevotionalIds must have a completed entry');
  }
  return validationResult('DevotionalState', value, errors);
}

export function validateReimbursementClaim(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'ReimbursementClaim', errors)) return validationResult('ReimbursementClaim', value, errors);
  rejectUnknownFields(value, new Set([
    'id', 'payerLabel', 'currency', 'dueDate', 'note', 'cancelledAt', 'cancellationReason',
    'createdAt', 'updatedAt'
  ]), 'ReimbursementClaim', errors);
  requiredString(value.payerLabel, 'payerLabel', errors);
  requiredCurrency(value.currency, errors);
  for (const field of ['dueDate', 'note', 'cancelledAt', 'cancellationReason']) requireField(value, field, errors);
  optionalCalendarDate(value.dueDate, 'dueDate', errors);
  optionalString(value.note, 'note', errors);
  optionalTimestamp(value.cancelledAt, 'cancelledAt', errors);
  optionalNonEmptyString(value.cancellationReason, 'cancellationReason', errors);
  const hasCancelledAt = value.cancelledAt !== undefined && value.cancelledAt !== null;
  const hasCancellationReason = value.cancellationReason !== undefined && value.cancellationReason !== null;
  if (hasCancelledAt !== hasCancellationReason) errors.push('cancelledAt and cancellationReason must both exist or both be null');
  rejectLegacyClaimFields(value, errors);
  return validationResult('ReimbursementClaim', value, errors);
}

export function validateReimbursementClaimAllocation(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'ReimbursementClaimAllocation', errors)) return validationResult('ReimbursementClaimAllocation', value, errors);
  requiredString(value.claimId, 'claimId', errors);
  requiredString(value.allocationId, 'allocationId', errors);
  requiredInteger(value.amountCents, 'amountCents', errors, {min:1});
  return validationResult('ReimbursementClaimAllocation', value, errors);
}

export function validateReimbursementPaymentLink(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'ReimbursementPaymentLink', errors)) return validationResult('ReimbursementPaymentLink', value, errors);
  requiredString(value.claimId, 'claimId', errors);
  requiredString(value.inflowTransactionId, 'inflowTransactionId', errors);
  requiredInteger(value.appliedAmountCents, 'appliedAmountCents', errors, {min:1});
  requiredEnum(value.source, 'source', PAYMENT_LINK_SOURCES, errors);
  for (const field of ['note', 'voidedAt', 'voidReason']) requireField(value, field, errors);
  optionalString(value.note, 'note', errors);
  optionalTimestamp(value.voidedAt, 'voidedAt', errors);
  optionalNonEmptyString(value.voidReason, 'voidReason', errors);
  const hasVoidedAt = value.voidedAt !== undefined && value.voidedAt !== null;
  const hasVoidReason = value.voidReason !== undefined && value.voidReason !== null;
  if (hasVoidedAt !== hasVoidReason) errors.push('voidedAt and voidReason must both exist or both be null');
  return validationResult('ReimbursementPaymentLink', value, errors);
}

export function validateReimbursementAdjustment(value) {
  const errors = [];
  if (!isPlainObject(value)) return validationResult('ReimbursementAdjustment', value, ['ReimbursementAdjustment must be an object']);
  requiredString(value.id, 'id', errors);
  requiredString(value.claimId, 'claimId', errors);
  requiredEnum(value.type, 'type', REIMBURSEMENT_ADJUSTMENT_TYPES, errors);
  requiredInteger(value.amountCents, 'amountCents', errors, {min:1});
  requiredString(value.reason, 'reason', errors);
  requiredTimestamp(value.effectiveAt, 'effectiveAt', errors);
  requireField(value, 'reversesAdjustmentId', errors);
  optionalNonEmptyString(value.reversesAdjustmentId, 'reversesAdjustmentId', errors);
  requiredTimestamp(value.createdAt, 'createdAt', errors);
  if (value.type === 'write_off' && value.reversesAdjustmentId !== null) errors.push('write_off must not reference reversesAdjustmentId');
  if (value.type === 'write_off_reversal' && !value.reversesAdjustmentId) errors.push('write_off_reversal must reference a write_off');
  return validationResult('ReimbursementAdjustment', value, errors);
}

export function validateAuditEvent(value) {
  const errors = [];
  if (!isPlainObject(value)) return validationResult('AuditEvent', value, ['AuditEvent must be an object']);
  rejectUnknownFields(value, new Set([
    'id', 'entityType', 'entityId', 'action', 'relatedEntityIds', 'occurredAt', 'source',
    'reason', 'monetaryFacts', 'operationGroupId'
  ]), 'AuditEvent', errors);
  requiredString(value.id, 'id', errors);
  requiredString(value.entityType, 'entityType', errors);
  requiredString(value.entityId, 'entityId', errors);
  requiredString(value.action, 'action', errors);
  if (!Array.isArray(value.relatedEntityIds)) errors.push('relatedEntityIds must be an array');
  else {
    const related = new Set();
    value.relatedEntityIds.forEach((id, index) => {
      requiredString(id, `relatedEntityIds[${index}]`, errors);
      if (typeof id === 'string' && related.has(id)) errors.push(`relatedEntityIds[${index}] must not duplicate another related entity id`);
      related.add(id);
    });
  }
  requiredTimestamp(value.occurredAt, 'occurredAt', errors);
  requiredEnum(value.source, 'source', AUDIT_EVENT_SOURCES, errors);
  for (const field of ['reason', 'monetaryFacts', 'operationGroupId']) requireField(value, field, errors);
  optionalString(value.reason, 'reason', errors);
  if (value.monetaryFacts !== null) {
    if (!isPlainObject(value.monetaryFacts)) errors.push('monetaryFacts must be a compact object or null');
    else for (const [field, amount] of Object.entries(value.monetaryFacts)) {
      if (!field.endsWith('Cents')) errors.push(`monetaryFacts.${field} must use a Cents field name`);
      if (!Number.isSafeInteger(amount)) errors.push(`monetaryFacts.${field} must be safe integer cents`);
    }
  }
  optionalNonEmptyString(value.operationGroupId, 'operationGroupId', errors);
  return validationResult('AuditEvent', value, errors);
}

export function validateMerchantRule(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'MerchantRule', errors)) return validationResult('MerchantRule', value, errors);
  requiredString(value.merchantKey, 'merchantKey', errors);
  if (!isPlainObject(value.conditions)) errors.push('conditions must be an object');
  if (!isPlainObject(value.action)) errors.push('action must be an object');
  else optionalString(value.action.bucketId, 'action.bucketId', errors);
  requiredBoolean(value.active, 'active', errors);
  optionalString(value.lastUsedAt, 'lastUsedAt', errors);
  optionalInteger(value.matchCount, 'matchCount', errors, {min:0});
  return validationResult('MerchantRule', value, errors);
}

function validateIngestionResult(value, outerReceipt, errors) {
  if (!isPlainObject(value)) {
    errors.push('result must be an object');
    return;
  }
  const fields = new Set(['batchId', 'payloadDigest', 'status', 'counts', 'safeErrorCodes', 'receipt']);
  rejectUnknownFields(value, fields, 'result', errors);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`result.${field} is required`);
  }
  requiredString(value.batchId, 'result.batchId', errors);
  requiredString(value.payloadDigest, 'result.payloadDigest', errors);
  if (typeof value.payloadDigest === 'string' && !SHA256_DIGEST_PATTERN.test(value.payloadDigest)) {
    errors.push('result.payloadDigest must be a lowercase SHA-256 hex digest');
  }
  requiredEnum(value.status, 'result.status', new Set(['applied', 'conflict', 'quarantined']), errors);

  if (!isPlainObject(value.counts)) errors.push('result.counts must be an object');
  else {
    const countFields = new Set(INGESTION_RESULT_COUNT_FIELDS);
    rejectUnknownFields(value.counts, countFields, 'result.counts', errors);
    for (const field of INGESTION_RESULT_COUNT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(value.counts, field)) errors.push(`result.counts.${field} is required`);
      requiredInteger(value.counts[field], `result.counts.${field}`, errors, {min:0});
    }
    const expectedStatus = value.counts.interpretationConflicts > 0 ? 'conflict'
      : value.counts.sourceRecordsQuarantined > 0 ? 'quarantined' : 'applied';
    if (value.status !== expectedStatus) errors.push(`result.status must be ${expectedStatus} for its counts`);
  }

  if (!Array.isArray(value.safeErrorCodes)
    || value.safeErrorCodes.some(code => typeof code !== 'string' || !code.trim())) {
    errors.push('result.safeErrorCodes must contain non-empty strings');
  }

  if (!isPlainObject(value.receipt)) errors.push('result.receipt must be an object');
  else {
    const receiptFields = new Set(['connectionId', 'batchId', 'payloadDigest']);
    rejectUnknownFields(value.receipt, receiptFields, 'result.receipt', errors);
    for (const field of receiptFields) {
      if (!Object.prototype.hasOwnProperty.call(value.receipt, field)) errors.push(`result.receipt.${field} is required`);
    }
    optionalNonEmptyString(value.receipt.connectionId, 'result.receipt.connectionId', errors);
    requiredString(value.receipt.batchId, 'result.receipt.batchId', errors);
    requiredString(value.receipt.payloadDigest, 'result.receipt.payloadDigest', errors);
    if (typeof value.receipt.payloadDigest === 'string' && !SHA256_DIGEST_PATTERN.test(value.receipt.payloadDigest)) {
      errors.push('result.receipt.payloadDigest must be a lowercase SHA-256 hex digest');
    }
    if (value.receipt.batchId !== outerReceipt.batchId) errors.push('result.receipt.batchId must match batchId');
    if (value.receipt.payloadDigest !== outerReceipt.payloadDigest) errors.push('result.receipt.payloadDigest must match payloadDigest');
    const expectedConnectionId = outerReceipt.sourceKind === 'provider' ? outerReceipt.sourceNamespace : null;
    if (value.receipt.connectionId !== expectedConnectionId) errors.push('result.receipt.connectionId does not match the source identity');
  }

  if (value.batchId !== outerReceipt.batchId) errors.push('result.batchId must match batchId');
  if (value.payloadDigest !== outerReceipt.payloadDigest) errors.push('result.payloadDigest must match payloadDigest');
}

export function validateIngestionReceipt(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'IngestionReceipt', errors)) return validationResult('IngestionReceipt', value, errors);
  const fields = new Set([
    'id', 'batchId', 'payloadDigest', 'sourceKind', 'sourceNamespace', 'adapterKind', 'result', 'createdAt', 'updatedAt'
  ]);
  rejectUnknownFields(value, fields, 'IngestionReceipt', errors);
  for (const field of fields) requireField(value, field, errors);
  requiredString(value.batchId, 'batchId', errors);
  requiredString(value.payloadDigest, 'payloadDigest', errors);
  if (typeof value.payloadDigest === 'string' && !SHA256_DIGEST_PATTERN.test(value.payloadDigest)) {
    errors.push('payloadDigest must be a lowercase SHA-256 hex digest');
  }
  requiredEnum(value.sourceKind, 'sourceKind', SOURCE_KINDS, errors);
  requiredString(value.sourceNamespace, 'sourceNamespace', errors);
  requiredString(value.adapterKind, 'adapterKind', errors);
  validateIngestionResult(value.result, value, errors);
  if (typeof value.payloadDigest === 'string'
    && value.id !== `ingestion-receipt-${value.payloadDigest.slice(0, 20)}`) {
    errors.push('id must be derived from payloadDigest');
  }
  if (value.updatedAt !== value.createdAt) errors.push('updatedAt must match immutable receipt createdAt');
  return validationResult('IngestionReceipt', value, errors);
}

function validateSourceQuarantine(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'SourceQuarantine', errors)) return validationResult('SourceQuarantine', value, errors);
  requiredString(value.batchId, 'batchId', errors);
  requiredEnum(value.sourceKind, 'sourceKind', SOURCE_KINDS, errors);
  requiredString(value.sourceNamespace, 'sourceNamespace', errors);
  requiredString(value.sourceRecordRef, 'sourceRecordRef', errors);
  optionalString(value.sourceAccountRef, 'sourceAccountRef', errors);
  if (value.sourceAccountRef === null) {
    if (value.sourceAccountIdentityDomain !== null) errors.push('sourceAccountIdentityDomain must be null without sourceAccountRef');
  } else {
    requiredEnum(value.sourceAccountIdentityDomain, 'sourceAccountIdentityDomain', SOURCE_ACCOUNT_IDENTITY_DOMAIN_SET, errors);
    if (!sourceAccountReferenceMatchesDomain(value.sourceAccountIdentityDomain, value.sourceAccountRef)) {
      errors.push('sourceAccountRef does not match sourceAccountIdentityDomain');
    }
  }
  requiredEnum(value.reason, 'reason', new Set(['unsupported_currency', 'unsafe_amount', 'missing_account', 'invalid_source_record']), errors);
  optionalString(value.rawAmountDecimal, 'rawAmountDecimal', errors);
  optionalString(value.sourceCurrency, 'sourceCurrency', errors);
  requiredString(value.safeDetailCode, 'safeDetailCode', errors);
  requiredTimestamp(value.observedAt, 'observedAt', errors);
  requiredBoolean(value.active, 'active', errors);
  optionalTimestamp(value.resolvedAt, 'resolvedAt', errors);
  return validationResult('SourceQuarantine', value, errors);
}

function validateSourceTombstone(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'SourceTombstone', errors)) return validationResult('SourceTombstone', value, errors);
  requiredString(value.batchId, 'batchId', errors);
  requiredEnum(value.sourceKind, 'sourceKind', SOURCE_KINDS, errors);
  requiredString(value.sourceNamespace, 'sourceNamespace', errors);
  requiredString(value.sourceRecordRef, 'sourceRecordRef', errors);
  requiredString(value.sourceAccountRef, 'sourceAccountRef', errors);
  requiredEnum(value.sourceAccountIdentityDomain, 'sourceAccountIdentityDomain', SOURCE_ACCOUNT_IDENTITY_DOMAIN_SET, errors);
  if (!sourceAccountReferenceMatchesDomain(value.sourceAccountIdentityDomain, value.sourceAccountRef)) {
    errors.push('sourceAccountRef does not match sourceAccountIdentityDomain');
  }
  requiredString(value.reason, 'reason', errors);
  optionalString(value.predecessorOfRef, 'predecessorOfRef', errors);
  requiredTimestamp(value.observedAt, 'observedAt', errors);
  return validationResult('SourceTombstone', value, errors);
}

function validateInterpretationConflict(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'InterpretationConflict', errors)) return validationResult('InterpretationConflict', value, errors);
  requiredString(value.batchId, 'batchId', errors);
  requiredString(value.transactionId, 'transactionId', errors);
  requiredEnum(value.kind, 'kind', new Set(['source_amount_changed', 'source_removed', 'source_quarantined']), errors);
  requiredEnum(value.status, 'status', new Set(['unresolved', 'resolved']), errors);
  requiredString(value.previousReviewStatus, 'previousReviewStatus', errors);
  requiredString(value.previousMovementType, 'previousMovementType', errors);
  requiredInteger(value.previousAmountCents, 'previousAmountCents', errors, {nonZero:true});
  optionalInteger(value.nextAmountCents, 'nextAmountCents', errors);
  optionalString(value.previousCurrency, 'previousCurrency', errors);
  optionalString(value.nextCurrency, 'nextCurrency', errors);
  if (!Array.isArray(value.allocationSnapshot)) errors.push('allocationSnapshot must be an array');
  if (!Array.isArray(value.relatedClaimIds)) errors.push('relatedClaimIds must be an array');
  optionalObject(value.manualOverridesSnapshot, 'manualOverridesSnapshot', errors);
  optionalString(value.userNoteSnapshot, 'userNoteSnapshot', errors);
  return validationResult('InterpretationConflict', value, errors);
}

function validateSourceAuditEvent(value) {
  const errors = [];
  if (!validateBaseEntity(value, 'SourceAuditEvent', errors)) return validationResult('SourceAuditEvent', value, errors);
  requiredString(value.batchId, 'batchId', errors);
  requiredEnum(value.entityType, 'entityType', new Set(['account', 'transaction', 'quarantine', 'source_tombstone']), errors);
  requiredString(value.entityId, 'entityId', errors);
  requiredString(value.action, 'action', errors);
  if (!Array.isArray(value.changedFields) || value.changedFields.some(field => typeof field !== 'string' || !field)) errors.push('changedFields must contain field names');
  requiredTimestamp(value.observedAt, 'observedAt', errors);
  return validationResult('SourceAuditEvent', value, errors);
}

export function assertValid(result) {
  if (!result.ok) throw new ModelValidationError(result.modelName, result.errors);
  return result.value;
}

export function validateBucketTree(buckets, {legacySemanticType = false} = {}) {
  const errors = [];
  if (!Array.isArray(buckets)) return validationResult('BucketTree', buckets, ['buckets must be an array']);
  const byId = new Map();
  for (const bucket of buckets) {
    const result = validateBucket(bucket, {legacySemanticType});
    if (!result.ok) errors.push(...result.errors.map(error => `${bucket?.id || 'unknown'}: ${error}`));
    else if (byId.has(bucket.id)) errors.push(`duplicate bucket id: ${bucket.id}`);
    else byId.set(bucket.id, bucket);
  }
  for (const bucket of byId.values()) {
    if (!bucket.parentId) continue;
    const parent = byId.get(bucket.parentId);
    if (!parent) errors.push(`bucket ${bucket.id} references missing parent ${bucket.parentId}`);
    else if (parent.id === bucket.id) errors.push(`bucket ${bucket.id} cannot be its own parent`);
    else if (parent.parentId) errors.push(`bucket ${bucket.id} would create a third nesting level`);
  }
  return validationResult('BucketTree', buckets, errors);
}

export function isAllocationActive(allocation) {
  return allocation?.status !== 'superseded';
}

export function isTransactionActiveForReporting(transaction) {
  const lifecycle = transaction?.sourceLifecycle ?? transaction?.pendingStatus;
  return lifecycle !== 'removed' && transaction?.pendingStatus !== 'removed';
}

export function transactionHasUnresolvedInterpretation(transaction) {
  return typeof transaction?.interpretationConflictId === 'string' && transaction.interpretationConflictId.length > 0;
}

export function validateAllocationsForTransaction(allocations, transactionAmountCents) {
  const errors = [];
  if (!Number.isSafeInteger(transactionAmountCents) || transactionAmountCents === 0) errors.push('transactionAmountCents must be a non-zero safe integer');
  if (!Array.isArray(allocations) || allocations.length === 0) errors.push('allocations must contain at least one item');
  else {
    for (const allocation of allocations) {
      const result = validateAllocation(allocation);
      if (!result.ok) errors.push(...result.errors.map(error => `${allocation?.id || 'unknown'}: ${error}`));
    }
    const total = allocations.reduce((sum, allocation) => sum + Number(allocation?.amountCents || 0), 0);
    if (total !== Math.abs(transactionAmountCents)) errors.push(`allocation total ${total} must equal transaction magnitude ${Math.abs(transactionAmountCents)}`);
  }
  return validationResult('AllocationSet', allocations, errors);
}

function validateCollection(domain, field, validator, errors, {validateItems = true, duplicateIds = true} = {}) {
  if (!Array.isArray(domain[field])) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (validateItems) for (const item of domain[field]) {
    const result = validator(item);
    if (!result.ok) errors.push(...result.errors.map(error => `${field}.${item?.id || 'unknown'}: ${error}`));
  }
  if (duplicateIds) {
    const ids = new Set();
    for (const item of domain[field]) {
      if (typeof item?.id !== 'string' || !item.id) continue;
      if (ids.has(item.id)) errors.push(`${field} contains duplicate id ${item.id}`);
      ids.add(item.id);
    }
  }
}

function validateBaseRelationships(domain, errors, {legacySemanticType = false} = {}) {
  const accountIds = new Set(domain.accounts.map(account => account.id));
  const transactionIds = new Set(domain.transactions.map(transaction => transaction.id));
  const bucketIds = new Set(domain.buckets.map(bucket => bucket.id));
  for (const transaction of domain.transactions) {
    if (!accountIds.has(transaction.accountId)) errors.push(`transaction ${transaction.id} references missing account ${transaction.accountId}`);
    const allocations = domain.allocations.filter(allocation => allocation.transactionId === transaction.id && isAllocationActive(allocation));
    if (allocations.length) {
      const allocationValidation = validateAllocationsForTransaction(allocations, transaction.amountCents);
      if (!allocationValidation.ok) errors.push(...allocationValidation.errors.map(error => `transaction ${transaction.id}: ${error}`));
    }
  }
  for (const allocation of domain.allocations) {
    if (!transactionIds.has(allocation.transactionId)) errors.push(`allocation ${allocation.id} references missing transaction ${allocation.transactionId}`);
    const parentBucket = domain.buckets.find(bucket => bucket.id === allocation.bucketId);
    if (!parentBucket) errors.push(`allocation ${allocation.id} references missing bucket ${allocation.bucketId}`);
    else if (parentBucket.parentId) errors.push(`allocation ${allocation.id} bucketId ${allocation.bucketId} must reference a top-level parent bucket`);
    if (allocation.subBucketId) {
      const subBucket = domain.buckets.find(bucket => bucket.id === allocation.subBucketId);
      if (!subBucket) errors.push(`allocation ${allocation.id} references missing sub-bucket ${allocation.subBucketId}`);
      else if (subBucket.parentId !== allocation.bucketId) errors.push(`allocation ${allocation.id} sub-bucket ${allocation.subBucketId} must be a child of ${allocation.bucketId}`);
    }
    if (allocation.status === 'superseded' && !allocation.supersededByConflictId) {
      errors.push(`allocation ${allocation.id} is superseded without an interpretation conflict`);
    }
  }
  for (const rule of domain.merchantRules) {
    if (typeof rule.action.bucketId === 'string' && !bucketIds.has(rule.action.bucketId)) {
      errors.push(`merchant rule ${rule.id} targets missing bucket ${rule.action.bucketId}`);
    }
  }
  const tree = validateBucketTree(domain.buckets, {legacySemanticType});
  if (!tree.ok) errors.push(...tree.errors);

  const accountSourceKeys = new Map();
  for (const account of domain.accounts) {
    if (!account.sourceKind) continue;
    const key = `${account.sourceKind}|${account.sourceNamespace}|${account.sourceAccountRef}`;
    if (accountSourceKeys.has(key)) errors.push(`account ${account.id} duplicates source identity used by ${accountSourceKeys.get(key)}`);
    else accountSourceKeys.set(key, account.id);
  }
  const transactionSourceKeys = new Map();
  for (const transaction of domain.transactions) {
    if (!transaction.sourceKind) continue;
    const sourceAccount = domain.accounts.find(account => account.id === transaction.accountId);
    const explicitUnknownAccount = sourceAccount?.id === UNKNOWN_ACCOUNT_ID
      && transaction.sourceAccountRef === 'unknown-account'
      && transaction.sourceAccountIdentityDomain === SOURCE_ACCOUNT_IDENTITY_DOMAINS.UNKNOWN;
    if (!explicitUnknownAccount && sourceAccount?.sourceKind && (
      sourceAccount.sourceKind !== transaction.sourceKind
      || sourceAccount.sourceNamespace !== transaction.sourceNamespace
      || sourceAccount.sourceAccountRef !== transaction.sourceAccountRef
      || sourceAccount.sourceAccountIdentityDomain !== transaction.sourceAccountIdentityDomain
    )) errors.push(`transaction ${transaction.id} source-account identity does not match account ${sourceAccount.id}`);
    for (const reference of [transaction.sourceRecordRef, ...(transaction.sourceRefAliases || []).map(alias => alias.sourceRecordRef)]) {
      const key = `${transaction.sourceKind}|${transaction.sourceNamespace}|${transaction.sourceAccountRef}|${reference}`;
      if (transactionSourceKeys.has(key) && transactionSourceKeys.get(key) !== transaction.id) {
        errors.push(`transaction ${transaction.id} duplicates source identity used by ${transactionSourceKeys.get(key)}`);
      } else transactionSourceKeys.set(key, transaction.id);
    }
  }
}

function relationshipIdErrors(domain, errors) {
  const ids = new Map();
  for (const field of ['reimbursementClaims', 'reimbursementClaimAllocations', 'reimbursementPaymentLinks', 'reimbursementAdjustments']) {
    for (const item of domain[field]) {
      if (typeof item.id !== 'string' || !item.id) continue;
      if (ids.has(item.id)) errors.push(`${field} id ${item.id} duplicates ${ids.get(item.id)} id`);
      else ids.set(item.id, field);
    }
  }
}

function transactionCalendarDate(transaction) {
  for (const value of [transaction?.displayDate, transaction?.postedAt, transaction?.authorizedAt]) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return new Date(value).toISOString().slice(0, 10);
  }
  return null;
}

function timestampCalendarDate(value) {
  return isTimestamp(value) ? new Date(value).toISOString().slice(0, 10) : null;
}

function reimbursementAmounts(domain, claimId, {asOf = null} = {}) {
  const expectedAmountCents = domain.reimbursementClaimAllocations
    .filter(link => link.claimId === claimId)
    .reduce((sum, link) => sum + link.amountCents, 0);
  const receivedAmountCents = domain.reimbursementPaymentLinks
    .filter(link => {
      if (link.claimId !== claimId || link.voidedAt !== null) return false;
      if (asOf === null) return true;
      const transaction = domain.transactions.find(item => item.id === link.inflowTransactionId);
      const effectiveDate = transactionCalendarDate(transaction);
      return effectiveDate !== null && effectiveDate <= asOf;
    })
    .reduce((sum, link) => sum + link.appliedAmountCents, 0);
  const effectiveAdjustments = domain.reimbursementAdjustments.filter(item => {
    if (item.claimId !== claimId) return false;
    return asOf === null || timestampCalendarDate(item.effectiveAt) <= asOf;
  });
  const writeOffs = effectiveAdjustments.filter(item => item.type === 'write_off');
  const reversals = effectiveAdjustments.filter(item => item.type === 'write_off_reversal');
  const writtenOffAmountCents = writeOffs.reduce((sum, item) => sum + item.amountCents, 0)
    - reversals.reduce((sum, item) => sum + item.amountCents, 0);
  return {
    expectedAmountCents,
    receivedAmountCents,
    writtenOffAmountCents,
    remainingAmountCents:expectedAmountCents - receivedAmountCents - writtenOffAmountCents
  };
}

function derivedStatus(claim, amounts) {
  if (claim.cancelledAt !== null) return 'cancelled';
  if (amounts.remainingAmountCents === 0) return amounts.writtenOffAmountCents > 0 ? 'written_off' : 'settled';
  if (amounts.receivedAmountCents > 0) return 'partially_paid';
  return 'open';
}

export function projectReimbursementClaim(domain, claimId, {asOf = null} = {}) {
  const claim = domain?.reimbursementClaims?.find(item => item.id === claimId);
  if (!claim) throw new Error(`Reimbursement claim ${claimId} does not exist.`);
  if (asOf !== null && !isCalendarDate(asOf)) throw new Error('asOf must be a valid YYYY-MM-DD calendar date.');
  const amounts = reimbursementAmounts(domain, claimId, {asOf});
  const status = derivedStatus(claim, amounts);
  return {
    claimId,
    ...amounts,
    status,
    isOverdue:Boolean(asOf && claim.dueDate && claim.dueDate < asOf && amounts.remainingAmountCents > 0)
  };
}

function validateReimbursementRelationships(domain, errors) {
  relationshipIdErrors(domain, errors);
  const claims = new Map(domain.reimbursementClaims.map(item => [item.id, item]));
  const allocations = new Map(domain.allocations.map(item => [item.id, item]));
  const transactions = new Map(domain.transactions.map(item => [item.id, item]));
  const linksByAllocation = new Map();

  for (const allocation of domain.allocations) {
    if (allocation.reimbursementClaimId !== undefined && allocation.reimbursementClaimId !== null) {
      errors.push(`allocation ${allocation.id} has a deprecated reimbursementClaimId; schema 7 uses claim-allocation relationships`);
    }
  }

  for (const link of domain.reimbursementClaimAllocations) {
    const claim = claims.get(link.claimId);
    const allocation = allocations.get(link.allocationId);
    if (!claim) errors.push(`claim-allocation ${link.id} references missing claim ${link.claimId}`);
    else if (claim.cancelledAt !== null) errors.push(`claim-allocation ${link.id} cannot reference cancelled claim ${claim.id}`);
    if (!allocation) {
      errors.push(`claim-allocation ${link.id} references missing allocation ${link.allocationId}`);
      continue;
    }
    if (allocation.ownershipType !== 'reimbursable') errors.push(`claim-allocation ${link.id} requires reimbursable allocation ${allocation.id}`);
    if (link.amountCents > allocation.amountCents) errors.push(`claim-allocation ${link.id} amount exceeds allocation ${allocation.id}`);
    const transaction = transactions.get(allocation.transactionId);
    if (!transaction) continue;
    if (transaction.amountCents >= 0 || transaction.movementType !== 'expense') errors.push(`claim-allocation ${link.id} requires an expense outflow transaction`);
    if (claim && claim.currency !== transaction.currency) errors.push(`claim-allocation ${link.id} currency does not match claim ${claim.id}`);
    const prior = linksByAllocation.get(allocation.id);
    if (prior) errors.push(`allocation ${allocation.id} belongs to more than one active reimbursement claim`);
    else linksByAllocation.set(allocation.id, link.id);
  }

  for (const claim of domain.reimbursementClaims) {
    const claimLinks = domain.reimbursementClaimAllocations.filter(link => link.claimId === claim.id);
    if (claim.cancelledAt === null && claimLinks.length === 0) errors.push(`active claim ${claim.id} must reference at least one claim-allocation link`);
  }

  const activePaymentFingerprints = new Set();
  const activeInflowTotals = new Map();
  for (const link of domain.reimbursementPaymentLinks) {
    const claim = claims.get(link.claimId);
    const transaction = transactions.get(link.inflowTransactionId);
    if (!claim) errors.push(`payment link ${link.id} references missing claim ${link.claimId}`);
    if (!transaction) errors.push(`payment link ${link.id} references missing inflow transaction ${link.inflowTransactionId}`);
    else {
      if (transaction.amountCents <= 0) errors.push(`payment link ${link.id} requires a positive inflow transaction`);
      if (transaction.movementType !== 'reimbursement') errors.push(`payment link ${link.id} requires a reimbursement inflow`);
      if (claim && claim.currency !== transaction.currency) errors.push(`payment link ${link.id} currency does not match claim ${claim.id}`);
      if (link.voidedAt === null) activeInflowTotals.set(transaction.id, (activeInflowTotals.get(transaction.id) || 0) + link.appliedAmountCents);
    }
    if (link.voidedAt === null) {
      const fingerprint = `${link.claimId}|${link.inflowTransactionId}|${link.appliedAmountCents}`;
      if (activePaymentFingerprints.has(fingerprint)) errors.push(`payment link ${link.id} duplicates another active payment relationship`);
      activePaymentFingerprints.add(fingerprint);
    }
  }
  for (const [transactionId, total] of activeInflowTotals) {
    const transaction = transactions.get(transactionId);
    if (transaction && total > transaction.amountCents) errors.push(`reimbursement inflow ${transactionId} is over-applied across claims`);
  }

  const adjustments = new Map(domain.reimbursementAdjustments.map(item => [item.id, item]));
  const reversedWriteOffs = new Set();
  for (const adjustment of domain.reimbursementAdjustments) {
    const claim = claims.get(adjustment.claimId);
    if (!claim) errors.push(`adjustment ${adjustment.id} references missing claim ${adjustment.claimId}`);
    if (adjustment.type !== 'write_off_reversal') continue;
    const original = adjustments.get(adjustment.reversesAdjustmentId);
    if (!original || original.type !== 'write_off') errors.push(`adjustment ${adjustment.id} must reverse an existing write_off`);
    else {
      if (original.claimId !== adjustment.claimId) errors.push(`adjustment ${adjustment.id} must reverse a write_off on the same claim`);
      if (adjustment.amountCents > original.amountCents) errors.push(`adjustment ${adjustment.id} reversal exceeds write_off ${original.id}`);
      if (Date.parse(adjustment.createdAt) < Date.parse(original.createdAt)) errors.push(`adjustment ${adjustment.id} cannot be created before its write_off`);
      if (Date.parse(adjustment.effectiveAt) < Date.parse(original.effectiveAt)) errors.push(`adjustment ${adjustment.id} cannot take effect before its write_off`);
      if (reversedWriteOffs.has(original.id)) errors.push(`write_off ${original.id} may not be reversed more than once`);
      reversedWriteOffs.add(original.id);
    }
  }

  for (const claim of domain.reimbursementClaims) {
    const amounts = reimbursementAmounts(domain, claim.id);
    if (amounts.writtenOffAmountCents < 0) errors.push(`claim ${claim.id} has reversals exceeding write-offs`);
    if (amounts.remainingAmountCents < 0) errors.push(`claim ${claim.id} received and written-off amounts exceed expected amount`);
    if (claim.cancelledAt !== null) {
      const activePayments = domain.reimbursementPaymentLinks.some(link => link.claimId === claim.id && link.voidedAt === null);
      if (activePayments || amounts.writtenOffAmountCents !== 0) errors.push(`cancelled claim ${claim.id} cannot have active payments or write-offs`);
    }
    let collectible = amounts.expectedAmountCents - amounts.receivedAmountCents;
    const ordered = domain.reimbursementAdjustments.filter(item => item.claimId === claim.id)
      .sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt)
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.id.localeCompare(right.id));
    const activeWriteOffAmounts = new Map();
    for (const adjustment of ordered) {
      if (adjustment.type === 'write_off') {
        if (adjustment.amountCents > collectible) errors.push(`write_off ${adjustment.id} exceeds collectible remaining for claim ${claim.id}`);
        activeWriteOffAmounts.set(adjustment.id, adjustment.amountCents);
        collectible -= adjustment.amountCents;
      } else {
        const active = activeWriteOffAmounts.get(adjustment.reversesAdjustmentId);
        if (active !== undefined) {
          collectible += Math.min(active, adjustment.amountCents);
          activeWriteOffAmounts.delete(adjustment.reversesAdjustmentId);
        }
      }
    }
  }
}

export function validateDomainStore(domain, {legacyReimbursements = false, legacySemanticType = false, legacyDevotionalState = true} = {}) {
  const errors = [];
  if (!isPlainObject(domain)) return validationResult('DomainStore', domain, ['domain must be an object']);
  for (const [field, validator] of [
    ['accounts', validateAccount],
    ['transactions', legacyReimbursements ? validateLegacyTransaction : validateTransaction],
    ['buckets', value => validateBucket(value, {legacySemanticType})],
    ['allocations', validateAllocation],
    ['merchantRules', validateMerchantRule]
  ]) validateCollection(domain, field, validator, errors);

  if (legacyReimbursements) {
    // Schema-6 reimbursement records are compatibility input. Their malformed relationships
    // must reach the migration so they can be preserved with deterministic reason codes.
    validateCollection(domain, 'reimbursementClaims', () => validationResult('LegacyReimbursementClaim', null, []), errors, {validateItems:false, duplicateIds:false});
  } else {
    for (const [field, validator] of [
      ['reimbursementClaims', validateReimbursementClaim],
      ['reimbursementClaimAllocations', validateReimbursementClaimAllocation],
      ['reimbursementPaymentLinks', validateReimbursementPaymentLink],
      ['reimbursementAdjustments', validateReimbursementAdjustment],
      ['auditEvents', validateAuditEvent]
    ]) validateCollection(domain, field, validator, errors);
  }
  for (const [field, validator] of [
    ['ingestionReceipts', validateIngestionReceipt],
    ['sourceQuarantines', validateSourceQuarantine],
    ['sourceTombstones', validateSourceTombstone],
    ['interpretationConflicts', validateInterpretationConflict],
    ['sourceAuditEvents', validateSourceAuditEvent]
  ]) {
    if (domain[field] !== undefined) validateCollection(domain, field, validator, errors);
  }
  if (errors.length) return validationResult('DomainStore', domain, errors);
  if (!legacyDevotionalState || domain.devotionalState !== undefined) {
    const devotionalValidation = validateDevotionalState(domain.devotionalState);
    if (!devotionalValidation.ok) errors.push(...devotionalValidation.errors.map(error => `devotionalState: ${error}`));
  }
  if (errors.length) return validationResult('DomainStore', domain, errors);
  validateBaseRelationships(domain, errors, {legacySemanticType});
  if (!legacyReimbursements) validateReimbursementRelationships(domain, errors);
  if (Array.isArray(domain.interpretationConflicts)) {
    const conflicts = new Map(domain.interpretationConflicts.map(item => [item.id, item]));
    const transactions = new Map(domain.transactions.map(item => [item.id, item]));
    for (const conflict of conflicts.values()) {
      if (!transactions.has(conflict.transactionId)) errors.push(`interpretation conflict ${conflict.id} references missing transaction ${conflict.transactionId}`);
      for (const allocation of conflict.allocationSnapshot || []) {
        if (allocation.transactionId !== conflict.transactionId) errors.push(`interpretation conflict ${conflict.id} contains an unrelated allocation snapshot`);
      }
    }
    for (const transaction of transactions.values()) {
      if (transaction.interpretationConflictId && !conflicts.has(transaction.interpretationConflictId)) {
        errors.push(`transaction ${transaction.id} references missing interpretation conflict ${transaction.interpretationConflictId}`);
      }
    }
    for (const allocation of domain.allocations) {
      if (allocation.status === 'superseded' && !conflicts.has(allocation.supersededByConflictId)) {
        errors.push(`allocation ${allocation.id} references missing interpretation conflict ${allocation.supersededByConflictId}`);
      }
    }
  }
  if (Array.isArray(domain.ingestionReceipts)) {
    const batches = new Map();
    for (const receipt of domain.ingestionReceipts) {
      const prior = batches.get(receipt.batchId);
      if (prior && prior !== receipt.payloadDigest) errors.push(`batch ${receipt.batchId} has conflicting ingestion receipts`);
      batches.set(receipt.batchId, receipt.payloadDigest);
    }
  }
  return validationResult('DomainStore', domain, errors);
}

export function createUnknownAccount(timestamp = '1970-01-01T00:00:00.000Z') {
  return {
    id: UNKNOWN_ACCOUNT_ID,
    institutionId: null,
    externalAccountId: null,
    friendlyName: 'Unknown account',
    officialName: null,
    mask: null,
    type: 'unknown',
    subtype: null,
    currency: DEFAULT_CURRENCY,
    source: 'system',
    active: true,
    balanceCents: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
