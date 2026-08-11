import {finalizeMutationBatch, INGESTION_CONTRACT_VERSION} from '../domain/ingestionContract.js';

export function baseMutationBatch({
  batchId,
  sourceKind,
  adapterKind,
  sourceNamespace,
  producedAt,
  observation = null,
  checkpoint = null,
  accountMutations = [],
  transactionMutations = [],
  quarantinedRecords = [],
  sourceWarnings = []
}) {
  const observed = observation || {
    startedAt:producedAt,
    completedAt:producedAt,
    environment:'local',
    requestRef:null
  };
  return {
    contractVersion:INGESTION_CONTRACT_VERSION,
    batchId,
    sourceKind,
    adapterKind,
    sourceNamespace,
    producedAt,
    observation:observed,
    checkpoint,
    accountMutations,
    transactionMutations,
    quarantinedRecords,
    sourceWarnings,
    payloadDigest:''
  };
}

export async function finishAdapterBatch(input) {
  return finalizeMutationBatch(baseMutationBatch(input));
}

export function normalizedAccount(input = {}) {
  return {
    officialName:input.officialName ?? null,
    providerDisplayName:input.providerDisplayName ?? null,
    institution:{
      sourceInstitutionRef:input.institution?.sourceInstitutionRef ?? null,
      name:input.institution?.name ?? null
    },
    type:input.type ?? 'unknown',
    subtype:input.subtype ?? null,
    mask:input.mask ?? null,
    currency:input.currency ?? null,
    sourceStatus:input.sourceStatus ?? 'active',
    balances:input.balances ?? null,
    metadata:input.metadata ?? {}
  };
}

export function normalizedTransaction(input) {
  return {
    lifecycle:input.lifecycle ?? 'posted',
    predecessorSourceRef:input.predecessorSourceRef ?? null,
    amountCents:input.amountCents,
    currency:'USD',
    sourceAmount:{
      decimal:input.sourceAmount.decimal,
      currency:input.sourceAmount.currency,
      signConvention:input.sourceAmount.signConvention
    },
    sourceDate:input.sourceDate,
    authorizedDate:input.authorizedDate ?? null,
    authorizedAt:input.authorizedAt ?? null,
    postedDate:input.postedDate ?? (input.lifecycle === 'posted' ? input.sourceDate : null),
    postedAt:input.postedAt ?? null,
    rawDescription:input.rawDescription ?? null,
    displayDescription:input.displayDescription ?? input.rawDescription ?? null,
    merchant:input.merchant ?? null,
    providerCategory:input.providerCategory ?? null,
    paymentChannel:input.paymentChannel ?? null,
    location:input.location ?? {region:null, country:null, source:'unavailable'},
    sourceRevision:input.sourceRevision ?? null,
    sourceUpdatedAt:input.sourceUpdatedAt ?? null,
    metadata:input.metadata ?? {}
  };
}

export function quarantineRecord({
  sourceRecordRef,
  sourceAccountRef = null,
  observedAt,
  reason,
  rawAmountDecimal = null,
  sourceCurrency = null,
  safeDetailCode
}) {
  return {sourceRecordRef, sourceAccountRef, observedAt, reason, rawAmountDecimal, sourceCurrency, safeDetailCode};
}
