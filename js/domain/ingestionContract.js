import {normalizeCurrency, parseActiveUsdSourceAmount, SOURCE_SIGN_CONVENTIONS} from './exactMoney.js';

export const INGESTION_CONTRACT_VERSION = 1;
export const SOURCE_KINDS = Object.freeze(['manual', 'csv', 'provider']);
export const V3A_ADAPTER_KINDS = Object.freeze(['manual.v1', 'csv.generic.v1', 'fixture.v1']);
export const INGESTION_LIMITS = Object.freeze({
  encodedBatchBytes:1_048_576,
  accountMutations:1_000,
  transactionMutations:5_000,
  quarantinedRecords:5_000,
  sourceWarnings:100,
  refChars:256,
  descriptionChars:1_000,
  metadataKeys:24,
  metadataBytes:4_096
});

const SOURCE_KIND_SET = new Set(SOURCE_KINDS);
const SIGN_CONVENTION_SET = new Set(SOURCE_SIGN_CONVENTIONS);
const ACCOUNT_MUTATION_KINDS = new Set(['add', 'modify', 'disconnect']);
const TRANSACTION_MUTATION_KINDS = new Set(['add', 'modify', 'remove']);
const ACCOUNT_TYPES = new Set(['cash', 'depository', 'credit', 'loan', 'savings', 'investment', 'other', 'unknown']);
const ACCOUNT_STATUSES = new Set(['active', 'disconnected', 'closed', 'unknown']);
const LIFECYCLES = new Set(['pending', 'posted', 'unknown']);
const QUARANTINE_REASONS = new Set(['unsupported_currency', 'unsafe_amount', 'missing_account', 'invalid_source_record']);
const REMOVAL_REASONS = new Set(['source_removed', 'pending_expired', 'account_disconnected', 'unknown']);
const LOCATION_SOURCES = new Set(['provider', 'import', 'unavailable']);
const BATCH_ENVIRONMENTS = new Set(['local', 'sandbox', 'production', 'unknown']);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_METADATA_KEY_PATTERN = /(?:^|[_-])(?:access[_-]?token|public[_-]?token|client[_-]?secret|secret|credential|password|authorization|bearer|api[_-]?key|raw[_-]?(?:payload|body)|response[_-]?body|full[_-]?record)(?:$|[_-])/i;

export class IngestionContractError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'IngestionContractError';
    this.code = code;
    this.details = details;
  }
}

export function canonicalExternalSourceReference(rawExternalId) {
  const raw = typeof rawExternalId === 'string' ? rawExternalId.trim() : '';
  const canonical = `external:${raw}`;
  const errors = [];
  if (!raw) errors.push('rawExternalId must be a non-empty string');
  if (canonical.length > INGESTION_LIMITS.refChars) {
    errors.push(`canonical external source reference exceeds ${INGESTION_LIMITS.refChars} characters`);
  }
  if (CONTROL_PATTERN.test(canonical)) errors.push('rawExternalId contains control characters');
  if (errors.length) {
    throw new IngestionContractError(
      'INVALID_RAW_EXTERNAL_REFERENCE',
      'The raw external identifier cannot be represented as a canonical source reference.',
      errors
    );
  }
  return canonical;
}

function contractError(code, errors) {
  throw new IngestionContractError(code, `The ingestion batch is invalid (${code}).`, errors);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stableCanonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right))
      .map(key => `${JSON.stringify(key)}:${stableCanonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes) {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return hex(new Uint8Array(digest));
}

function canonicalBatchIdentityPayload(batch) {
  // Replay identity covers source/content facts. Production and observation
  // timestamps stay on the validated batch for diagnostics, but cannot turn an
  // otherwise identical import into a conflicting idempotency receipt.
  const semantic = structuredClone(batch);
  delete semantic.payloadDigest;
  delete semantic.producedAt;
  delete semantic.observation;
  for (const mutation of semantic.accountMutations || []) delete mutation.observedAt;
  for (const mutation of semantic.transactionMutations || []) delete mutation.observedAt;
  for (const record of semantic.quarantinedRecords || []) delete record.observedAt;
  return semantic;
}

export async function computeBatchDigest(batch) {
  return sha256Text(stableCanonicalJson(canonicalBatchIdentityPayload(batch)));
}

export async function computeLegacyEnvelopeDigest(batch) {
  // Rejected Candidate 1 signed the complete envelope, including observation
  // time. Keep this only for fail-closed recognition of its persisted receipts.
  const unsigned = structuredClone(batch);
  delete unsigned.payloadDigest;
  return sha256Text(stableCanonicalJson(unsigned));
}

export async function finalizeMutationBatch(batch) {
  const finalized = structuredClone(batch);
  finalized.payloadDigest = await computeBatchDigest(finalized);
  return finalized;
}

function exactFields(value, fields, path, errors) {
  if (!plainObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`${path}.${field} is not allowed`);
  for (const field of fields) if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${path}.${field} is required`);
  return true;
}

