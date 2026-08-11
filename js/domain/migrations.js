import {PRODUCT_NAME, STARTER_SPENDING_BUCKETS, STATE_SCHEMA_VERSION, SYSTEM_BUCKET_IDS, UNKNOWN_ACCOUNT_ID} from './constants.js';
import {FAITH_MONEY_DEVOTIONALS} from '../content/faithMoneyDevotionals.js';
import {createUnknownAccount, validateAuditEvent, validateDomainStore, validateBucket} from './models.js';
import {formatSignedCents} from './exactMoney.js';
import {canonicalTransactionFromLegacy, deterministicAllocationId} from '../services/allocationService.js';
import {initializeStateRevision} from '../services/stateRevision.js';

const FOUNDATION_MIGRATIONS = [
  {from:1, to:2, id:'v1-preserve-legacy-state', migrate:preserveLegacyState},
  {from:2, to:3, id:'v2-foundation-domain-store', migrate:initializeDomainStore},
  {from:3, to:4, id:'v2-foundation-canonical-name', migrate:initializeFoundationV4},
  {from:4, to:5, id:'v2a-bucket-explorer-fields', migrate:initializeBucketExplorerFields},
  {from:5, to:6, id:'v2a-transaction-allocations', migrate:migrateTraceableLegacyAssignments},
  {from:6, to:7, id:'v2a-reimbursement-relationship-foundation', migrate:migrateReimbursementRelationships},
  {from:7, to:8, id:'v2b-desktop-beta-bucket-workflow', migrate:initializeDesktopBetaBucketWorkflow},
  {from:8, to:9, id:'v2c-faith-money-devotional-state', migrate:initializeFaithMoneyDevotionalState},
  {from:9, to:10, id:'v3a-provider-neutral-ingestion', migrate:initializeProviderNeutralIngestion}
];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isCurrency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function stableHash(value) {
  let result = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right))
      .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function semanticClaimKey(claim) {
  if (!isPlainObject(claim)) return stableSerialize(claim);
  const normalized = clone(claim);
  if (Array.isArray(normalized.allocationIds)) normalized.allocationIds.sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  if (Array.isArray(normalized.repaymentLinks)) normalized.repaymentLinks.sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  return stableSerialize(normalized);
}

export function deterministicReimbursementId(kind, ...parts) {
  return `${kind}-${stableHash(parts.join('|'))}`;
}

function sourceVersion(input) {
  const version = Number(input?.schemaVersion);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function isTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function resolveMigrationTimestamp(input, providedNow) {
  if (providedNow !== undefined) {
    if (!isTimestamp(providedNow)) throw new Error('Migration timestamp must be ISO-compatible.');
    return providedNow;
  }
  const asOf = input?.providerSnapshot?.asOf;
  if (typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf) && !Number.isNaN(Date.parse(`${asOf}T12:00:00.000Z`))) {
    return `${asOf}T12:00:00.000Z`;
  }
  return '1970-01-01T00:00:00.000Z';
}

function assertValidMigrationState(state, phase) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`${phase} state must be an object.`);
  if (state.domain !== undefined) {
    const version = sourceVersion(state);
    const validation = validateDomainStore(state.domain, {
      legacyReimbursements:version < 7,
      legacySemanticType:version < 8,
      legacyDevotionalState:version < 9
    });
    if (!validation.ok) throw new Error(`${phase} state failed foundation validation: ${validation.errors.join('; ')}`);
  }
}

function toCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function isoMonth(value) {
  const candidate = String(value || '').slice(0,7);
  return /^\d{4}-\d{2}$/.test(candidate) ? candidate : 'legacy-unknown-month';
}

function timestampFor(state, fallback) {
  const asOf = state?.providerSnapshot?.asOf;
  return typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf) && !Number.isNaN(Date.parse(`${asOf}T12:00:00.000Z`))
    ? `${asOf}T12:00:00.000Z`
    : fallback;
}

function migrationMetadata(state) {
  state.migration = asObject(state.migration);
  state.migration.appliedMigrations = Array.isArray(state.migration.appliedMigrations)
    ? state.migration.appliedMigrations
    : [];
  return state.migration;
}

function preserveLegacyState(state, {now}) {
  state.legacyV1 = asObject(state.legacyV1);
  if (!state.legacyV1.originalSchemaVersion) state.legacyV1.originalSchemaVersion = sourceVersion(state);
  if (Array.isArray(state.categories) && !Array.isArray(state.legacyV1.categories)) state.legacyV1.categories = clone(state.categories);
  if (Array.isArray(state.review?.buckets) && !Array.isArray(state.legacyV1.reviewBuckets)) state.legacyV1.reviewBuckets = clone(state.review.buckets);
  return state;
}

