import {finishAdapterBatch} from './adapterUtils.js';
import {encodeSourceAccountReference, SOURCE_ACCOUNT_IDENTITY_DOMAINS} from '../domain/ingestionContract.js';

function fixtureAccountIdentity(value) {
  if (value === null || value === undefined || value === '') {
    return {sourceAccountRef:null, sourceAccountIdentityDomain:null};
  }
  if (value === 'unknown-account') return {
    sourceAccountRef:encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.UNKNOWN),
    sourceAccountIdentityDomain:SOURCE_ACCOUNT_IDENTITY_DOMAINS.UNKNOWN
  };
  return {
    sourceAccountRef:encodeSourceAccountReference(SOURCE_ACCOUNT_IDENTITY_DOMAINS.DIRECT, value),
    sourceAccountIdentityDomain:SOURCE_ACCOUNT_IDENTITY_DOMAINS.DIRECT
  };
}

// A deterministic, offline non-production source adapter used to prove that
// reconciliation depends only on the provider-neutral contract.
export function createFixtureMutationBatch({
  batchId,
  sourceNamespace = 'fixture:default',
  producedAt,
  accountMutations = [],
  transactionMutations = [],
  quarantinedRecords = [],
  sourceWarnings = [],
  checkpoint = null
}) {
  const canonicalAccountMutations = accountMutations.map(mutation => ({
    ...mutation,
    ...fixtureAccountIdentity(mutation.sourceAccountRef)
  }));
  const canonicalTransactionMutations = transactionMutations.map(mutation => ({
    ...mutation,
    ...fixtureAccountIdentity(mutation.sourceAccountRef)
  }));
  const canonicalQuarantinedRecords = quarantinedRecords.map(record => ({
    ...record,
    ...fixtureAccountIdentity(record.sourceAccountRef)
  }));
  return finishAdapterBatch({
    batchId,
    sourceKind:'provider',
    adapterKind:'fixture.v1',
    sourceNamespace,
    producedAt,
    accountMutations:canonicalAccountMutations,
    transactionMutations:canonicalTransactionMutations,
    quarantinedRecords:canonicalQuarantinedRecords,
    sourceWarnings,
    checkpoint
  });
}