function string(value, path, errors, {nullable = false, max = INGESTION_LIMITS.refChars, nonempty = true} = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'string') {
    errors.push(`${path} must be ${nullable ? 'a string or null' : 'a string'}`);
    return;
  }
  if (nonempty && !value) errors.push(`${path} must not be empty`);
  if (value.length > max) errors.push(`${path} exceeds ${max} characters`);
  if (CONTROL_PATTERN.test(value)) errors.push(`${path} contains control characters`);
}

function ref(value, path, errors, {nullable = false} = {}) {
  string(value, path, errors, {nullable, max:INGESTION_LIMITS.refChars});
}

function timestamp(value, path, errors, {nullable = false} = {}) {
  if (value === null && nullable) return;
  string(value, path, errors, {max:64});
  if (typeof value === 'string' && Number.isNaN(Date.parse(value))) errors.push(`${path} must be an ISO-compatible timestamp`);
}

function calendarDate(value, path, errors, {nullable = false} = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${path} must be a YYYY-MM-DD date${nullable ? ' or null' : ''}`);
    return;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    errors.push(`${path} must be a real calendar date`);
  }
}

function safeInteger(value, path, errors, {nullable = false, nonZero = false, min = Number.MIN_SAFE_INTEGER} = {}) {
  if (value === null && nullable) return;
  if (!Number.isSafeInteger(value)) errors.push(`${path} must be a safe integer${nullable ? ' or null' : ''}`);
  else if (value < min) errors.push(`${path} must be at least ${min}`);
  else if (nonZero && value === 0) errors.push(`${path} must not be zero`);
}

function boolean(value, path, errors) {
  if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
}

function enumValue(value, allowed, path, errors) {
  if (!allowed.has(value)) errors.push(`${path} has an unsupported value`);
}

function metadata(value, path, errors) {
  if (!plainObject(value)) {
    errors.push(`${path} must be a flat object`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > INGESTION_LIMITS.metadataKeys) errors.push(`${path} has too many keys`);
  if (new TextEncoder().encode(JSON.stringify(value)).length > INGESTION_LIMITS.metadataBytes) errors.push(`${path} is too large`);
  for (const [key, item] of entries) {
    string(key, `${path} key`, errors, {max:64});
    if (FORBIDDEN_METADATA_KEY_PATTERN.test(key)) errors.push(`${path}.${key} is forbidden at the canonical boundary`);
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) errors.push(`${path}.${key} must be a primitive or null`);
    if (typeof item === 'number' && !Number.isFinite(item)) errors.push(`${path}.${key} must be finite`);
    if (typeof item === 'string') string(item, `${path}.${key}`, errors, {max:500, nonempty:false});
  }
}

function validateBalances(value, path, errors) {
  if (value === null) return;
  if (!exactFields(value, ['currentCents', 'availableCents', 'limitCents', 'observedAt'], path, errors)) return;
  for (const field of ['currentCents', 'availableCents', 'limitCents']) safeInteger(value[field], `${path}.${field}`, errors, {nullable:true});
  timestamp(value.observedAt, `${path}.observedAt`, errors, {nullable:true});
}

function validateAccountRecord(value, path, errors) {
  if (!exactFields(value, [
    'officialName', 'providerDisplayName', 'institution', 'type', 'subtype', 'mask', 'currency',
    'sourceStatus', 'balances', 'metadata'
  ], path, errors)) return;
  string(value.officialName, `${path}.officialName`, errors, {nullable:true, max:300, nonempty:false});
  string(value.providerDisplayName, `${path}.providerDisplayName`, errors, {nullable:true, max:300, nonempty:false});
  if (exactFields(value.institution, ['sourceInstitutionRef', 'name'], `${path}.institution`, errors)) {
    ref(value.institution.sourceInstitutionRef, `${path}.institution.sourceInstitutionRef`, errors, {nullable:true});
    string(value.institution.name, `${path}.institution.name`, errors, {nullable:true, max:300, nonempty:false});
  }
  enumValue(value.type, ACCOUNT_TYPES, `${path}.type`, errors);
  string(value.subtype, `${path}.subtype`, errors, {nullable:true, max:100, nonempty:false});
  string(value.mask, `${path}.mask`, errors, {nullable:true, max:32, nonempty:false});
  if (value.currency !== null && normalizeCurrency(value.currency) !== value.currency) errors.push(`${path}.currency must be an uppercase three-letter code or null`);
  enumValue(value.sourceStatus, ACCOUNT_STATUSES, `${path}.sourceStatus`, errors);
  validateBalances(value.balances, `${path}.balances`, errors);
  metadata(value.metadata, `${path}.metadata`, errors);
}

function validateAccountMutation(value, index, errors) {
  const path = `accountMutations[${index}]`;
  if (!exactFields(value, ['kind', 'sourceAccountRef', 'observedAt', 'account'], path, errors)) return;
  enumValue(value.kind, ACCOUNT_MUTATION_KINDS, `${path}.kind`, errors);
  ref(value.sourceAccountRef, `${path}.sourceAccountRef`, errors);
  timestamp(value.observedAt, `${path}.observedAt`, errors);
  if (value.kind === 'disconnect') {
    if (value.account !== null) errors.push(`${path}.account must be null for disconnect`);
  } else if (value.account === null) errors.push(`${path}.account is required for ${value.kind}`);
  else validateAccountRecord(value.account, `${path}.account`, errors);
}

function validateMerchant(value, path, errors) {
  if (value === null) return;
  if (!exactFields(value, ['name', 'sourceEntityRef', 'websiteHost'], path, errors)) return;
  string(value.name, `${path}.name`, errors, {nullable:true, max:300, nonempty:false});
  ref(value.sourceEntityRef, `${path}.sourceEntityRef`, errors, {nullable:true});
  string(value.websiteHost, `${path}.websiteHost`, errors, {nullable:true, max:253, nonempty:false});
}

function validateProviderCategory(value, path, errors) {
  if (value === null) return;
  if (!exactFields(value, ['primary', 'detailed', 'confidence', 'taxonomyVersion'], path, errors)) return;
  for (const field of ['primary', 'detailed', 'confidence', 'taxonomyVersion']) {
    string(value[field], `${path}.${field}`, errors, {nullable:true, max:200, nonempty:false});
  }
}

function validateLocation(value, path, errors) {
  if (!exactFields(value, ['region', 'country', 'source'], path, errors)) return;
  string(value.region, `${path}.region`, errors, {nullable:true, max:100, nonempty:false});
  string(value.country, `${path}.country`, errors, {nullable:true, max:100, nonempty:false});
  enumValue(value.source, LOCATION_SOURCES, `${path}.source`, errors);
}

function validateSourceAmount(value, record, path, errors) {
  if (!exactFields(value, ['decimal', 'currency', 'signConvention'], path, errors)) return;
  string(value.decimal, `${path}.decimal`, errors, {max:100});
  if (normalizeCurrency(value.currency) !== value.currency) errors.push(`${path}.currency must be an explicit uppercase three-letter code`);
  enumValue(value.signConvention, SIGN_CONVENTION_SET, `${path}.signConvention`, errors);
  try {
    const parsed = parseActiveUsdSourceAmount({...value, direction:record.metadata?.debitCreditDirection ?? null});
    if (parsed.amountCents !== record.amountCents) errors.push(`${path} does not reconcile to amountCents`);
  } catch (error) {
    errors.push(`${path} is invalid: ${error.code || 'INVALID_AMOUNT'}`);
  }
}

function validateTransactionRecord(value, path, errors) {
  if (!exactFields(value, [
    'lifecycle', 'predecessorSourceRef', 'amountCents', 'currency', 'sourceAmount', 'sourceDate',
    'authorizedDate', 'authorizedAt', 'postedDate', 'postedAt', 'rawDescription', 'displayDescription',
    'merchant', 'providerCategory', 'paymentChannel', 'location', 'sourceRevision', 'sourceUpdatedAt', 'metadata'
  ], path, errors)) return;
  enumValue(value.lifecycle, LIFECYCLES, `${path}.lifecycle`, errors);
  ref(value.predecessorSourceRef, `${path}.predecessorSourceRef`, errors, {nullable:true});
  safeInteger(value.amountCents, `${path}.amountCents`, errors, {nonZero:true});
  if (value.currency !== 'USD') errors.push(`${path}.currency must be USD for an active transaction`);
  validateSourceAmount(value.sourceAmount, value, `${path}.sourceAmount`, errors);
  calendarDate(value.sourceDate, `${path}.sourceDate`, errors);
  calendarDate(value.authorizedDate, `${path}.authorizedDate`, errors, {nullable:true});
  timestamp(value.authorizedAt, `${path}.authorizedAt`, errors, {nullable:true});
  calendarDate(value.postedDate, `${path}.postedDate`, errors, {nullable:true});
  timestamp(value.postedAt, `${path}.postedAt`, errors, {nullable:true});
  string(value.rawDescription, `${path}.rawDescription`, errors, {nullable:true, max:INGESTION_LIMITS.descriptionChars, nonempty:false});
  string(value.displayDescription, `${path}.displayDescription`, errors, {nullable:true, max:INGESTION_LIMITS.descriptionChars, nonempty:false});
  validateMerchant(value.merchant, `${path}.merchant`, errors);
  validateProviderCategory(value.providerCategory, `${path}.providerCategory`, errors);
  string(value.paymentChannel, `${path}.paymentChannel`, errors, {nullable:true, max:100, nonempty:false});
  validateLocation(value.location, `${path}.location`, errors);
  ref(value.sourceRevision, `${path}.sourceRevision`, errors, {nullable:true});
  timestamp(value.sourceUpdatedAt, `${path}.sourceUpdatedAt`, errors, {nullable:true});
  metadata(value.metadata, `${path}.metadata`, errors);
}

function validateRemoval(value, path, errors) {
  if (value === null) return;
  if (!exactFields(value, ['reason', 'predecessorOfRef'], path, errors)) return;
  enumValue(value.reason, REMOVAL_REASONS, `${path}.reason`, errors);
  ref(value.predecessorOfRef, `${path}.predecessorOfRef`, errors, {nullable:true});
}

function validateTransactionMutation(value, index, errors) {
  const path = `transactionMutations[${index}]`;
  if (!exactFields(value, ['kind', 'sourceRecordRef', 'sourceAccountRef', 'observedAt', 'record', 'removal'], path, errors)) return;
  enumValue(value.kind, TRANSACTION_MUTATION_KINDS, `${path}.kind`, errors);
  ref(value.sourceRecordRef, `${path}.sourceRecordRef`, errors);
  ref(value.sourceAccountRef, `${path}.sourceAccountRef`, errors);
  timestamp(value.observedAt, `${path}.observedAt`, errors);
  if (value.kind === 'remove') {
    if (value.record !== null) errors.push(`${path}.record must be null for remove`);
    if (value.removal === null) errors.push(`${path}.removal is required for remove`);
  } else {
    if (value.record === null) errors.push(`${path}.record is required for ${value.kind}`);
    if (value.removal !== null) errors.push(`${path}.removal must be null for ${value.kind}`);
  }
  if (value.record !== null) {
    validateTransactionRecord(value.record, `${path}.record`, errors);
    if (value.record.predecessorSourceRef !== null && value.kind !== 'add') {
      errors.push(`${path}.record.predecessorSourceRef is allowed only on an add`);
    }
    if (value.record.predecessorSourceRef !== null && value.record.lifecycle !== 'posted') {
      errors.push(`${path}.record.predecessorSourceRef requires a posted lifecycle`);
    }
  }
  validateRemoval(value.removal, `${path}.removal`, errors);
}

function validateQuarantine(value, index, errors) {
  const path = `quarantinedRecords[${index}]`;
  if (!exactFields(value, [
    'sourceRecordRef', 'sourceAccountRef', 'observedAt', 'reason', 'rawAmountDecimal', 'sourceCurrency', 'safeDetailCode'
  ], path, errors)) return;
  ref(value.sourceRecordRef, `${path}.sourceRecordRef`, errors);
  ref(value.sourceAccountRef, `${path}.sourceAccountRef`, errors, {nullable:true});
  timestamp(value.observedAt, `${path}.observedAt`, errors);
  enumValue(value.reason, QUARANTINE_REASONS, `${path}.reason`, errors);
  string(value.rawAmountDecimal, `${path}.rawAmountDecimal`, errors, {nullable:true, max:100, nonempty:false});
  string(value.sourceCurrency, `${path}.sourceCurrency`, errors, {nullable:true, max:32, nonempty:false});
  string(value.safeDetailCode, `${path}.safeDetailCode`, errors, {max:100});
}

function validateWarning(value, index, errors) {
  const path = `sourceWarnings[${index}]`;
  if (!exactFields(value, ['code', 'count', 'safeMessage'], path, errors)) return;
  string(value.code, `${path}.code`, errors, {max:100});
  safeInteger(value.count, `${path}.count`, errors, {min:1});
  string(value.safeMessage, `${path}.safeMessage`, errors, {max:300});
}

function validateObservation(value, errors) {
  if (!exactFields(value, ['startedAt', 'completedAt', 'environment', 'requestRef'], 'observation', errors)) return;
  timestamp(value.startedAt, 'observation.startedAt', errors);
  timestamp(value.completedAt, 'observation.completedAt', errors);
  enumValue(value.environment, BATCH_ENVIRONMENTS, 'observation.environment', errors);
  ref(value.requestRef, 'observation.requestRef', errors, {nullable:true});
  if (!Number.isNaN(Date.parse(value.startedAt)) && !Number.isNaN(Date.parse(value.completedAt))
    && Date.parse(value.completedAt) < Date.parse(value.startedAt)) errors.push('observation.completedAt precedes startedAt');
}

function validateCheckpoint(value, errors) {
  if (value === null) return;
  if (!exactFields(value, ['baseRef', 'proposedRef', 'generation'], 'checkpoint', errors)) return;
  ref(value.baseRef, 'checkpoint.baseRef', errors, {nullable:true});
  ref(value.proposedRef, 'checkpoint.proposedRef', errors, {nullable:true});
  safeInteger(value.generation, 'checkpoint.generation', errors, {nullable:true, min:0});
}

function validateDuplicateAndLineageRules(batch, errors) {
  const accounts = new Set();
  for (const mutation of batch.accountMutations || []) {
    if (accounts.has(mutation.sourceAccountRef)) errors.push(`duplicate account mutation for ${mutation.sourceAccountRef}`);
    accounts.add(mutation.sourceAccountRef);
  }
  const transactionKey = (accountRef, recordRef) => `${accountRef}\u001f${recordRef}`;
  const transactions = new Map();
  const transactionsByRef = new Map();
  const successorByPredecessor = new Map();
  for (const mutation of batch.transactionMutations || []) {
    const mutationKey = transactionKey(mutation.sourceAccountRef, mutation.sourceRecordRef);
    if (transactions.has(mutationKey)) errors.push(`duplicate transaction mutation for ${mutation.sourceRecordRef} on ${mutation.sourceAccountRef}`);
    transactions.set(mutationKey, mutation);
    const sameRef = transactionsByRef.get(mutation.sourceRecordRef) || [];
    sameRef.push(mutation);
    transactionsByRef.set(mutation.sourceRecordRef, sameRef);
    const predecessor = mutation.record?.predecessorSourceRef;
    if (!predecessor) continue;
    if (predecessor === mutation.sourceRecordRef) errors.push(`transaction ${mutation.sourceRecordRef} cannot be its own predecessor`);
    const predecessorKey = transactionKey(mutation.sourceAccountRef, predecessor);
    if (successorByPredecessor.has(predecessorKey)) errors.push(`predecessor ${predecessor} has multiple successors on ${mutation.sourceAccountRef}`);
    successorByPredecessor.set(predecessorKey, mutation);
  }
  for (const [predecessorKey, successor] of successorByPredecessor) {
    const predecessorRef = successor.record.predecessorSourceRef;
    const predecessor = transactions.get(predecessorKey);
    if (!predecessor && (transactionsByRef.get(predecessorRef) || []).some(item => item.sourceAccountRef !== successor.sourceAccountRef)) {
      errors.push(`predecessor ${predecessorRef} crosses source accounts`);
    }
    const seen = new Set([transactionKey(successor.sourceAccountRef, successor.sourceRecordRef)]);
    let cursor = predecessorKey;
    while (cursor) {
      if (seen.has(cursor)) { errors.push(`predecessor cycle includes ${cursor}`); break; }
      seen.add(cursor);
      const nextRef = transactions.get(cursor)?.record?.predecessorSourceRef || null;
      cursor = nextRef ? transactionKey(successor.sourceAccountRef, nextRef) : null;
    }
  }
  const quarantined = new Set();
  for (const item of batch.quarantinedRecords || []) {
    const quarantineKey = transactionKey(item.sourceAccountRef, item.sourceRecordRef);
    if (quarantined.has(quarantineKey)) errors.push(`duplicate quarantine for ${item.sourceRecordRef} on ${item.sourceAccountRef}`);
    quarantined.add(quarantineKey);
    if (transactions.has(quarantineKey)) errors.push(`source record ${item.sourceRecordRef} cannot be active and quarantined in one batch`);
  }
}

export async function validateSourceMutationBatch(batch, {adapterKinds = V3A_ADAPTER_KINDS} = {}) {
  const errors = [];
  if (!exactFields(batch, [
    'contractVersion', 'batchId', 'sourceKind', 'adapterKind', 'sourceNamespace', 'producedAt',
    'observation', 'checkpoint', 'accountMutations', 'transactionMutations', 'quarantinedRecords',
    'sourceWarnings', 'payloadDigest'
  ], 'batch', errors)) contractError('INVALID_BATCH_SHAPE', errors);
  if (batch.contractVersion !== INGESTION_CONTRACT_VERSION) errors.push('contractVersion is unsupported');
  ref(batch.batchId, 'batchId', errors);
  enumValue(batch.sourceKind, SOURCE_KIND_SET, 'sourceKind', errors);
  string(batch.adapterKind, 'adapterKind', errors, {max:100});
  if (!new Set(adapterKinds).has(batch.adapterKind)) errors.push('adapterKind is not allowlisted');
  ref(batch.sourceNamespace, 'sourceNamespace', errors);
  timestamp(batch.producedAt, 'producedAt', errors);
  validateObservation(batch.observation, errors);
  validateCheckpoint(batch.checkpoint, errors);
  for (const [field, maximum] of [
    ['accountMutations', INGESTION_LIMITS.accountMutations],
    ['transactionMutations', INGESTION_LIMITS.transactionMutations],
    ['quarantinedRecords', INGESTION_LIMITS.quarantinedRecords],
    ['sourceWarnings', INGESTION_LIMITS.sourceWarnings]
  ]) {
    if (!Array.isArray(batch[field])) errors.push(`${field} must be an array`);
    else if (batch[field].length > maximum) errors.push(`${field} exceeds the batch limit`);
  }
  (batch.accountMutations || []).forEach((value, index) => validateAccountMutation(value, index, errors));
  (batch.transactionMutations || []).forEach((value, index) => validateTransactionMutation(value, index, errors));
  (batch.quarantinedRecords || []).forEach((value, index) => validateQuarantine(value, index, errors));
  (batch.sourceWarnings || []).forEach((value, index) => validateWarning(value, index, errors));
  validateDuplicateAndLineageRules(batch, errors);
  const encodedBytes = new TextEncoder().encode(stableCanonicalJson(batch)).length;
  if (encodedBytes > INGESTION_LIMITS.encodedBatchBytes) errors.push('batch exceeds the encoded byte limit');
  if (typeof batch.payloadDigest !== 'string' || !DIGEST_PATTERN.test(batch.payloadDigest)) errors.push('payloadDigest must be a lowercase SHA-256 hex digest');
  else if (await computeBatchDigest(batch) !== batch.payloadDigest) errors.push('payloadDigest does not match the canonical batch');
  if (errors.length) contractError('BATCH_VALIDATION_FAILED', errors);
  return batch;
}
