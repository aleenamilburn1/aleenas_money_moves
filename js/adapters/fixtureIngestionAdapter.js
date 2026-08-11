import {finishAdapterBatch} from './adapterUtils.js';

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
  return finishAdapterBatch({
    batchId,
    sourceKind:'provider',
    adapterKind:'fixture.v1',
    sourceNamespace,
    producedAt,
    accountMutations,
    transactionMutations,
    quarantinedRecords,
    sourceWarnings,
    checkpoint
  });
}
