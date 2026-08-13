import {STATE_SCHEMA_VERSION, UNKNOWN_ACCOUNT_ID} from '../domain/constants.js';
import {
  canonicalExternalSourceReference,
  computeLegacyEnvelopeDigest,
  stableCanonicalJson,
  validateSourceMutationBatch
} from '../domain/ingestionContract.js';
import {
  INGESTION_RESULT_COUNT_FIELDS, isAllocationActive, validateDomainStore, validateIngestionReceipt
} from '../domain/models.js';
import {advanceStateRevision} from './stateRevision.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

export class IngestionApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IngestionApplyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IngestionApplyError(code, message);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nextId(idFactory, prefix) {
  const value = clean(idFactory(prefix));
  if (!value) fail('INVALID_LOCAL_ID', 'The local identifier factory returned an invalid identifier.');
  return value;
}

function defaultIdFactory(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sourceKey(sourceKind, sourceNamespace, sourceRef) {
  return `${sourceKind}\u001f${sourceNamespace}\u001f${sourceRef}`;
}

function transactionSourceKey(sourceKind, sourceNamespace, sourceAccountRef, sourceRecordRef) {
  return `${sourceKind}\u001f${sourceNamespace}\u001f${sourceAccountRef}\u001f${sourceRecordRef}`;
}

function ensureCollections(domain) {
  for (const field of [
    'ingestionReceipts', 'sourceQuarantines', 'sourceTombstones', 'interpretationConflicts', 'sourceAuditEvents'
  ]) domain[field] = Array.isArray(domain[field]) ? domain[field] : [];
}

function accountIndex(domain) {
  return new Map(domain.accounts.filter(account => account.sourceKind).map(account => [
    sourceKey(account.sourceKind, account.sourceNamespace, account.sourceAccountRef), account
  ]));
}

function transactionIndex(domain) {
  const result = new Map();
  for (const transaction of domain.transactions) {
    if (!transaction.sourceKind) continue;
    result.set(transactionSourceKey(
      transaction.sourceKind,
      transaction.sourceNamespace,
      transaction.sourceAccountRef,
      transaction.sourceRecordRef
    ), {transaction, alias:null});
    for (const alias of transaction.sourceRefAliases || []) {
      result.set(transactionSourceKey(
        transaction.sourceKind,
        transaction.sourceNamespace,
        transaction.sourceAccountRef,
        alias.sourceRecordRef
      ), {transaction, alias});
    }
  }
  return result;
}

function sourceAccountFields(record) {
  return {
    officialName:record.officialName,
    providerDisplayName:record.providerDisplayName,
    institutionName:record.institution.name,
    institutionId:record.institution.sourceInstitutionRef,
    type:record.type,
    subtype:record.subtype,
    mask:record.mask,
    currency:record.currency,
    sourceStatus:record.sourceStatus,
    balances:clone(record.balances),
    balanceCents:record.balances?.currentCents ?? null,
    sourceMetadata:clone(record.metadata)
  };
}

function accountFactsEqual(account, record) {
  const current = sourceAccountFields({
    officialName:account.officialName ?? null,
    providerDisplayName:account.providerDisplayName ?? null,
    institution:{sourceInstitutionRef:account.institutionId ?? null, name:account.institutionName ?? null},
    type:account.type,
    subtype:account.subtype ?? null,
    mask:account.mask ?? null,
    currency:account.currency ?? null,
    sourceStatus:account.sourceStatus ?? 'unknown',
    balances:account.balances ?? null,
    metadata:account.sourceMetadata ?? {}
  });
  return stableCanonicalJson(current) === stableCanonicalJson(sourceAccountFields(record));
}

function sourceAudit(domain, {idFactory, batch, entityType, entityId, action, changedFields, observedAt, now}) {
  domain.sourceAuditEvents.push({
    id:nextId(idFactory, 'source-audit'),
    batchId:batch.batchId,
    entityType,
    entityId,
    action,
    changedFields:[...new Set(changedFields)].sort(),
    observedAt,
    createdAt:now,
    updatedAt:now
  });
}

function localAccountFromMutation(batch, mutation, {idFactory, now}) {
  const source = mutation.account;
  const friendlyName = clean(source.officialName || source.providerDisplayName) || 'Unnamed account';
  return {
    id:nextId(idFactory, 'account'),
    institutionId:source.institution.sourceInstitutionRef,
    externalAccountId:mutation.sourceAccountRef,
    friendlyName,
    officialName:source.officialName,
    mask:source.mask,
    type:source.type,
    subtype:source.subtype,
    currency:source.currency,
    source:batch.sourceKind,
    active:true,
    balanceCents:source.balances?.currentCents ?? null,
    sourceKind:batch.sourceKind,
    sourceNamespace:batch.sourceNamespace,
    sourceAccountRef:mutation.sourceAccountRef,
    sourceAccountIdentityDomain:mutation.sourceAccountIdentityDomain,
    connectionId:batch.sourceKind === 'provider' ? batch.sourceNamespace : null,
    institutionName:source.institution.name,
    providerDisplayName:source.providerDisplayName,
    enabled:true,
    hidden:false,
    sourceStatus:source.sourceStatus,
    connectionStatus:source.sourceStatus === 'active' ? 'healthy' : source.sourceStatus,
    sourceMetadata:clone(source.metadata),
    balances:clone(source.balances),
    sourceObservedAt:mutation.observedAt,
    createdAt:now,
    updatedAt:now
  };
}

function applyAccountAddsAndModifications(domain, batch, context, index, counts) {
  for (const mutation of batch.accountMutations.filter(item => item.kind !== 'disconnect')) {
    if (mutation.sourceAccountRef === 'unknown-account') continue;
    const key = sourceKey(batch.sourceKind, batch.sourceNamespace, mutation.sourceAccountRef);
    const existing = index.get(key);
    if (!existing) {
      if (mutation.kind !== 'add') fail('UNKNOWN_ACCOUNT_MODIFICATION', 'An account modification referenced an unknown source account.');
      const account = localAccountFromMutation(batch, mutation, context);
      domain.accounts.push(account);
      index.set(key, account);
      counts.accountsAdded += 1;
      sourceAudit(domain, {...context, batch, entityType:'account', entityId:account.id, action:'added', changedFields:['source'], observedAt:mutation.observedAt});
      continue;
    }
    if (existing.sourceAccountIdentityDomain !== mutation.sourceAccountIdentityDomain) {
      fail('SOURCE_ACCOUNT_IDENTITY_DOMAIN_CONFLICT', 'A source account reference conflicts with its persisted identity domain.');
    }
    if (mutation.kind === 'add' && batch.sourceKind !== 'csv') {
      if (!accountFactsEqual(existing, mutation.account)) fail('ACCOUNT_ADD_CONFLICT', 'An account add conflicts with existing source facts.');
      continue;
    }
    if (accountFactsEqual(existing, mutation.account)) continue;
    const before = sourceAccountFields({
      officialName:existing.officialName ?? null,
      providerDisplayName:existing.providerDisplayName ?? null,
      institution:{sourceInstitutionRef:existing.institutionId ?? null, name:existing.institutionName ?? null},
      type:existing.type,
      subtype:existing.subtype ?? null,
      mask:existing.mask ?? null,
      currency:existing.currency ?? null,
      sourceStatus:existing.sourceStatus ?? 'unknown',
      balances:existing.balances ?? null,
      metadata:existing.sourceMetadata ?? {}
    });
    const after = sourceAccountFields(mutation.account);
    const changedFields = Object.keys(after).filter(field => stableCanonicalJson(before[field]) !== stableCanonicalJson(after[field]));
    Object.assign(existing, after, {sourceObservedAt:mutation.observedAt, updatedAt:context.now});
    counts.accountsUpdated += 1;
    sourceAudit(domain, {...context, batch, entityType:'account', entityId:existing.id, action:'modified', changedFields, observedAt:mutation.observedAt});
  }
}

function assertNoUnresolvedLegacyCsvAccountIdentity(domain, batch) {
  if (batch.sourceKind !== 'csv') return;
  const persistedCollections = [
    domain?.accounts,
    domain?.transactions,
    domain?.sourceQuarantines,
    domain?.sourceTombstones
  ];
  const missingPersistedDomain = persistedCollections.some(collection => Array.isArray(collection)
    && collection.some(item => item.sourceKind === 'csv'
      && item.sourceNamespace === batch.sourceNamespace
      && !item.sourceAccountIdentityDomain));
  if (missingPersistedDomain) {
    fail(
      'CSV_LEGACY_ACCOUNT_IDENTITY_DOMAIN_UNRESOLVED',
      'This CSV import profile has account identity without domain provenance from an unreleased ingestion candidate. Use controlled account remediation before retrying.'
    );
  }
  const legacyReference = value => typeof value === 'string' && value.startsWith('label:');
  const unresolvedPersisted = persistedCollections.some(collection => Array.isArray(collection)
    && collection.some(item => item.sourceKind === 'csv'
      && item.sourceNamespace === batch.sourceNamespace
      && legacyReference(item.sourceAccountRef)));
  const unresolvedIncoming = [
    ...batch.accountMutations,
    ...batch.transactionMutations,
    ...batch.quarantinedRecords
  ].some(item => legacyReference(item.sourceAccountRef));
  if (unresolvedPersisted || unresolvedIncoming) {
    fail(
      'CSV_LEGACY_ACCOUNT_IDENTITY_UNRESOLVED',
      'This CSV import profile has unresolved account identity from an unreleased ingestion candidate. Use controlled account remediation before retrying.'
    );
  }
  const preCanonicalMigrationMatch = (domain?.transactions || []).some(transaction => {
    if (transaction.sourceKind !== 'csv' || transaction.sourceNamespace !== batch.sourceNamespace
      || transaction.sourceProvenance?.migratedFromSchema !== 9) return false;
    let canonicalAccountRef;
    let canonicalRecordRef;
    try {
      canonicalAccountRef = canonicalExternalSourceReference(transaction.sourceAccountRef);
      canonicalRecordRef = canonicalExternalSourceReference(transaction.sourceRecordRef);
    } catch {
      return false;
    }
    return batch.transactionMutations.some(mutation => mutation.sourceAccountRef === canonicalAccountRef
      && mutation.sourceRecordRef === canonicalRecordRef);
  });
  const accountOnlyPreCanonicalMatch = (domain?.accounts || []).some(account => {
    if (account.sourceKind !== 'csv' || account.sourceNamespace !== batch.sourceNamespace) return false;
    const hasTransactionEvidence = (domain?.transactions || []).some(transaction => transaction.accountId === account.id);
    if (hasTransactionEvidence) return false;
    let canonicalAccountRef;
    try {
      canonicalAccountRef = canonicalExternalSourceReference(account.sourceAccountRef);
    } catch {
      return false;
    }
    return batch.accountMutations.some(mutation => mutation.sourceAccountRef === canonicalAccountRef);
  });
  if (preCanonicalMigrationMatch || accountOnlyPreCanonicalMatch) {
    fail(
      'CSV_LEGACY_EXTERNAL_REFERENCE_UNRESOLVED',
      'This CSV import matches pre-canonical external references from an unreleased ingestion candidate. Use controlled source-reference remediation before retrying.'
    );
  }
}

function resolveLocalAccount(domain, batch, sourceAccountRef, sourceAccountIdentityDomain, index) {
  if (sourceAccountRef === 'unknown-account') return domain.accounts.find(account => account.id === UNKNOWN_ACCOUNT_ID) || null;
  const account = index.get(sourceKey(batch.sourceKind, batch.sourceNamespace, sourceAccountRef)) || null;
  if (account && account.sourceAccountIdentityDomain !== sourceAccountIdentityDomain) {
    fail('SOURCE_ACCOUNT_IDENTITY_DOMAIN_CONFLICT', 'A transaction source account conflicts with the persisted account identity domain.');
  }
  return account;
}

function recordSourceFacts(record) {
  return {
    sourceLifecycle:record.lifecycle,
    amountCents:record.amountCents,
    currency:record.currency,
    sourceAmount:clone(record.sourceAmount),
    sourceDate:record.sourceDate,
    authorizedDate:record.authorizedDate,
    sourceAuthorizedAt:record.authorizedAt,
    postedDate:record.postedDate,
    sourcePostedAt:record.postedAt,
    rawDescription:record.rawDescription,
    displayDescription:record.displayDescription,
    sourceMerchant:clone(record.merchant),
    providerCategoryMetadata:clone(record.providerCategory),
    paymentChannel:record.paymentChannel,
    sourceLocation:clone(record.location),
    sourceRevision:record.sourceRevision,
    sourceUpdatedAt:record.sourceUpdatedAt,
    sourceMetadata:clone(record.metadata)
  };
}

function transactionCurrentFacts(transaction) {
  return {
    sourceLifecycle:transaction.sourceLifecycle,
    amountCents:transaction.amountCents,
    currency:transaction.currency,
    sourceAmount:clone(transaction.sourceAmount),
    sourceDate:transaction.sourceDate,
    authorizedDate:transaction.authorizedDate,
    sourceAuthorizedAt:transaction.sourceAuthorizedAt ?? null,
    postedDate:transaction.postedDate,
    sourcePostedAt:transaction.sourcePostedAt ?? null,
    rawDescription:transaction.rawDescription,
    displayDescription:transaction.displayDescription,
    sourceMerchant:clone(transaction.sourceMerchant ?? null),
    providerCategoryMetadata:clone(transaction.providerCategoryMetadata ?? null),
    paymentChannel:transaction.paymentChannel ?? null,
    sourceLocation:clone(transaction.sourceLocation ?? {region:transaction.locationRegion ?? null, country:transaction.locationCountry ?? null, source:transaction.locationSource ?? 'unavailable'}),
    sourceRevision:transaction.sourceProvenance?.sourceRevision ?? null,
    sourceUpdatedAt:transaction.sourceProvenance?.sourceUpdatedAt ?? null,
    sourceMetadata:clone(transaction.sourceMetadata ?? {})
  };
}

function sourceFactsEqual(transaction, record) {
  return stableCanonicalJson(transactionCurrentFacts(transaction)) === stableCanonicalJson(recordSourceFacts(record));
}

function migratedSourceCompletionIsCompatible(transaction, record) {
  return transaction.sourceProvenance?.migratedFromSchema === 9
    && transaction.sourceLifecycle === record.lifecycle
    && transaction.amountCents === record.amountCents
    && transaction.currency === record.currency
    && transaction.sourceDate === record.sourceDate;
}

function historySnapshot(transaction, batch, observedAt) {
  return {
    observedAt,
    batchId:batch.batchId,
    sourceRecordRef:transaction.sourceRecordRef,
    ...transactionCurrentFacts(transaction)
  };
}

function sourceChangedFields(transaction, record) {
  const before = transactionCurrentFacts(transaction);
  const after = recordSourceFacts(record);
  return Object.keys(after).filter(field => stableCanonicalJson(before[field]) !== stableCanonicalJson(after[field]));
}

function relatedClaimIds(domain, allocations) {
  const allocationIds = new Set(allocations.map(item => item.id));
  return [...new Set(domain.reimbursementClaimAllocations
    .filter(link => allocationIds.has(link.allocationId))
    .map(link => link.claimId))].sort();
}

function createInterpretationConflict(domain, transaction, batch, context, {
  kind,
  nextAmountCents,
  nextCurrency,
  supersedeAllocations
}) {
  if (transaction.interpretationConflictId) return domain.interpretationConflicts.find(item => item.id === transaction.interpretationConflictId) || null;
  const allocations = domain.allocations.filter(item => item.transactionId === transaction.id && isAllocationActive(item));
  const conflict = {
    id:nextId(context.idFactory, 'interpretation-conflict'),
    batchId:batch.batchId,
    transactionId:transaction.id,
    kind,
    status:'unresolved',
    previousReviewStatus:transaction.reviewStatus,
    previousMovementType:transaction.movementType,
    previousAmountCents:transaction.amountCents,
    nextAmountCents:nextAmountCents ?? null,
    previousCurrency:transaction.currency ?? null,
    nextCurrency:nextCurrency ?? null,
    allocationSnapshot:clone(allocations),
    relatedClaimIds:relatedClaimIds(domain, allocations),
    manualOverridesSnapshot:clone(transaction.manualOverrides ?? null),
    userNoteSnapshot:transaction.userNote ?? null,
    createdAt:context.now,
    updatedAt:context.now
  };
  domain.interpretationConflicts.push(conflict);
  if (supersedeAllocations) for (const allocation of allocations) {
    allocation.status = 'superseded';
    allocation.supersededByConflictId = conflict.id;
    allocation.updatedAt = context.now;
  }
  transaction.interpretationConflictId = conflict.id;
  transaction.reviewStatus = 'needs_resolution';
  return conflict;
}

function applyRecordToTransaction(domain, transaction, mutation, batch, context, counts) {
  const record = mutation.record;
  if (sourceFactsEqual(transaction, record)) return false;
  const changedFields = sourceChangedFields(transaction, record);
  const activeAllocations = domain.allocations.filter(item => item.transactionId === transaction.id && isAllocationActive(item));
  const requiresInterpretationReview = sourceAmountChangeRequiresInterpretationReview(domain, transaction, record);
  transaction.sourceHistory.push(historySnapshot(transaction, batch, mutation.observedAt));
  if (requiresInterpretationReview) {
    const existingConflictId = transaction.interpretationConflictId;
    createInterpretationConflict(domain, transaction, batch, context, {
      kind:'source_amount_changed',
      nextAmountCents:record.amountCents,
      nextCurrency:record.currency,
      supersedeAllocations:activeAllocations.length > 0
    });
    if (!existingConflictId && transaction.interpretationConflictId) counts.interpretationConflicts += 1;
  }
  const facts = recordSourceFacts(record);
  Object.assign(transaction, facts, {
    rawName:record.rawDescription,
    merchantName:record.merchant?.name ?? record.displayDescription,
    authorizedAt:record.authorizedAt ?? record.authorizedDate,
    postedAt:record.postedAt ?? record.postedDate,
    displayDate:record.postedDate ?? record.sourceDate ?? record.authorizedDate,
    pendingStatus:record.lifecycle,
    locationRegion:record.location.region,
    locationCountry:record.location.country,
    locationSource:record.location.source,
    providerCategory:record.providerCategory?.primary ?? null,
    sourceProvenance:{
      adapterKind:batch.adapterKind,
      observedAt:mutation.observedAt,
      sourceRevision:record.sourceRevision,
      sourceUpdatedAt:record.sourceUpdatedAt,
      migratedFromSchema:null
    },
    updatedAt:context.now
  });
  counts.transactionsUpdated += 1;
  sourceAudit(domain, {...context, batch, entityType:'transaction', entityId:transaction.id, action:'modified', changedFields, observedAt:mutation.observedAt});
  return true;
}

function localTransactionFromMutation(batch, mutation, account, context) {
  const record = mutation.record;
  const facts = recordSourceFacts(record);
  return {
    id:nextId(context.idFactory, 'transaction'),
    accountId:account.id,
    source:batch.sourceKind,
    sourceTransactionId:mutation.sourceRecordRef,
    rawName:record.rawDescription,
    merchantName:record.merchant?.name ?? record.displayDescription,
    amountCents:record.amountCents,
    currency:record.currency,
    authorizedAt:record.authorizedAt ?? record.authorizedDate,
    postedAt:record.postedAt ?? record.postedDate,
    displayDate:record.postedDate ?? record.sourceDate ?? record.authorizedDate,
    pendingStatus:record.lifecycle,
    movementType:'unclassified',
    reviewStatus:'pending',
    locationRegion:record.location.region,
    locationCountry:record.location.country,
    locationSource:record.location.source,
    providerCategory:record.providerCategory?.primary ?? null,
    manualOverrides:null,
    userNote:null,
    sourceKind:batch.sourceKind,
    sourceNamespace:batch.sourceNamespace,
    sourceRecordRef:mutation.sourceRecordRef,
    sourceAccountRef:mutation.sourceAccountRef,
    sourceAccountIdentityDomain:mutation.sourceAccountIdentityDomain,
    ...facts,
    sourceProvenance:{
      adapterKind:batch.adapterKind,
      observedAt:mutation.observedAt,
      sourceRevision:record.sourceRevision,
      sourceUpdatedAt:record.sourceUpdatedAt,
      migratedFromSchema:null
    },
    sourceRefAliases:[],
    predecessorTransactionId:null,
    predecessorSourceRef:record.predecessorSourceRef,
    tombstone:null,
    interpretationConflictId:null,
    sourceHistory:[],
    createdAt:context.now,
    updatedAt:context.now
  };
}

function syncLegacyReviewProjection(state, transaction, account) {
  state.review ||= {};
  state.review.transactions = Array.isArray(state.review.transactions) ? state.review.transactions : [];
  let projection = state.review.transactions.find(item => item.id === transaction.id);
  if (!projection) {
    projection = {id:transaction.id, bucketId:null, reviewedAt:null};
    state.review.transactions.push(projection);
  }
  const date = transaction.displayDate || transaction.sourceDate || transaction.createdAt.slice(0, 10);
  Object.assign(projection, {
    canonicalTransactionId:transaction.id,
    sourceRecordRef:transaction.sourceRecordRef,
    date,
    weekStart:weekStartUtc(date),
    merchant:transaction.merchantName || transaction.rawName || 'Unknown merchant',
    merchantKey:clean(transaction.merchantName || transaction.rawName).toLocaleLowerCase(),
    name:transaction.rawName || transaction.merchantName || 'Unknown merchant',
    amount:Math.abs(transaction.amountCents) / 100,
    amountCents:Math.abs(transaction.amountCents),
    account:account?.friendlyName || 'Unknown account',
    providerCategory:transaction.providerCategory || '',
    providerDetail:transaction.providerCategoryMetadata?.detailed || '',
    flow:transaction.amountCents > 0 ? 'inflow' : 'outflow',
    reviewStatus:transaction.reviewStatus,
    source:`v3a-${transaction.sourceKind}`,
    importedAt:transaction.createdAt,
    pending:transaction.sourceLifecycle === 'pending',
    removed:transaction.sourceLifecycle === 'removed'
  });
}

function weekStartUtc(value) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

function applyOrdinaryTransactionMutations(state, domain, batch, context, accounts, transactions, counts) {
  const ordinary = batch.transactionMutations.filter(item => item.kind !== 'remove' && !item.record.predecessorSourceRef);
  for (const mutation of ordinary) {
    const account = resolveLocalAccount(
      domain, batch, mutation.sourceAccountRef, mutation.sourceAccountIdentityDomain, accounts
    );
    if (!account) fail('MISSING_LOCAL_ACCOUNT', 'A transaction does not resolve to a local account.');
    const key = transactionSourceKey(batch.sourceKind, batch.sourceNamespace, mutation.sourceAccountRef, mutation.sourceRecordRef);
    const existing = transactions.get(key)?.transaction || null;
    if (mutation.kind === 'add') {
      if (!existing) {
        const transaction = localTransactionFromMutation(batch, mutation, account, context);
        domain.transactions.push(transaction);
        transactions.set(key, {transaction, alias:null});
        counts.transactionsAdded += 1;
        sourceAudit(domain, {...context, batch, entityType:'transaction', entityId:transaction.id, action:'added', changedFields:['source'], observedAt:mutation.observedAt});
        syncLegacyReviewProjection(state, transaction, account);
      } else if (existing.sourceLifecycle === 'removed' && existing.sourceRecordRef === mutation.sourceRecordRef) {
        const removalConflict = domain.interpretationConflicts.find(item => item.id === existing.interpretationConflictId && item.kind === 'source_removed');
        if (removalConflict) {
          existing.reviewStatus = removalConflict.previousReviewStatus;
          removalConflict.status = 'resolved';
          removalConflict.updatedAt = context.now;
          existing.interpretationConflictId = null;
        }
        existing.tombstone = null;
        applyRecordToTransaction(domain, existing, mutation, batch, context, counts);
        existing.sourceLifecycle = mutation.record.lifecycle;
        existing.pendingStatus = mutation.record.lifecycle;
        syncLegacyReviewProjection(state, existing, account);
      } else if (migratedSourceCompletionIsCompatible(existing, mutation.record)) {
        // Schema 9 retained canonical money and user interpretation but could
        // not retain every adapter-specific source snapshot field. The first
        // exact-key observation may complete those source facts as a bounded
        // migration reconciliation without replacing local identity or user work.
        applyRecordToTransaction(domain, existing, mutation, batch, context, counts);
        syncLegacyReviewProjection(state, existing, account);
      } else if (!sourceFactsEqual(existing, mutation.record)) {
        fail('TRANSACTION_ADD_CONFLICT', 'A transaction add conflicts with existing source facts.');
      }
    } else {
      if (!existing) fail('UNKNOWN_TRANSACTION_MODIFICATION', 'A transaction modification referenced an unknown source record.');
      if (existing.accountId !== account.id) fail('SOURCE_ACCOUNT_CHANGE_REQUIRES_REVIEW', 'A source modification cannot silently move a transaction between local accounts.');
      applyRecordToTransaction(domain, existing, mutation, batch, context, counts);
      syncLegacyReviewProjection(state, existing, account);
    }
  }
}

function applyPendingPostedTransitions(state, domain, batch, context, accounts, transactions, counts) {
  for (const mutation of batch.transactionMutations.filter(item => item.kind === 'add' && item.record.predecessorSourceRef)) {
    const account = resolveLocalAccount(
      domain, batch, mutation.sourceAccountRef, mutation.sourceAccountIdentityDomain, accounts
    );
    if (!account) fail('MISSING_LOCAL_ACCOUNT', 'A posted transaction does not resolve to a local account.');
    if (mutation.record.lifecycle !== 'posted') fail('INVALID_PREDECESSOR_TRANSITION', 'Only a posted record may replace a predecessor.');
    const postedKey = transactionSourceKey(batch.sourceKind, batch.sourceNamespace, mutation.sourceAccountRef, mutation.sourceRecordRef);
    const existingPosted = transactions.get(postedKey);
    if (existingPosted) {
      const hasExpectedAlias = !existingPosted.alias && (existingPosted.transaction.sourceRefAliases || [])
        .some(alias => alias.sourceRecordRef === mutation.record.predecessorSourceRef);
      if (!hasExpectedAlias || existingPosted.transaction.accountId !== account.id) {
        fail('POSTED_SOURCE_COLLISION', 'The posted source reference already maps to incompatible source history.');
      }
      if (!sourceFactsEqual(existingPosted.transaction, mutation.record)) {
        fail('TRANSACTION_ADD_CONFLICT', 'A repeated posted add conflicts with current source facts.');
      }
      continue;
    }
    const predecessorKey = transactionSourceKey(
      batch.sourceKind,
      batch.sourceNamespace,
      mutation.sourceAccountRef,
      mutation.record.predecessorSourceRef
    );
    const predecessorEntry = transactions.get(predecessorKey);
    if (!predecessorEntry || predecessorEntry.alias) {
      const crossAccountPredecessor = [...transactions.values()].some(entry => entry.transaction.sourceAccountRef !== mutation.sourceAccountRef
        && (entry.transaction.sourceRecordRef === mutation.record.predecessorSourceRef
          || (entry.transaction.sourceRefAliases || []).some(alias => alias.sourceRecordRef === mutation.record.predecessorSourceRef)));
      if (crossAccountPredecessor) {
        fail('INVALID_PREDECESSOR_TRANSITION', 'The explicit predecessor is on a different source account.');
      }
      fail('MISSING_PREDECESSOR', 'The explicit predecessor does not resolve to one current transaction.');
    }
    const transaction = predecessorEntry.transaction;
    if (transaction.sourceLifecycle !== 'pending' || transaction.accountId !== account.id || transaction.sourceAccountRef !== mutation.sourceAccountRef) {
      fail('INVALID_PREDECESSOR_TRANSITION', 'The explicit predecessor is not a pending record on the same source account.');
    }
    const postedCollision = transactions.get(postedKey);
    if (postedCollision && postedCollision.transaction.id !== transaction.id) fail('POSTED_SOURCE_COLLISION', 'The posted source reference already maps to another transaction.');
    const priorRef = transaction.sourceRecordRef;
    const updated = applyRecordToTransaction(domain, transaction, mutation, batch, context, counts);
    transaction.sourceRefAliases.push({sourceRecordRef:priorRef, lifecycle:'removed', observedAt:mutation.observedAt});
    transaction.sourceRecordRef = mutation.sourceRecordRef;
    transaction.sourceTransactionId = mutation.sourceRecordRef;
    transaction.predecessorSourceRef = priorRef;
    transactions.delete(predecessorKey);
    transactions.set(predecessorKey, {transaction, alias:transaction.sourceRefAliases.at(-1)});
    transactions.set(postedKey, {transaction, alias:null});
    if (!updated) {
      transaction.sourceLifecycle = 'posted';
      transaction.pendingStatus = 'posted';
      transaction.updatedAt = context.now;
    }
    counts.pendingPostedTransitions += 1;
    syncLegacyReviewProjection(state, transaction, account);
  }
}

function hasMeaningfulUserInterpretation(domain, transaction) {
  return transaction.reviewStatus !== 'pending'
    || transaction.movementType !== 'unclassified'
    || domain.allocations.some(item => item.transactionId === transaction.id)
    || Boolean(transaction.userNote)
    || Boolean(transaction.manualOverrides)
    || domain.reimbursementPaymentLinks.some(item => item.inflowTransactionId === transaction.id);
}

function sourceAmountChangeRequiresInterpretationReview(domain, transaction, record) {
  const amountChanged = transaction.amountCents !== record.amountCents || transaction.currency !== record.currency;
  return amountChanged && hasMeaningfulUserInterpretation(domain, transaction);
}

function tombstoneTransaction(state, domain, transaction, batch, context, {reason, observedAt, successorTransactionId = null, conflictKind = 'source_removed'}, counts) {
  if (transaction.sourceLifecycle === 'removed' && transaction.tombstone?.reason === reason) return false;
  transaction.sourceHistory.push(historySnapshot(transaction, batch, observedAt));
  if (hasMeaningfulUserInterpretation(domain, transaction)) {
    const existingConflictId = transaction.interpretationConflictId;
    createInterpretationConflict(domain, transaction, batch, context, {
      kind:conflictKind,
      nextAmountCents:null,
      nextCurrency:null,
      supersedeAllocations:false
    });
    if (!existingConflictId && transaction.interpretationConflictId) counts.interpretationConflicts += 1;
  }
  transaction.sourceLifecycle = 'removed';
  transaction.pendingStatus = 'removed';
  transaction.tombstone = {
    reason,
    observedAt,
    successorTransactionId,
    priorSourceRecordRef:transaction.sourceRecordRef
  };
  transaction.updatedAt = context.now;
  counts.transactionsTombstoned += 1;
  sourceAudit(domain, {...context, batch, entityType:'transaction', entityId:transaction.id, action:'tombstoned', changedFields:['sourceLifecycle', 'tombstone'], observedAt});
  const account = domain.accounts.find(item => item.id === transaction.accountId);
  syncLegacyReviewProjection(state, transaction, account);
  return true;
}

function applyRemovals(state, domain, batch, context, transactions, counts) {
  for (const mutation of batch.transactionMutations.filter(item => item.kind === 'remove')) {
    const key = transactionSourceKey(batch.sourceKind, batch.sourceNamespace, mutation.sourceAccountRef, mutation.sourceRecordRef);
    const entry = transactions.get(key);
    if (entry?.alias) {
      entry.alias.lifecycle = 'removed';
      entry.alias.observedAt = mutation.observedAt;
      continue;
    }
    if (entry) {
      tombstoneTransaction(state, domain, entry.transaction, batch, context, {
        reason:mutation.removal.reason,
        observedAt:mutation.observedAt,
        successorTransactionId:null
      }, counts);
      continue;
    }
    const tombstoneId = `source-tombstone-${batch.payloadDigest.slice(0, 12)}-${domain.sourceTombstones.length + 1}`;
    if (domain.sourceTombstones.some(item => item.sourceKind === batch.sourceKind
      && item.sourceNamespace === batch.sourceNamespace && item.sourceAccountRef === mutation.sourceAccountRef
      && item.sourceRecordRef === mutation.sourceRecordRef)) continue;
    domain.sourceTombstones.push({
      id:tombstoneId,
      batchId:batch.batchId,
      sourceKind:batch.sourceKind,
      sourceNamespace:batch.sourceNamespace,
      sourceRecordRef:mutation.sourceRecordRef,
      sourceAccountRef:mutation.sourceAccountRef,
      sourceAccountIdentityDomain:mutation.sourceAccountIdentityDomain,
      reason:mutation.removal.reason,
      predecessorOfRef:mutation.removal.predecessorOfRef,
      observedAt:mutation.observedAt,
      createdAt:context.now,
      updatedAt:context.now
    });
    sourceAudit(domain, {...context, batch, entityType:'source_tombstone', entityId:tombstoneId, action:'unknown_removal_recorded', changedFields:['sourceLifecycle'], observedAt:mutation.observedAt});
  }
}

function applyAccountDisconnects(domain, batch, context, index, counts) {
  for (const mutation of batch.accountMutations.filter(item => item.kind === 'disconnect')) {
    if (mutation.sourceAccountRef === 'unknown-account') fail('INVALID_UNKNOWN_ACCOUNT_DISCONNECT', 'The explicit Unknown account cannot be disconnected by a source.');
    const account = index.get(sourceKey(batch.sourceKind, batch.sourceNamespace, mutation.sourceAccountRef));
    if (!account) fail('UNKNOWN_ACCOUNT_DISCONNECT', 'An account disconnect referenced an unknown source account.');
    if (account.sourceAccountIdentityDomain !== mutation.sourceAccountIdentityDomain) {
      fail('SOURCE_ACCOUNT_IDENTITY_DOMAIN_CONFLICT', 'An account disconnect conflicts with the persisted identity domain.');
    }
    if (account.sourceStatus === 'disconnected') continue;
    account.sourceStatus = 'disconnected';
    account.connectionStatus = 'disconnected';
    account.sourceObservedAt = mutation.observedAt;
    account.updatedAt = context.now;
    counts.accountsDisconnected += 1;
    sourceAudit(domain, {...context, batch, entityType:'account', entityId:account.id, action:'disconnected', changedFields:['sourceStatus', 'connectionStatus'], observedAt:mutation.observedAt});
  }
}

function applyQuarantines(state, domain, batch, context, transactions, counts) {
  for (const item of batch.quarantinedRecords) {
    const existing = domain.sourceQuarantines.find(value => value.sourceKind === batch.sourceKind
      && value.sourceNamespace === batch.sourceNamespace && value.sourceAccountRef === item.sourceAccountRef
      && value.sourceRecordRef === item.sourceRecordRef && value.active);
    if (!existing) {
      const quarantine = {
        id:`source-quarantine-${batch.payloadDigest.slice(0, 12)}-${domain.sourceQuarantines.length + 1}`,
        batchId:batch.batchId,
        sourceKind:batch.sourceKind,
        sourceNamespace:batch.sourceNamespace,
        sourceRecordRef:item.sourceRecordRef,
        sourceAccountRef:item.sourceAccountRef,
        sourceAccountIdentityDomain:item.sourceAccountIdentityDomain,
        observedAt:item.observedAt,
        reason:item.reason,
        rawAmountDecimal:item.rawAmountDecimal,
        sourceCurrency:item.sourceCurrency,
        safeDetailCode:item.safeDetailCode,
        active:true,
        resolvedAt:null,
        createdAt:context.now,
        updatedAt:context.now
      };
      domain.sourceQuarantines.push(quarantine);
      counts.sourceRecordsQuarantined += 1;
      sourceAudit(domain, {...context, batch, entityType:'quarantine', entityId:quarantine.id, action:'quarantined', changedFields:['reason', 'sourceCurrency'], observedAt:item.observedAt});
    }
    const entry = transactions.get(transactionSourceKey(
      batch.sourceKind,
      batch.sourceNamespace,
      item.sourceAccountRef,
      item.sourceRecordRef
    ));
    if (entry && !entry.alias && entry.transaction.sourceLifecycle !== 'removed') {
      tombstoneTransaction(state, domain, entry.transaction, batch, context, {
        reason:'source_quarantined',
        observedAt:item.observedAt,
        conflictKind:'source_quarantined'
      }, counts);
    }
  }
}

function resultCounts() {
  return {
    accountsAdded:0,
    accountsUpdated:0,
    accountsDisconnected:0,
    transactionsAdded:0,
    transactionsUpdated:0,
    transactionsTombstoned:0,
    pendingPostedTransitions:0,
    interpretationConflicts:0,
    sourceRecordsQuarantined:0
  };
}

function validatedReplayResult(receipt) {
  return {
    batchId:receipt.result.batchId,
    payloadDigest:receipt.result.payloadDigest,
    status:'already_applied',
    counts:clone(receipt.result.counts),
    safeErrorCodes:clone(receipt.result.safeErrorCodes),
    receipt:clone(receipt.result.receipt)
  };
}

function assertPersistedReceiptStructure(receipt, code) {
  if (!validateIngestionReceipt(receipt).ok) {
    fail(code, 'A persisted ingestion receipt failed integrity validation.');
  }
}

function rejectedCandidateCsvBatchShapeIsPossible(batch) {
  if (batch.sourceKind !== 'csv' || batch.adapterKind !== 'csv.generic.v1'
    || !/^csv:[a-f0-9]{64}:[a-f0-9]{24}$/.test(batch.batchId)
    || batch.checkpoint !== null || batch.sourceWarnings.length !== 0
    || batch.observation.environment !== 'local' || batch.observation.requestRef !== null
    || batch.accountMutations.some(mutation => mutation.kind !== 'add')
    || batch.transactionMutations.some(mutation => mutation.kind !== 'add'
      || mutation.removal !== null || mutation.record?.lifecycle !== 'posted'
      || mutation.record?.predecessorSourceRef !== null)
    || batch.quarantinedRecords.some(record => typeof record.sourceAccountRef !== 'string')) return false;
  const transactionRefs = new Set();
  for (const mutation of batch.transactionMutations) {
    if (transactionRefs.has(mutation.sourceRecordRef)) return false;
    transactionRefs.add(mutation.sourceRecordRef);
  }
  const quarantineRefs = new Set();
  for (const record of batch.quarantinedRecords) {
    if (quarantineRefs.has(record.sourceRecordRef) || transactionRefs.has(record.sourceRecordRef)) return false;
    quarantineRefs.add(record.sourceRecordRef);
  }
  return true;
}

function exactSourceFactsFromEvidence(evidence, expected) {
  const actual = {};
  for (const field of Object.keys(expected)) actual[field] = evidence[field];
  return stableCanonicalJson(actual) === stableCanonicalJson(expected);
}

function transactionHasExpectedHistoricalFacts(transaction, mutation) {
  if (transaction.sourceKind !== 'csv' || transaction.sourceProvenance?.adapterKind !== 'csv.generic.v1') return false;
  const expected = recordSourceFacts(mutation.record);
  if (transaction.sourceRecordRef === mutation.sourceRecordRef
    && stableCanonicalJson(transactionCurrentFacts(transaction)) === stableCanonicalJson(expected)) return true;
  return (transaction.sourceHistory || []).some(history => history.sourceRecordRef === mutation.sourceRecordRef
    && exactSourceFactsFromEvidence(history, expected));
}

function quarantineMatchesBatchRecord(evidence, batch, record) {
  return evidence.sourceKind === 'csv'
    && evidence.sourceNamespace === batch.sourceNamespace
    && evidence.sourceRecordRef === record.sourceRecordRef
    && evidence.sourceAccountRef === record.sourceAccountRef
    && evidence.sourceAccountIdentityDomain === record.sourceAccountIdentityDomain
    && evidence.reason === record.reason
    && evidence.rawAmountDecimal === record.rawAmountDecimal
    && evidence.sourceCurrency === record.sourceCurrency
    && evidence.safeDetailCode === record.safeDetailCode;
}

function auditMatches(audit, {entityType, action, entityIds, changedFields, observedAt}) {
  return audit.entityType === entityType
    && audit.action === action
    && entityIds.has(audit.entityId)
    && stableCanonicalJson(audit.changedFields) === stableCanonicalJson(changedFields)
    && audit.observedAt === observedAt
    && audit.createdAt === observedAt
    && audit.updatedAt === observedAt;
}

function legacyCountsArePossible(counts, batch) {
  return INGESTION_RESULT_COUNT_FIELDS.every(field => Number.isSafeInteger(counts[field]) && counts[field] >= 0)
    && counts.accountsAdded <= batch.accountMutations.filter(item => item.sourceAccountRef !== 'unknown-account').length
    && counts.accountsUpdated === 0
    && counts.accountsDisconnected === 0
    && counts.transactionsAdded + counts.transactionsUpdated <= batch.transactionMutations.length
    && counts.transactionsTombstoned <= batch.quarantinedRecords.length
    && counts.pendingPostedTransitions === 0
    && counts.interpretationConflicts <= counts.transactionsTombstoned
    && counts.sourceRecordsQuarantined <= batch.quarantinedRecords.length;
}

function provesRejectedCandidateCsvEffects(state, receipt, batch) {
  const domain = state.domain;
  if (!validateDomainStore(domain).ok || !legacyCountsArePossible(receipt.result.counts, batch)) return false;
  if (batch.accountMutations.every(item => item.sourceAccountRef === 'unknown-account')
    && batch.transactionMutations.length === 0 && batch.quarantinedRecords.length === 0) return false;
  const counts = receipt.result.counts;
  if (stableCanonicalJson(receipt.result.safeErrorCodes)
    !== stableCanonicalJson(batch.sourceWarnings.map(item => item.code))) return false;

  const accounts = accountIndex(domain);
  const expectedAccountIds = new Set();
  for (const mutation of batch.accountMutations) {
    if (mutation.sourceAccountRef === 'unknown-account') continue;
    const account = accounts.get(sourceKey('csv', batch.sourceNamespace, mutation.sourceAccountRef));
    if (!account || account.source !== 'csv'
      || account.sourceAccountIdentityDomain !== mutation.sourceAccountIdentityDomain
      || !accountFactsEqual(account, mutation.account)) return false;
    expectedAccountIds.add(account.id);
  }

  const transactions = transactionIndex(domain);
  const expectedTransactionIds = new Set();
  for (const mutation of batch.transactionMutations) {
    const entry = transactions.get(transactionSourceKey(
      'csv', batch.sourceNamespace, mutation.sourceAccountRef, mutation.sourceRecordRef
    ));
    if (!entry || entry.transaction.sourceAccountIdentityDomain !== mutation.sourceAccountIdentityDomain
      || !transactionHasExpectedHistoricalFacts(entry.transaction, mutation)) return false;
    expectedTransactionIds.add(entry.transaction.id);
  }
  if (expectedTransactionIds.size !== batch.transactionMutations.length) return false;

  for (const record of batch.quarantinedRecords) {
    const matches = domain.sourceQuarantines.filter(item => quarantineMatchesBatchRecord(item, batch, record));
    if (!matches.length) return false;
  }
  const createdQuarantines = domain.sourceQuarantines.filter(item => item.batchId === batch.batchId);
  const quarantineEvidenceKey = item => `${item.sourceAccountRef}\u001f${item.sourceRecordRef}`;
  if (createdQuarantines.length !== counts.sourceRecordsQuarantined
    || new Set(createdQuarantines.map(quarantineEvidenceKey)).size !== createdQuarantines.length
    || createdQuarantines.some(item => !batch.quarantinedRecords.some(record => quarantineMatchesBatchRecord(item, batch, record)))) return false;

  const quarantineTransactionIds = new Set();
  for (const record of batch.quarantinedRecords) {
    const entry = transactions.get(transactionSourceKey(
      'csv', batch.sourceNamespace, record.sourceAccountRef, record.sourceRecordRef
    ));
    if (entry) quarantineTransactionIds.add(entry.transaction.id);
  }

  const conflicts = domain.interpretationConflicts.filter(item => item.batchId === batch.batchId);
  if (conflicts.length !== counts.interpretationConflicts
    || conflicts.some(item => item.kind !== 'source_quarantined' || !quarantineTransactionIds.has(item.transactionId))) return false;

  const audits = domain.sourceAuditEvents.filter(item => item.batchId === batch.batchId);
  const accountAdds = audits.filter(item => item.entityType === 'account' && item.action === 'added');
  const transactionAdds = audits.filter(item => item.entityType === 'transaction' && item.action === 'added');
  const transactionUpdates = audits.filter(item => item.entityType === 'transaction' && item.action === 'modified');
  const transactionTombstones = audits.filter(item => item.entityType === 'transaction' && item.action === 'tombstoned');
  const quarantineAdds = audits.filter(item => item.entityType === 'quarantine' && item.action === 'quarantined');
  if (accountAdds.length !== counts.accountsAdded
    || transactionAdds.length !== counts.transactionsAdded
    || transactionUpdates.length !== counts.transactionsUpdated
    || transactionTombstones.length !== counts.transactionsTombstoned
    || quarantineAdds.length !== counts.sourceRecordsQuarantined
    || audits.length !== accountAdds.length + transactionAdds.length + transactionUpdates.length
      + transactionTombstones.length + quarantineAdds.length) return false;
  const hasUniqueEntityIds = items => new Set(items.map(item => item.entityId)).size === items.length;
  if (!hasUniqueEntityIds(accountAdds)
    || !hasUniqueEntityIds([...transactionAdds, ...transactionUpdates])
    || !hasUniqueEntityIds(transactionTombstones)
    || !hasUniqueEntityIds(quarantineAdds)) return false;

  const timestamp = receipt.createdAt;
  if (accountAdds.some(audit => !auditMatches(audit, {
    entityType:'account', action:'added', entityIds:expectedAccountIds, changedFields:['source'], observedAt:timestamp
  }))) return false;
  if (transactionAdds.some(audit => !auditMatches(audit, {
    entityType:'transaction', action:'added', entityIds:expectedTransactionIds, changedFields:['source'], observedAt:timestamp
  }))) return false;
  if (transactionUpdates.some(audit => audit.entityType !== 'transaction' || audit.action !== 'modified'
    || !expectedTransactionIds.has(audit.entityId) || !audit.changedFields.includes('sourceLifecycle')
    || audit.observedAt !== timestamp || audit.createdAt !== timestamp || audit.updatedAt !== timestamp)) return false;
  if (transactionTombstones.some(audit => !auditMatches(audit, {
    entityType:'transaction', action:'tombstoned', entityIds:quarantineTransactionIds,
    changedFields:['sourceLifecycle', 'tombstone'], observedAt:timestamp
  }))) return false;
  const createdQuarantineIds = new Set(createdQuarantines.map(item => item.id));
  if (quarantineAdds.some(audit => !auditMatches(audit, {
    entityType:'quarantine', action:'quarantined', entityIds:createdQuarantineIds,
    changedFields:['reason', 'sourceCurrency'], observedAt:timestamp
  }))) return false;

  const transactionById = new Map(domain.transactions.map(item => [item.id, item]));
  if (transactionUpdates.some(audit => !(transactionById.get(audit.entityId)?.sourceHistory || [])
    .some(history => history.batchId === batch.batchId && history.observedAt === timestamp))) return false;
  if (transactionTombstones.some(audit => !(transactionById.get(audit.entityId)?.sourceHistory || [])
    .some(history => history.batchId === batch.batchId && history.observedAt === timestamp))) return false;
  return true;
}

async function assertRejectedCandidateCsvReplay(state, receipt, batch) {
  assertPersistedReceiptStructure(receipt, 'LEGACY_RECEIPT_INVALID');
  if (receipt.sourceKind !== 'csv' || receipt.adapterKind !== 'csv.generic.v1'
    || receipt.sourceNamespace !== batch.sourceNamespace || receipt.batchId !== batch.batchId) {
    fail('BATCH_ID_COLLISION', 'A batch identifier was reused for different content.');
  }
  if (!rejectedCandidateCsvBatchShapeIsPossible(batch)) {
    fail('LEGACY_RECEIPT_INVALID', 'The persisted legacy receipt cannot represent a Candidate 1 CSV batch.');
  }
  const legacyBatch = clone(batch);
  // The CSV adapter used producedAt for every observational timestamp, while
  // normal persistence used that same value as the receipt creation time.
  legacyBatch.producedAt = receipt.createdAt;
  legacyBatch.observation.startedAt = receipt.createdAt;
  legacyBatch.observation.completedAt = receipt.createdAt;
  for (const mutation of legacyBatch.accountMutations) mutation.observedAt = receipt.createdAt;
  for (const mutation of legacyBatch.transactionMutations) mutation.observedAt = receipt.createdAt;
  for (const record of legacyBatch.quarantinedRecords) record.observedAt = receipt.createdAt;
  if (await computeLegacyEnvelopeDigest(legacyBatch) !== receipt.payloadDigest) {
    fail('BATCH_ID_COLLISION', 'A batch identifier was reused for different content.');
  }
  if (!provesRejectedCandidateCsvEffects(state, receipt, legacyBatch)) {
    fail('LEGACY_RECEIPT_EFFECTS_UNVERIFIED', 'Persisted state does not prove that the legacy ingestion batch was applied.');
  }
}

export async function reconcileMutationBatch(state, batch, {idFactory = defaultIdFactory, now = batch?.producedAt} = {}) {
  if (state?.schemaVersion !== STATE_SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA', `Ingestion requires vault schema ${STATE_SCHEMA_VERSION}.`);
  await validateSourceMutationBatch(batch);
  assertNoUnresolvedLegacyCsvAccountIdentity(state.domain, batch);
  const priorReceipt = state.domain?.ingestionReceipts?.find(item => item.batchId === batch.batchId);
  if (priorReceipt) {
    if (priorReceipt.payloadDigest === batch.payloadDigest) {
      assertPersistedReceiptStructure(priorReceipt, 'INGESTION_RECEIPT_INVALID');
    } else {
      await assertRejectedCandidateCsvReplay(state, priorReceipt, batch);
    }
    return {
      state:clone(state),
      changed:false,
      result:validatedReplayResult(priorReceipt)
    };
  }

  const next = clone(state);
  const domain = next.domain;
  if (!domain || !Array.isArray(domain.accounts) || !Array.isArray(domain.transactions)) fail('INVALID_DOMAIN_STATE', 'The canonical financial store is unavailable.');
  ensureCollections(domain);
  const context = {idFactory, now};
  const counts = resultCounts();
  const accounts = accountIndex(domain);
  const transactions = transactionIndex(domain);

  applyAccountAddsAndModifications(domain, batch, context, accounts, counts);
  applyOrdinaryTransactionMutations(next, domain, batch, context, accounts, transactions, counts);
  applyPendingPostedTransitions(next, domain, batch, context, accounts, transactions, counts);
  applyRemovals(next, domain, batch, context, transactions, counts);
  applyAccountDisconnects(domain, batch, context, accounts, counts);
  applyQuarantines(next, domain, batch, context, transactions, counts);
  if (counts.transactionsAdded > 0 && Array.isArray(next.review?.transactions)) {
    const weeks = [...new Set(next.review.transactions.map(item => item.weekStart).filter(Boolean))].sort((left, right) => right.localeCompare(left));
    if (weeks.length) next.review.selectedWeek = weeks[0];
  }

  const status = counts.interpretationConflicts > 0 ? 'conflict'
    : counts.sourceRecordsQuarantined > 0 ? 'quarantined' : 'applied';
  const result = {
    batchId:batch.batchId,
    payloadDigest:batch.payloadDigest,
    status,
    counts,
    safeErrorCodes:batch.sourceWarnings.map(item => item.code),
    receipt:{connectionId:batch.sourceKind === 'provider' ? batch.sourceNamespace : null, batchId:batch.batchId, payloadDigest:batch.payloadDigest}
  };
  domain.ingestionReceipts.push({
    id:`ingestion-receipt-${batch.payloadDigest.slice(0, 20)}`,
    batchId:batch.batchId,
    payloadDigest:batch.payloadDigest,
    sourceKind:batch.sourceKind,
    sourceNamespace:batch.sourceNamespace,
    adapterKind:batch.adapterKind,
    result:clone(result),
    createdAt:now,
    updatedAt:now
  });
  advanceStateRevision(next);
  const validation = validateDomainStore(domain);
  if (!validation.ok) fail('DOMAIN_VALIDATION_FAILED', `The reconciled domain is invalid: ${validation.errors.join('; ')}`);
  return {state:next, result, changed:true};
}

export async function applyMutationBatchAtomically(state, batch, persist, options = {}) {
  if (typeof persist !== 'function') fail('PERSISTENCE_REQUIRED', 'Atomic ingestion requires a persistence callback.');
  const reconciled = await reconcileMutationBatch(state, batch, options);
  if (!reconciled.changed) return {...reconciled, persistence:null};
  const persistence = await persist(reconciled.state);
  return {...reconciled, persistence};
}
