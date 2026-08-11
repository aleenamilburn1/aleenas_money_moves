import {normalizeCurrency, parseExactUsdAmount} from '../domain/exactMoney.js';
import {finishAdapterBatch, normalizedAccount, normalizedTransaction, quarantineRecord} from './adapterUtils.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function quarantineFromManual(item, producedAt, reason, safeDetailCode) {
  return quarantineRecord({
    sourceRecordRef:text(item.sourceRecordRef) || 'invalid-manual-record',
    sourceAccountRef:text(item.sourceAccountRef) || null,
    observedAt:item.observedAt || producedAt,
    reason,
    rawAmountDecimal:typeof item.amountDecimal === 'string' ? item.amountDecimal : null,
    sourceCurrency:normalizeCurrency(item.currency),
    safeDetailCode
  });
}

export async function createManualMutationBatch({
  batchId,
  sourceNamespace = 'manual:vault',
  producedAt,
  accounts = [],
  transactions = []
}) {
  const accountMutations = accounts.map(item => ({
    kind:item.kind ?? 'add',
    sourceAccountRef:item.sourceAccountRef,
    observedAt:item.observedAt ?? producedAt,
    account:(item.kind ?? 'add') === 'disconnect' ? null : normalizedAccount(item.account)
  }));
  const transactionMutations = [];
  const quarantinedRecords = [];

  for (const item of transactions) {
    const kind = item.kind ?? 'add';
    if (kind === 'remove') {
      transactionMutations.push({
        kind,
        sourceRecordRef:item.sourceRecordRef,
        sourceAccountRef:item.sourceAccountRef,
        observedAt:item.observedAt ?? producedAt,
        record:null,
        removal:{reason:item.removalReason ?? 'source_removed', predecessorOfRef:item.predecessorOfRef ?? null}
      });
      continue;
    }
    if (!text(item.sourceRecordRef) || !text(item.sourceAccountRef)) {
      quarantinedRecords.push(quarantineFromManual(item, producedAt, 'missing_account', 'MANUAL_IDENTITY_REQUIRED'));
      continue;
    }
    const currency = normalizeCurrency(item.currency);
    if (currency !== 'USD') {
      quarantinedRecords.push(quarantineFromManual(
        item,
        producedAt,
        currency ? 'unsupported_currency' : 'invalid_source_record',
        currency ? 'CURRENCY_NOT_ACTIVE' : 'INVALID_CURRENCY'
      ));
      continue;
    }
    if (item.direction !== 'inflow' && item.direction !== 'outflow') {
      quarantinedRecords.push(quarantineFromManual(item, producedAt, 'invalid_source_record', 'MANUAL_DIRECTION_REQUIRED'));
      continue;
    }
    if (typeof item.amountDecimal !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(item.amountDecimal.trim())) {
      quarantinedRecords.push(quarantineFromManual(item, producedAt, 'unsafe_amount', 'INVALID_DECIMAL'));
      continue;
    }
    const signConvention = item.direction === 'inflow' ? 'positive_inflow' : 'positive_outflow';
    let parsed;
    try {
      parsed = parseExactUsdAmount(item.amountDecimal, {signConvention, allowZero:false});
    } catch (error) {
      quarantinedRecords.push(quarantineFromManual(item, producedAt, 'unsafe_amount', error.code || 'INVALID_AMOUNT'));
      continue;
    }
    transactionMutations.push({
      kind,
      sourceRecordRef:item.sourceRecordRef,
      sourceAccountRef:item.sourceAccountRef,
      observedAt:item.observedAt ?? producedAt,
      record:normalizedTransaction({
        ...item,
        amountCents:parsed.amountCents,
        sourceAmount:{decimal:parsed.sourceDecimal, currency:'USD', signConvention},
        sourceDate:item.sourceDate,
        location:item.location ?? {region:null, country:null, source:'unavailable'}
      }),
      removal:null
    });
  }

  return finishAdapterBatch({
    batchId,
    sourceKind:'manual',
    adapterKind:'manual.v1',
    sourceNamespace,
    producedAt,
    accountMutations,
    transactionMutations,
    quarantinedRecords
  });
}