function candidateBuckets(state) {
  const categories = Array.isArray(state.categories) ? state.categories : [];
  const reviewBuckets = Array.isArray(state.legacyV1?.reviewBuckets)
    ? state.legacyV1.reviewBuckets
    : (Array.isArray(state.review?.buckets) ? state.review.buckets : []);
  const seen = new Set();
  return [...categories, ...reviewBuckets].filter(bucket => {
    const id = bucket?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function legacySnapshotFromCategories(state) {
  const categories = Array.isArray(state.categories) ? state.categories : [];
  if (!categories.some(category => Object.prototype.hasOwnProperty.call(category || {}, 'actual'))) return null;
  const month = isoMonth(state.monthly?.selectedMonth || state.monthly?.activeMonth || state.providerSnapshot?.asOf);
  return {
    id:`legacy-monthly-snapshot-${month}`,
    month,
    label:'Legacy V1 aggregate snapshot — no transaction detail',
    incomeBaselineCents:toCents(state.preferences?.monthlyIncome || state.providerSnapshot?.averageMonthlyIncome),
    bucketActualsCents:Object.fromEntries(categories.map(category => [String(category.id || category.name), toCents(category.actual)])),
    source:'v1-migration'
  };
}

function legacyBalanceSnapshot(state) {
  const snapshot = state.providerSnapshot;
  if (!snapshot?.asOf) return null;
  return {
    id:`legacy-balance-snapshot-${snapshot.asOf}`,
    asOf:snapshot.asOf,
    label:'Legacy V1 balance snapshot — not normalized account history',
    cashTotalCents:toCents(snapshot.cashTotal),
    creditDebtTotalCents:toCents(snapshot.creditDebtTotal),
    netWorthCents:toCents(snapshot.netWorth),
    source:'v1-migration'
  };
}

function initializeDomainStore(state, {now}) {
  const domain = asObject(state.domain);
  domain.accounts = Array.isArray(domain.accounts) ? domain.accounts : [];
  domain.transactions = Array.isArray(domain.transactions) ? domain.transactions : [];
  domain.buckets = Array.isArray(domain.buckets) ? domain.buckets : [];
  domain.allocations = Array.isArray(domain.allocations) ? domain.allocations : [];
  domain.reimbursementClaims = Array.isArray(domain.reimbursementClaims) ? domain.reimbursementClaims : [];
  domain.reimbursementClaimAllocations = Array.isArray(domain.reimbursementClaimAllocations) ? domain.reimbursementClaimAllocations : [];
  domain.reimbursementPaymentLinks = Array.isArray(domain.reimbursementPaymentLinks) ? domain.reimbursementPaymentLinks : [];
  domain.reimbursementAdjustments = Array.isArray(domain.reimbursementAdjustments) ? domain.reimbursementAdjustments : [];
  domain.merchantRules = Array.isArray(domain.merchantRules) ? domain.merchantRules : [];
  domain.auditEvents = Array.isArray(domain.auditEvents) ? domain.auditEvents : [];
  domain.legacyMonthlySnapshots = Array.isArray(domain.legacyMonthlySnapshots) ? domain.legacyMonthlySnapshots : [];
  domain.legacyBalanceSnapshots = Array.isArray(domain.legacyBalanceSnapshots) ? domain.legacyBalanceSnapshots : [];

  if (!domain.accounts.some(account => account?.id === 'unknown-account')) {
    domain.accounts.push(createUnknownAccount(timestampFor(state, now)));
  }

  const existingBucketIds = new Set(domain.buckets.map(bucket => bucket?.id));
  for (const bucket of candidateBuckets(state)) {
    if (!bucket || bucket.system || !bucket.id || existingBucketIds.has(bucket.id)) continue;
    const migrated = {
      id:String(bucket.id),
      parentId:null,
      name:String(bucket.name || bucket.id),
      group:String(bucket.group || 'Uncategorized'),
      order:Number.isSafeInteger(bucket.order) ? bucket.order : domain.buckets.length,
      targetCents:toCents(bucket.target),
      protected:Boolean(bucket.protected),
      semanticType:'spending',
      system:false,
      active:bucket.active !== false && !bucket.archivedAt,
      description:typeof bucket.description === 'string' ? bucket.description : null,
      archivedAt:bucket.archivedAt || (bucket.active === false ? timestampFor(state, now) : null),
      createdAt:timestampFor(state, now),
      updatedAt:timestampFor(state, now)
    };
    if (validateBucket(migrated).ok) {
      domain.buckets.push(migrated);
      existingBucketIds.add(migrated.id);
    }
  }

  const monthlySnapshot = legacySnapshotFromCategories(state);
  if (monthlySnapshot && !domain.legacyMonthlySnapshots.some(item => item.id === monthlySnapshot.id)) {
    domain.legacyMonthlySnapshots.push(monthlySnapshot);
  }
  const balanceSnapshot = legacyBalanceSnapshot(state);
  if (balanceSnapshot && !domain.legacyBalanceSnapshots.some(item => item.id === balanceSnapshot.id)) {
    domain.legacyBalanceSnapshots.push(balanceSnapshot);
  }
  state.domain = domain;
  return state;
}

function hasFreshVaultEvidence(state) {
  const domain = asObject(state.domain);
  const domainCollections = [
    'transactions', 'buckets', 'allocations', 'reimbursementClaims',
    'reimbursementClaimAllocations', 'reimbursementPaymentLinks', 'reimbursementAdjustments',
    'merchantRules', 'auditEvents', 'legacyMonthlySnapshots', 'legacyBalanceSnapshots'
  ];
  if (domainCollections.some(field => Array.isArray(domain[field]) && domain[field].length > 0)) return false;
  // Schema 3+ always materializes this structural placeholder. It does not mean
  // the user has started using the vault, but every other account does.
  if (Array.isArray(domain.accounts) && domain.accounts.some(account => account?.id !== UNKNOWN_ACCOUNT_ID)) return false;
  if (Array.isArray(state.review?.transactions) && state.review.transactions.length > 0) return false;
  if (Array.isArray(state.review?.buckets) && state.review.buckets.length > 0) return false;
  if (Array.isArray(state.review?.merchantRules) && state.review.merchantRules.length > 0) return false;
  if (Array.isArray(state.categories) && state.categories.length > 0) return false;
  if (Array.isArray(state.legacyV1?.categories) && state.legacyV1.categories.length > 0) return false;
  if (Array.isArray(state.legacyV1?.reviewBuckets) && state.legacyV1.reviewBuckets.length > 0) return false;
  if (Array.isArray(state.debts) && state.debts.length > 0) return false;
  if (Array.isArray(state.goals) && state.goals.length > 0) return false;
  if (Array.isArray(state.travel?.visited) && state.travel.visited.length > 0) return false;
  if (Array.isArray(state.travel?.destinations) && state.travel.destinations.length > 0) return false;
  if (Array.isArray(state.scriptures) && state.scriptures.length > 0) return false;
  if (state.monthly?.history && typeof state.monthly.history === 'object' && Object.keys(state.monthly.history).length > 0) return false;
  if (Array.isArray(state.providerSnapshot?.accounts) && state.providerSnapshot.accounts.length > 0) return false;
  if (Array.isArray(state.providerSnapshot?.recurring) && state.providerSnapshot.recurring.length > 0) return false;
  if (isCalendarDate(state.providerSnapshot?.asOf)) return false;
  return true;
}

function mirrorBucketToLegacyReview(state, bucket) {
  state.review = asObject(state.review);
  state.review.buckets = Array.isArray(state.review.buckets) ? state.review.buckets : [];
  let legacy = state.review.buckets.find(item => item?.id === bucket.id);
  if (!legacy) {
    legacy = {id:bucket.id};
    state.review.buckets.push(legacy);
  }
  Object.assign(legacy, {
    name:bucket.name, group:bucket.group, target:bucket.targetCents / 100, order:bucket.order,
    parentId:bucket.parentId, active:bucket.active, archivedAt:bucket.archivedAt,
    description:bucket.description, protected:bucket.protected, system:bucket.system,
    semanticType:bucket.semanticType
  });
}

function systemBucket(definition, order, now) {
  return {
    id:definition.id, parentId:null, name:definition.name, group:'System classification', order,
    targetCents:0, protected:true, semanticType:definition.semanticType, system:true, active:true,
    description:definition.description, archivedAt:null, createdAt:now, updatedAt:now
  };
}

const SYSTEM_BUCKET_DEFINITIONS = Object.freeze([
  {id:SYSTEM_BUCKET_IDS.income, name:'Income', semanticType:'income', description:'Classifies money coming in; it is not a spending-plan bucket.'},
  {id:SYSTEM_BUCKET_IDS.transfer, name:'Money Transfer', semanticType:'transfer', description:'Classifies movement between your accounts; it is neither income nor spending.'},
  {id:SYSTEM_BUCKET_IDS.debtPayment, name:'Debt Payment', semanticType:'debt_payment', description:'Classifies debt repayment separately from ordinary discretionary spending.'}
]);

// Schema 8 only seeds everyday buckets for a genuinely brand-new empty vault.
// Any legacy review, category, domain, transaction, allocation, rule, snapshot,
// reimbursement, or audit record prevents seeding. System classifications are
// added independently with fixed IDs so older vaults gain explicit semantics
// without using (or converting) names such as "Income" or "Transfer".
function initializeDesktopBetaBucketWorkflow(state, {now, freshVaultAtStart = false}) {
  const isFreshVault = freshVaultAtStart;
  initializeDomainStore(state, {now});
  const domain = state.domain;
  const alreadySystemIds = new Set();
  for (const definition of SYSTEM_BUCKET_DEFINITIONS) {
    const existing = domain.buckets.find(bucket => bucket.id === definition.id);
    if (!existing) continue;
    const alreadySystem = existing.system === true && existing.protected === true
      && existing.parentId === null && existing.semanticType === definition.semanticType;
    // This covers a safely repeated recovery migration. Any other collision
    // is a user-owned bucket that must not be overwritten merely because its
    // ID matches a reserved V2B ID.
    if (!alreadySystem) {
      throw new Error(`Schema 7 vault uses reserved system bucket id ${definition.id}; migration stopped without modifying the vault.`);
    }
    alreadySystemIds.add(definition.id);
  }
  for (const bucket of domain.buckets) {
    if (alreadySystemIds.has(bucket.id)) continue;
    // Schema 7 did not support classifications. Treat every existing user
    // bucket as ordinary spending rather than trusting partial forward fields.
    bucket.semanticType = 'spending';
    bucket.system = false;
  }

  if (isFreshVault) {
    for (const [order, starter] of STARTER_SPENDING_BUCKETS.entries()) {
      domain.buckets.push({
        id:starter.id, parentId:null, name:starter.name, group:starter.group, order,
        targetCents:0, protected:false, semanticType:'spending', system:false, active:true,
        description:null, archivedAt:null, createdAt:now, updatedAt:now
      });
    }
  }

  let nextOrder = Math.max(-1, ...domain.buckets.filter(bucket => !bucket.parentId).map(bucket => Number(bucket.order) || 0)) + 1;
  for (const definition of SYSTEM_BUCKET_DEFINITIONS) {
    const existing = domain.buckets.find(bucket => bucket.id === definition.id);
    if (!existing) {
      domain.buckets.push(systemBucket(definition, nextOrder++, now));
    }
  }
  for (const bucket of domain.buckets) mirrorBucketToLegacyReview(state, bucket);
  return state;
}

function initializeFaithMoneyDevotionalState(state, {now}) {
  initializeDomainStore(state, {now});
  if (state.domain.devotionalState === undefined) {
    state.domain.devotionalState = {
      activeDevotionalId:FAITH_MONEY_DEVOTIONALS[0].id,
      rotationStartedAt:now,
      lastOpenedAt:null,
      completedDevotionalIds:[],
      savedDevotionalIds:[],
      entries:[]
    };
  }
  return state;
}

function providerNeutralSourceKind(source) {
  return source === 'csv' ? 'csv' : 'manual';
}

function providerNeutralNamespace(source) {
  if (source === 'csv') return 'csv:legacy';
  if (source === 'manual') return 'manual:vault';
  return 'manual:legacy-migration';
}

function adapterKindForLegacySource(source) {
  if (source === 'csv') return 'csv.generic.v1';
  if (source === 'manual') return 'manual.v1';
  return 'migration.schema9';
}

function existingReference(value) {
  const candidate = clean(value);
  return candidate || null;
}

function sourceDateFromTransaction(transaction) {
  for (const value of [transaction.displayDate, transaction.postedAt, transaction.authorizedAt]) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return null;
}

function initializeProviderNeutralIngestion(state, {now}) {
  initializeDomainStore(state, {now});
  const domain = state.domain;
  for (const field of [
    'ingestionReceipts', 'sourceQuarantines', 'sourceTombstones', 'interpretationConflicts', 'sourceAuditEvents'
  ]) domain[field] = Array.isArray(domain[field]) ? domain[field] : [];

  const accountPreferredRefs = new Map();
  for (const account of domain.accounts) {
    const source = account.source || 'migration';
    const namespace = providerNeutralNamespace(source);
    const preferred = existingReference(account.externalAccountId);
    if (preferred) {
      const key = `${providerNeutralSourceKind(source)}|${namespace}|${preferred}`;
      accountPreferredRefs.set(key, (accountPreferredRefs.get(key) || 0) + 1);
    }
  }
  for (const account of domain.accounts) {
    const source = account.source || 'migration';
    const sourceKind = providerNeutralSourceKind(source);
    const sourceNamespace = account.id === UNKNOWN_ACCOUNT_ID ? 'manual:vault' : providerNeutralNamespace(source);
    const preferred = existingReference(account.externalAccountId);
    const countKey = `${sourceKind}|${sourceNamespace}|${preferred}`;
    const sourceAccountRef = account.id === UNKNOWN_ACCOUNT_ID
      ? 'unknown-account'
      : (preferred && accountPreferredRefs.get(countKey) === 1 ? preferred : `account:${account.id}`);
    Object.assign(account, {
      sourceKind,
      sourceNamespace,
      sourceAccountRef,
      connectionId:null,
      institutionName:account.institutionName ?? null,
      providerDisplayName:account.providerDisplayName ?? account.officialName ?? null,
      enabled:account.enabled ?? account.active !== false,
      hidden:account.hidden ?? false,
      sourceStatus:account.sourceStatus ?? (account.active === false ? 'closed' : 'active'),
      connectionStatus:account.connectionStatus ?? 'not_applicable',
      sourceMetadata:isPlainObject(account.sourceMetadata) ? account.sourceMetadata : {},
      balances:account.balances ?? (account.balanceCents === null || account.balanceCents === undefined ? null : {
        currentCents:account.balanceCents,
        availableCents:null,
        limitCents:null,
        observedAt:account.updatedAt || now
      }),
      sourceObservedAt:account.sourceObservedAt ?? account.updatedAt ?? now
    });
  }

  const accountById = new Map(domain.accounts.map(account => [account.id, account]));
  const transactionPreferredRefs = new Map();
  for (const transaction of domain.transactions) {
    const sourceKind = providerNeutralSourceKind(transaction.source);
    const namespace = providerNeutralNamespace(transaction.source);
    const preferred = existingReference(transaction.sourceTransactionId);
    if (!preferred) continue;
    const key = `${sourceKind}|${namespace}|${preferred}`;
    transactionPreferredRefs.set(key, (transactionPreferredRefs.get(key) || 0) + 1);
  }
  for (const transaction of domain.transactions) {
    const sourceKind = providerNeutralSourceKind(transaction.source);
    const sourceNamespace = providerNeutralNamespace(transaction.source);
    const preferred = existingReference(transaction.sourceTransactionId);
    const key = `${sourceKind}|${sourceNamespace}|${preferred}`;
    const sourceRecordRef = preferred && transactionPreferredRefs.get(key) === 1 ? preferred : `transaction:${transaction.id}`;
    const account = accountById.get(transaction.accountId);
    const sourceDate = sourceDateFromTransaction(transaction);
    const providerCategoryMetadata = transaction.providerCategory
      ? {primary:String(transaction.providerCategory), detailed:null, confidence:null, taxonomyVersion:null}
      : null;
    Object.assign(transaction, {
      sourceKind,
      sourceNamespace,
      sourceRecordRef,
      sourceAccountRef:account?.sourceAccountRef || 'unknown-account',
      sourceLifecycle:transaction.pendingStatus || 'unknown',
      sourceAmount:{
        decimal:formatSignedCents(transaction.amountCents),
        currency:transaction.currency ?? null,
        signConvention:'money_moves_signed'
      },
      sourceDate,
      authorizedDate:typeof transaction.authorizedAt === 'string' ? transaction.authorizedAt.slice(0, 10) : null,
      sourceAuthorizedAt:transaction.authorizedAt ?? null,
      postedDate:typeof transaction.postedAt === 'string' ? transaction.postedAt.slice(0, 10) : null,
      sourcePostedAt:transaction.postedAt ?? null,
      rawDescription:transaction.rawName ?? null,
      displayDescription:transaction.merchantName ?? transaction.rawName ?? null,
      providerCategoryMetadata,
      sourceProvenance:{
        adapterKind:adapterKindForLegacySource(transaction.source),
        observedAt:transaction.updatedAt || now,
        sourceRevision:null,
        sourceUpdatedAt:null,
        migratedFromSchema:9
      },
      sourceRefAliases:[],
      predecessorTransactionId:null,
      tombstone:transaction.pendingStatus === 'removed' ? {
        reason:'unknown', observedAt:transaction.updatedAt || now, successorTransactionId:null, priorSourceRecordRef:sourceRecordRef
      } : null,
      interpretationConflictId:null,
      sourceHistory:[]
    });
  }
  for (const allocation of domain.allocations) {
    allocation.status = allocation.status ?? 'active';
    allocation.supersededByConflictId = allocation.supersededByConflictId ?? null;
  }
  return state;
}

function initializeBucketExplorerFields(state) {
  const domain = asObject(state.domain);
  domain.buckets = Array.isArray(domain.buckets) ? domain.buckets : [];
  for (const bucket of domain.buckets) {
    if (!Object.prototype.hasOwnProperty.call(bucket, 'description')) bucket.description = null;
    if (!Object.prototype.hasOwnProperty.call(bucket, 'archivedAt')) bucket.archivedAt = bucket.active === false ? bucket.updatedAt : null;
    bucket.active = bucket.archivedAt ? false : bucket.active !== false;
  }
  state.domain = domain;
  return state;
}

function unresolvedAllocationId(transactionId, bucketId, reason) {
  return `unresolved-${deterministicAllocationId(transactionId || 'missing', bucketId || 'unassigned', reason)}`;
}

function recordUnresolvedAllocation(state, legacy, reason, now) {
  state.legacyV1 = asObject(state.legacyV1);
  state.legacyV1.unresolvedAllocationMigrations = Array.isArray(state.legacyV1.unresolvedAllocationMigrations)
    ? state.legacyV1.unresolvedAllocationMigrations
    : [];
  const item = {
    id:unresolvedAllocationId(legacy?.id, legacy?.bucketId, reason),
    transactionId:typeof legacy?.id === 'string' ? legacy.id : null,
    bucketId:typeof legacy?.bucketId === 'string' ? legacy.bucketId : null,
    reason,
    recordedAt:now
  };
  if (!state.legacyV1.unresolvedAllocationMigrations.some(existing => existing.id === item.id)) {
    state.legacyV1.unresolvedAllocationMigrations.push(item);
  }
}

function migrateTraceableLegacyAssignments(state, {now}) {
  initializeDomainStore(state, {now});
  const domain = state.domain;
  for (const allocation of domain.allocations) {
    if (allocation.ownershipType === 'personal') allocation.ownershipType = 'mine';
  }
  const legacyTransactions = Array.isArray(state.review?.transactions) ? state.review.transactions : [];
  const counts = new Map();
  for (const transaction of legacyTransactions) {
    const id = typeof transaction?.id === 'string' ? transaction.id.trim() : '';
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const buckets = new Map(domain.buckets.map(bucket => [bucket.id, bucket]));
  const transactions = new Map(domain.transactions.map(transaction => [transaction.id, transaction]));
  const allocationIds = new Set(domain.allocations.map(allocation => allocation.id));

  for (const legacy of legacyTransactions) {
    const transactionId = typeof legacy?.id === 'string' ? legacy.id.trim() : '';
    if (!transactionId) {
      if (legacy?.bucketId) recordUnresolvedAllocation(state, legacy, 'missing_transaction_id', now);
      continue;
    }
    if (counts.get(transactionId) !== 1) {
      recordUnresolvedAllocation(state, legacy, 'duplicate_transaction_id', now);
      continue;
    }
    let transaction = transactions.get(transactionId);
    const knownAccount = domain.accounts.some(account => account.id === legacy.accountId) ? legacy.accountId : undefined;
    const migratedTransaction = canonicalTransactionFromLegacy(legacy, {now, accountId:knownAccount});
    if (!migratedTransaction) {
      recordUnresolvedAllocation(state, legacy, 'invalid_or_zero_transaction_amount', now);
      continue;
    }
    if (transaction && Math.abs(transaction.amountCents) !== Math.abs(migratedTransaction.amountCents)) {
      recordUnresolvedAllocation(state, legacy, 'canonical_amount_mismatch', now);
      continue;
    }
    if (!transaction) {
      transaction = migratedTransaction;
      domain.transactions.push(transaction);
      transactions.set(transaction.id, transaction);
    }
    if (!legacy.bucketId || domain.allocations.some(allocation => allocation.transactionId === transactionId)) continue;

    const selected = buckets.get(legacy.bucketId);
    if (!selected) {
      recordUnresolvedAllocation(state, legacy, 'missing_or_system_bucket', now);
      continue;
    }
    const parent = selected.parentId ? buckets.get(selected.parentId) : selected;
    if (!parent || parent.parentId) {
      recordUnresolvedAllocation(state, legacy, 'invalid_bucket_hierarchy', now);
      continue;
    }
    const subBucketId = selected.parentId ? selected.id : null;
    const allocationId = deterministicAllocationId(transactionId, parent.id, subBucketId);
    if (allocationIds.has(allocationId)) {
      recordUnresolvedAllocation(state, legacy, 'allocation_id_collision', now);
      continue;
    }
    domain.allocations.push({
      id:allocationId,
      transactionId,
      bucketId:parent.id,
      subBucketId,
      amountCents:Math.abs(transaction.amountCents),
      ownershipType:'mine',
      note:null,
      reimbursementClaimId:null,
      createdAt:now,
      updatedAt:now
    });
    allocationIds.add(allocationId);
  }
  return state;
}

function legacyPayerLabel(claim) {
  for (const field of ['payerLabel', 'payerName', 'payer']) {
    const value = clean(claim?.[field]);
    if (value) return value;
  }
  return '';
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function relevantPointerFacts(domain, claim, claimId) {
  const listed = new Set(Array.isArray(claim?.allocationIds) ? claim.allocationIds.filter(id => typeof id === 'string') : []);
  return domain.allocations
    .filter(allocation => listed.has(allocation.id) || allocation.reimbursementClaimId === claimId)
    .map(allocation => ({allocationId:allocation.id, reimbursementClaimId:allocation.reimbursementClaimId ?? null}))
    .sort((left, right) => left.allocationId.localeCompare(right.allocationId));
}

function unresolvedReimbursementRecord(domain, claim, identity, reasons, now) {
  const claimFingerprint = stableHash(identity.semanticKey);
  const claimId = clean(claim?.id) || `fingerprint-${claimFingerprint}`;
  const reasonCodes = uniqueSorted(reasons.length ? reasons : ['malformed_claim']);
  return {
    id:deterministicReimbursementId(
      'unresolved-reimbursement', claimId, claimFingerprint, identity.occurrenceIndex, reasonCodes.join(',')
    ),
    originalClaim:clone(claim),
    allocationPointerFacts:relevantPointerFacts(domain, claim, clean(claim?.id)),
    repaymentFragments:clone(Array.isArray(claim?.repaymentLinks) ? claim.repaymentLinks : []),
    legacyStatus:typeof claim?.status === 'string' ? claim.status : null,
    reasonCodes,
    migratedAt:now,
    sourceSchemaVersion:6
  };
}

function safeLegacyAuditEvents(events, unresolvedRecords = []) {
  const unresolvedEntityIds = new Set();
  for (const record of unresolvedRecords) {
    const claimId = clean(record.originalClaim?.id);
    if (claimId) unresolvedEntityIds.add(claimId);
    for (const pointer of record.allocationPointerFacts || []) unresolvedEntityIds.add(pointer.allocationId);
    for (const repayment of record.repaymentFragments || []) {
      const transactionId = clean(repayment?.transactionId);
      if (transactionId) unresolvedEntityIds.add(transactionId);
    }
  }
  return events.filter(event => {
    if (!validateAuditEvent(event).ok) return false;
    if (event.source !== 'migration') return true;
    return ![event.entityId, ...(event.relatedEntityIds || [])].some(id => unresolvedEntityIds.has(id));
  }).map(clone);
}

function migrateReimbursementRelationships(state, {now}) {
  const sourceAuditEvidence = clone(state.domain?.auditEvents);
  initializeDomainStore(state, {now});
  const domain = state.domain;
  const legacyClaims = clone(domain.reimbursementClaims);
  const legacyAuditEvents = Array.isArray(sourceAuditEvidence) ? sourceAuditEvidence : [];
  const legacyTransactionCurrencyFacts = domain.transactions.map(transaction => ({
    transactionId:transaction.id,
    currencyFieldPresent:Object.prototype.hasOwnProperty.call(transaction, 'currency'),
    currency:clone(transaction.currency)
  })).sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  const legacyPointers = domain.allocations
    .filter(allocation => allocation.reimbursementClaimId !== undefined && allocation.reimbursementClaimId !== null)
    .map(allocation => ({allocationId:allocation.id, reimbursementClaimId:allocation.reimbursementClaimId}))
    .sort((left, right) => left.allocationId.localeCompare(right.allocationId));

  state.legacyFoundation = asObject(state.legacyFoundation);
  if (isPlainObject(state.legacyFoundation.reimbursementSchema6)) {
    state.legacyFoundation.preexistingReimbursementSchema6 = clone(state.legacyFoundation.reimbursementSchema6);
  }
  state.legacyFoundation.reimbursementSchema6 = {
    sourceSchemaVersion:6,
    migratedAt:now,
    claims:legacyClaims,
    allocationPointers:legacyPointers,
    transactionCurrencyFacts:legacyTransactionCurrencyFacts,
    auditEvents:sourceAuditEvidence === undefined ? [] : sourceAuditEvidence
  };
  const unresolved = Array.isArray(state.legacyFoundation.unresolvedReimbursementClaims)
    ? state.legacyFoundation.unresolvedReimbursementClaims.map(clone)
    : [];

  domain.reimbursementClaims = [];
  domain.reimbursementClaimAllocations = [];
  domain.reimbursementPaymentLinks = [];
  domain.reimbursementAdjustments = [];
  domain.auditEvents = [];

  for (const transaction of domain.transactions) {
    if (!isCurrency(transaction.currency)) transaction.currency = null;
  }

  const allocations = new Map(domain.allocations.map(allocation => [allocation.id, allocation]));
  const transactions = new Map(domain.transactions.map(transaction => [transaction.id, transaction]));
  const claimIdCounts = new Map();
  for (const claim of legacyClaims) {
    const id = clean(claim?.id);
    if (id) claimIdCounts.set(id, (claimIdCounts.get(id) || 0) + 1);
  }
  const orderedClaims = legacyClaims.map((claim, index) => ({claim, index, semanticKey:semanticClaimKey(claim)}))
    .sort((left, right) => clean(left.claim?.id).localeCompare(clean(right.claim?.id))
      || left.semanticKey.localeCompare(right.semanticKey)
      || left.index - right.index);
  const claimOccurrences = new Map();
  for (const item of orderedClaims) {
    const key = `${clean(item.claim?.id)}|${item.semanticKey}`;
    item.occurrenceIndex = claimOccurrences.get(key) || 0;
    claimOccurrences.set(key, item.occurrenceIndex + 1);
  }
  const usedAllocationIds = new Set();
  const usedInflowAmounts = new Map();
  // Canonical claim IDs share the reimbursement relationship namespace. Reserve every
  // source claim ID so a generated link collision fails the affected claim safely.
  const usedRelationshipIds = new Set(claimIdCounts.keys());
  let convertedClaimCount = 0;

  for (const {claim, index, semanticKey, occurrenceIndex} of orderedClaims) {
    const identity = {semanticKey, occurrenceIndex};
    const reasons = [];
    if (!isPlainObject(claim)) {
      reasons.push('malformed_claim');
      const record = unresolvedReimbursementRecord(domain, claim, identity, reasons, now);
      if (!unresolved.some(item => item.id === record.id)) unresolved.push(record);
      continue;
    }

    const claimId = clean(claim.id);
    const payerLabel = legacyPayerLabel(claim);
    if (!claimId || claimIdCounts.get(claimId) !== 1) reasons.push(claimId ? 'duplicate_claim_id' : 'malformed_claim');
    if (!payerLabel) reasons.push('missing_payer_label');
    if (!Number.isSafeInteger(claim.expectedAmountCents) || claim.expectedAmountCents <= 0) reasons.push('malformed_claim');
    if (!isTimestamp(claim.createdAt) || !isTimestamp(claim.updatedAt)) reasons.push('invalid_timestamp');
    if (claim.dueDate !== null && claim.dueDate !== undefined && !isCalendarDate(claim.dueDate)) reasons.push('invalid_timestamp');
    if (claim.note !== null && claim.note !== undefined && typeof claim.note !== 'string') reasons.push('malformed_claim');
    if (!Array.isArray(claim.allocationIds) || claim.allocationIds.length === 0) reasons.push('malformed_claim');
    if (!Array.isArray(claim.repaymentLinks)) reasons.push('malformed_claim');

    const allocationIds = Array.isArray(claim.allocationIds) ? claim.allocationIds : [];
    if (new Set(allocationIds).size !== allocationIds.length || allocationIds.some(id => !clean(id))) reasons.push('malformed_claim');
    const pointerFacts = relevantPointerFacts(domain, claim, claimId);
    if (pointerFacts.some(pointer => allocationIds.includes(pointer.allocationId) && pointer.reimbursementClaimId !== claimId)) reasons.push('allocation_pointer_mismatch');
    if (pointerFacts.some(pointer => pointer.reimbursementClaimId === claimId && !allocationIds.includes(pointer.allocationId))) reasons.push('allocation_pointer_mismatch');

    const sourceAllocations = [];
    const currencies = new Set();
    for (const allocationId of allocationIds) {
      const allocation = allocations.get(allocationId);
      if (!allocation) {
        reasons.push('missing_allocation');
        continue;
      }
      sourceAllocations.push(allocation);
      if (allocation.ownershipType !== 'reimbursable') reasons.push('allocation_not_reimbursable');
      if (usedAllocationIds.has(allocation.id)) reasons.push('duplicate_allocation_claim');
      const transaction = transactions.get(allocation.transactionId);
      if (!transaction) {
        reasons.push('missing_allocation_transaction');
        continue;
      }
      if (transaction.amountCents >= 0 || transaction.movementType !== 'expense') reasons.push('allocation_not_expense');
      if (!isCurrency(transaction.currency)) reasons.push('unknown_currency');
      else currencies.add(transaction.currency);
    }
    if (currencies.size > 1) reasons.push('mixed_currency');
    const claimCurrency = clean(claim.currency);
    if (claimCurrency && !isCurrency(claimCurrency)) reasons.push('unknown_currency');
    if (claimCurrency && currencies.size === 1 && !currencies.has(claimCurrency)) reasons.push('mixed_currency');
    if (currencies.size === 0) reasons.push('unknown_currency');

    if (sourceAllocations.length === 1 && Number.isSafeInteger(claim.expectedAmountCents)
      && claim.expectedAmountCents > sourceAllocations[0].amountCents) reasons.push('expected_exceeds_allocation');
    if (sourceAllocations.length > 1 && Number.isSafeInteger(claim.expectedAmountCents)) {
      const total = sourceAllocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
      if (total !== claim.expectedAmountCents) reasons.push('ambiguous_multi_allocation_distribution');
    }

    const repaymentFragments = Array.isArray(claim.repaymentLinks) ? claim.repaymentLinks : [];
    const paymentLinks = [];
    const paymentFingerprints = new Set();
    const localInflowAmounts = new Map();
    let receivedAmountCents = 0;
    const orderedRepayments = repaymentFragments.map((repayment, sourceIndex) => ({
      repayment, sourceIndex, semanticKey:stableSerialize(repayment)
    })).sort((left, right) => left.semanticKey.localeCompare(right.semanticKey) || left.sourceIndex - right.sourceIndex);
    const repaymentOccurrences = new Map();
    for (const item of orderedRepayments) {
      item.occurrenceIndex = repaymentOccurrences.get(item.semanticKey) || 0;
      repaymentOccurrences.set(item.semanticKey, item.occurrenceIndex + 1);
    }
    for (const {repayment, occurrenceIndex:repaymentOccurrenceIndex} of orderedRepayments) {
      if (!isPlainObject(repayment)) {
        reasons.push('malformed_claim');
        continue;
      }
      const transactionId = clean(repayment.transactionId);
      if (!transactionId) reasons.push('missing_repayment_transaction');
      if (!Number.isSafeInteger(repayment.amountCents) || repayment.amountCents <= 0) reasons.push('invalid_repayment_amount');
      const transaction = transactions.get(transactionId);
      if (!transaction) reasons.push('missing_repayment_transaction');
      else {
        if (transaction.amountCents <= 0) reasons.push('invalid_repayment_direction');
        if (transaction.movementType !== 'reimbursement') reasons.push('repayment_not_reimbursement');
        if (!isCurrency(transaction.currency)) reasons.push('unknown_currency');
        else if (currencies.size === 1 && !currencies.has(transaction.currency)) reasons.push('mixed_currency');
      }
      const fingerprint = `${transactionId}|${repayment.amountCents}`;
      if (paymentFingerprints.has(fingerprint)) reasons.push('duplicate_repayment');
      paymentFingerprints.add(fingerprint);
      if (Number.isSafeInteger(repayment.amountCents) && repayment.amountCents > 0) {
        receivedAmountCents += repayment.amountCents;
        localInflowAmounts.set(transactionId, (localInflowAmounts.get(transactionId) || 0) + repayment.amountCents);
      }
      const linkId = deterministicReimbursementId(
        'reimbursement-payment', claimId, transactionId, repayment.amountCents, repaymentOccurrenceIndex
      );
      if (usedRelationshipIds.has(linkId)) reasons.push('duplicate_repayment');
      paymentLinks.push({
        id:linkId,
        claimId,
        inflowTransactionId:transactionId,
        appliedAmountCents:repayment.amountCents,
        source:'migrated_foundation',
        note:null,
        voidedAt:null,
        voidReason:null,
        createdAt:now,
        updatedAt:now
      });
    }
    if (Number.isSafeInteger(claim.expectedAmountCents) && receivedAmountCents > claim.expectedAmountCents) reasons.push('repayment_exceeds_claim');
    for (const [transactionId, amount] of localInflowAmounts) {
      const transaction = transactions.get(transactionId);
      const alreadyUsed = usedInflowAmounts.get(transactionId) || 0;
      if (transaction && Number.isSafeInteger(transaction.amountCents) && transaction.amountCents > 0
        && alreadyUsed + amount > transaction.amountCents) reasons.push('repayment_exceeds_inflow');
    }

    if (reasons.length) {
      const record = unresolvedReimbursementRecord(domain, claim, identity, reasons, now);
      if (!unresolved.some(item => item.id === record.id)) unresolved.push(record);
      continue;
    }

    const canonicalCurrency = claimCurrency || [...currencies][0];
    const validCancellation = claim.status === 'cancelled'
      && isTimestamp(claim.cancelledAt)
      && clean(claim.cancellationReason)
      && paymentLinks.length === 0;
    const canonicalClaim = {
      id:claimId,
      payerLabel,
      currency:canonicalCurrency,
      dueDate:claim.dueDate ?? null,
      note:claim.note ?? null,
      cancelledAt:validCancellation ? claim.cancelledAt : null,
      cancellationReason:validCancellation ? clean(claim.cancellationReason) : null,
      createdAt:claim.createdAt,
      updatedAt:claim.updatedAt
    };
    const claimAllocations = validCancellation ? [] : sourceAllocations.map(allocation => ({
      id:deterministicReimbursementId('reimbursement-claim-allocation', claimId, allocation.id),
      claimId,
      allocationId:allocation.id,
      amountCents:sourceAllocations.length === 1 ? claim.expectedAmountCents : allocation.amountCents,
      createdAt:now,
      updatedAt:now
    }));
    const generatedIds = [...claimAllocations.map(link => link.id), ...paymentLinks.map(link => link.id)];
    if (generatedIds.some(id => usedRelationshipIds.has(id)) || new Set(generatedIds).size !== generatedIds.length) {
      const record = unresolvedReimbursementRecord(domain, claim, identity, ['relationship_id_collision'], now);
      if (!unresolved.some(item => item.id === record.id)) unresolved.push(record);
      continue;
    }

    domain.reimbursementClaims.push(canonicalClaim);
    domain.reimbursementClaimAllocations.push(...claimAllocations);
    domain.reimbursementPaymentLinks.push(...paymentLinks);
    for (const id of generatedIds) usedRelationshipIds.add(id);
    if (!validCancellation) for (const allocation of sourceAllocations) usedAllocationIds.add(allocation.id);
    for (const [transactionId, amount] of localInflowAmounts) usedInflowAmounts.set(transactionId, (usedInflowAmounts.get(transactionId) || 0) + amount);
    convertedClaimCount += 1;
  }

  for (const allocation of domain.allocations) allocation.reimbursementClaimId = null;
  domain.reimbursementClaims.sort((left, right) => left.id.localeCompare(right.id));
  domain.reimbursementClaimAllocations.sort((left, right) => left.id.localeCompare(right.id));
  domain.reimbursementPaymentLinks.sort((left, right) => left.id.localeCompare(right.id));
  state.legacyFoundation.unresolvedReimbursementClaims = unresolved.sort((left, right) => left.id.localeCompare(right.id));
  domain.auditEvents = safeLegacyAuditEvents(legacyAuditEvents, state.legacyFoundation.unresolvedReimbursementClaims);
  const metadata = migrationMetadata(state);
  metadata.reimbursementSchema7 = {
    convertedClaimCount,
    unresolvedClaimCount:state.legacyFoundation.unresolvedReimbursementClaims.length
  };
  return state;
}

function initializeFoundationV4(state, context) {
  initializeDomainStore(state, context);
  state.app = {...asObject(state.app), name:PRODUCT_NAME};
  state.migration = asObject(state.migration);
  state.migration.foundation = 'v2';
  return state;
}

export function migrateState(input, {now} = {}) {
  const state = clone(input || {});
  if (state.stateRevision !== undefined && (!Number.isSafeInteger(state.stateRevision) || state.stateRevision < 0)) {
    throw new Error('Pre-migration stateRevision must be a non-negative safe integer.');
  }
  const migrationNow = resolveMigrationTimestamp(state, now);
  const fromVersion = sourceVersion(state);
  const freshVaultAtStart = hasFreshVaultEvidence(state);
  if (fromVersion > STATE_SCHEMA_VERSION) {
    throw new Error(`Vault schema ${fromVersion} is newer than supported schema ${STATE_SCHEMA_VERSION}.`);
  }
  assertValidMigrationState(state, 'Pre-migration');
  const applied = [];
  let version = fromVersion;
  while (version < STATE_SCHEMA_VERSION) {
    const migration = FOUNDATION_MIGRATIONS.find(item => item.from === version);
    if (!migration) throw new Error(`No migration is available from schema ${version}.`);
    migration.migrate(state, {now:migrationNow, freshVaultAtStart});
    const metadata = migrationMetadata(state);
    if (!metadata.appliedMigrations.includes(migration.id)) metadata.appliedMigrations.push(migration.id);
    version = migration.to;
    state.schemaVersion = version;
    applied.push(migration.id);
  }
  initializeFoundationV4(state, {now:migrationNow});
  state.schemaVersion = STATE_SCHEMA_VERSION;
  state.app = {...asObject(state.app), name:PRODUCT_NAME};
  initializeStateRevision(state);
  assertValidMigrationState(state, 'Post-migration');
  return {state, fromVersion, toVersion:STATE_SCHEMA_VERSION, applied, changed:applied.length > 0};
}

export function validateFoundationDomain(domain) {
  return validateDomainStore(domain, {legacyDevotionalState:false});
}
