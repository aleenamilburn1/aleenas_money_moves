import {normalizedAccount, normalizedTransaction} from '../../js/adapters/adapterUtils.js';
import {formatSignedCents} from '../../js/domain/exactMoney.js';

export const V3A_NOW = '2026-08-11T16:00:00.000Z';

export function fixtureAccountMutation(sourceAccountRef = 'fixture-account-1', overrides = {}) {
  const kind = overrides.kind ?? 'add';
  return {
    kind,
    sourceAccountRef,
    observedAt:overrides.observedAt ?? V3A_NOW,
    account:kind === 'disconnect' ? null : normalizedAccount({
      officialName:'Fixture Checking',
      providerDisplayName:'Checking',
      institution:{sourceInstitutionRef:'fixture-institution', name:'Fixture Institution'},
      type:'depository',
      subtype:'checking',
      mask:'4321',
      currency:'USD',
      sourceStatus:'active',
      balances:null,
      metadata:{fixture:true},
      ...(overrides.account || {})
    })
  };
}

export function fixtureTransactionMutation(sourceRecordRef = 'fixture-transaction-1', overrides = {}) {
  const kind = overrides.kind ?? 'add';
  const amountCents = overrides.amountCents ?? -1250;
  const sourceAccountRef = overrides.sourceAccountRef ?? 'fixture-account-1';
  return {
    kind,
    sourceRecordRef,
    sourceAccountRef,
    observedAt:overrides.observedAt ?? V3A_NOW,
    record:kind === 'remove' ? null : normalizedTransaction({
      lifecycle:overrides.lifecycle ?? 'posted',
      predecessorSourceRef:overrides.predecessorSourceRef ?? null,
      amountCents,
      sourceAmount:{
        decimal:overrides.decimal ?? formatSignedCents(amountCents),
        currency:'USD',
        signConvention:overrides.signConvention ?? 'money_moves_signed'
      },
      sourceDate:overrides.sourceDate ?? '2026-08-10',
      authorizedDate:overrides.authorizedDate ?? null,
      authorizedAt:null,
      postedDate:overrides.postedDate === undefined ? '2026-08-10' : overrides.postedDate,
      postedAt:null,
      rawDescription:overrides.rawDescription ?? 'Fixture Market',
      displayDescription:overrides.displayDescription ?? 'Fixture Market',
      merchant:{name:overrides.merchantName ?? 'Fixture Market', sourceEntityRef:null, websiteHost:null},
      providerCategory:{primary:'FOOD', detailed:'GROCERIES', confidence:'HIGH', taxonomyVersion:'fixture-v1'},
      paymentChannel:'card',
      location:{region:null, country:'US', source:'provider'},
      sourceRevision:overrides.sourceRevision ?? 'revision-1',
      sourceUpdatedAt:overrides.sourceUpdatedAt ?? V3A_NOW,
      metadata:overrides.metadata ?? {fixture:true}
    }),
    removal:kind === 'remove' ? {
      reason:overrides.removalReason ?? 'source_removed',
      predecessorOfRef:overrides.predecessorOfRef ?? null
    } : null
  };
}
