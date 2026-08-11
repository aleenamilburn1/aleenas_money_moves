import {normalizeCurrency, parseExactUsdAmount} from '../domain/exactMoney.js';
import {sha256Text, stableCanonicalJson} from '../domain/ingestionContract.js';
import {parseCsv} from '../csv.js';
import {finishAdapterBatch, normalizedAccount, normalizedTransaction, quarantineRecord} from './adapterUtils.js';

const DEFAULT_PROFILE = Object.freeze({
  id:'default-usd-bank-export',
  signProfile:'positive_outflow',
  currency:'USD',
  currencyGuaranteed:true,
  amountColumns:['normalized_amount', 'amount', 'charge', 'transaction_amount', 'value'],
  debitColumns:['debit'],
  creditColumns:['credit'],
  dateColumns:['date', 'posted_date', 'posted_datetime', 'datetime', 'transaction_date', 'authorized_date'],
  descriptionColumns:['merchant_name', 'merchant', 'name', 'description', 'transaction', 'payee'],
  accountColumns:['account_name', 'account', 'account_label', 'card'],
  accountIdColumns:['account_id'],
  transactionIdColumns:['transaction_id', 'id', 'transactionid'],
  currencyColumns:['currency', 'iso_currency_code'],
  categoryPrimaryColumns:['personal_finance_category_primary', 'primary_category', 'category'],
  categoryDetailedColumns:['personal_finance_category_detailed', 'category_detail', 'subcategory']
});

function firstValue(row, names = []) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function calendarDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const [, month, day, year] = match;
  const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${candidate}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

function accountType(value) {
  const type = String(value || '').trim().toLowerCase();
  return ['cash', 'depository', 'credit', 'loan', 'savings', 'investment', 'other', 'unknown'].includes(type) ? type : 'unknown';
}

function quarantine({ref, accountRef, observedAt, amount, currency, reason, code}) {
  return quarantineRecord({
    sourceRecordRef:ref,
    sourceAccountRef:accountRef,
    observedAt,
    reason,
    rawAmountDecimal:amount || null,
    sourceCurrency:currency || null,
    safeDetailCode:code
  });
}

async function sourceAccountReference(row, profile) {
  const external = firstValue(row, profile.accountIdColumns);
  if (external) return `external:${external}`;
  const label = firstValue(row, profile.accountColumns);
  if (!label) return 'unknown-account';
  if (profile.accountMappings && typeof profile.accountMappings[label] === 'string') return profile.accountMappings[label];
  return `label:${(await sha256Text(label)).slice(0, 24)}`;
}

function sourceAmountInput(row, profile) {
  if (profile.signProfile === 'debit_credit') {
    const debit = firstValue(row, profile.debitColumns);
    const credit = firstValue(row, profile.creditColumns);
    if (Boolean(debit) === Boolean(credit)) return {error:'DEBIT_CREDIT_EXCLUSIVE', decimal:debit || credit || '', direction:null};
    return {decimal:debit || credit, direction:debit ? 'debit' : 'credit', error:null};
  }
  return {decimal:firstValue(row, profile.amountColumns), direction:null, error:null};
}

function signConvention(profile) {
  if (profile.signProfile === 'signed_cash_flow') return 'money_moves_signed';
  if (profile.signProfile === 'positive_inflow') return 'positive_inflow';
  if (profile.signProfile === 'debit_credit') return 'debit_credit';
  return 'positive_outflow';
}

export async function createCsvMutationBatch({
  csvText,
  rows = null,
  profile:profileInput = {},
  producedAt,
  sourceNamespace = null
}) {
  const profile = {...DEFAULT_PROFILE, ...profileInput};
  const parsedRows = rows || parseCsv(csvText || '');
  const fileDigest = await sha256Text(csvText ?? stableCanonicalJson(parsedRows));
  const profileDigest = await sha256Text(stableCanonicalJson(profile));
  const namespace = sourceNamespace || `csv:${profile.id}`;
  const batchId = `csv:${fileDigest}:${profileDigest.slice(0, 24)}`;
  const accountFacts = new Map();
  const transactionMutations = [];
  const quarantinedRecords = [];

  for (const [index, row] of parsedRows.entries()) {
    const line = index + 2;
    const externalRef = firstValue(row, profile.transactionIdColumns);
    const sourceRecordRef = externalRef ? `external:${externalRef}` : `file:${fileDigest}:row:${line}`;
    const sourceAccountRef = await sourceAccountReference(row, profile);
    const observedAt = producedAt;
    const amountInput = sourceAmountInput(row, profile);
    const currencyText = firstValue(row, profile.currencyColumns) || (profile.currencyGuaranteed ? profile.currency : '');
    const currency = normalizeCurrency(currencyText);
    const date = calendarDate(firstValue(row, profile.dateColumns));
    const description = firstValue(row, profile.descriptionColumns) || null;
    const accountName = firstValue(row, profile.accountColumns) || null;

    if (!accountFacts.has(sourceAccountRef)) {
      accountFacts.set(sourceAccountRef, {
        officialName:accountName,
        providerDisplayName:accountName,
        institution:{sourceInstitutionRef:null, name:firstValue(row, ['institution', 'institution_name']) || null},
        type:accountType(firstValue(row, ['account_type', 'type'])),
        subtype:firstValue(row, ['account_subtype', 'subtype']) || null,
        mask:firstValue(row, ['mask', 'last_four']) || null,
        currency,
        sourceStatus:'active',
        balances:null,
        metadata:{}
      });
    } else if (accountFacts.get(sourceAccountRef).currency !== currency) {
      accountFacts.get(sourceAccountRef).currency = null;
    }

    if (!date) {
      quarantinedRecords.push(quarantine({ref:sourceRecordRef, accountRef:sourceAccountRef, observedAt, amount:amountInput.decimal, currency:currencyText, reason:'invalid_source_record', code:'INVALID_SOURCE_DATE'}));
      continue;
    }
    if (!currency) {
      quarantinedRecords.push(quarantine({ref:sourceRecordRef, accountRef:sourceAccountRef, observedAt, amount:amountInput.decimal, currency:currencyText, reason:'invalid_source_record', code:'INVALID_CURRENCY'}));
      continue;
    }
    if (currency !== 'USD') {
      quarantinedRecords.push(quarantine({ref:sourceRecordRef, accountRef:sourceAccountRef, observedAt, amount:amountInput.decimal, currency, reason:'unsupported_currency', code:'CURRENCY_NOT_ACTIVE'}));
      continue;
    }
    if (amountInput.error) {
      quarantinedRecords.push(quarantine({ref:sourceRecordRef, accountRef:sourceAccountRef, observedAt, amount:amountInput.decimal, currency, reason:'unsafe_amount', code:amountInput.error}));
      continue;
    }
    const convention = signConvention(profile);
    let parsed;
    try {
      parsed = parseExactUsdAmount(amountInput.decimal, {signConvention:convention, direction:amountInput.direction, allowZero:false});
    } catch (error) {
      quarantinedRecords.push(quarantine({ref:sourceRecordRef, accountRef:sourceAccountRef, observedAt, amount:amountInput.decimal, currency, reason:'unsafe_amount', code:error.code || 'INVALID_AMOUNT'}));
      continue;
    }
    const metadata = amountInput.direction ? {debitCreditDirection:amountInput.direction} : {};
    transactionMutations.push({
      kind:'add',
      sourceRecordRef,
      sourceAccountRef,
      observedAt,
      record:normalizedTransaction({
        lifecycle:'posted',
        amountCents:parsed.amountCents,
        sourceAmount:{decimal:parsed.sourceDecimal, currency:'USD', signConvention:convention},
        sourceDate:date,
        postedDate:date,
        rawDescription:description,
        displayDescription:description,
        merchant:description ? {name:description, sourceEntityRef:null, websiteHost:null} : null,
        providerCategory:{
          primary:firstValue(row, profile.categoryPrimaryColumns) || null,
          detailed:firstValue(row, profile.categoryDetailedColumns) || null,
          confidence:null,
          taxonomyVersion:null
        },
        location:{
          region:firstValue(row, ['region', 'state']) || null,
          country:firstValue(row, ['country']) || null,
          source:firstValue(row, ['region', 'state', 'country']) ? 'import' : 'unavailable'
        },
        metadata
      }),
      removal:null
    });
  }

  const accountMutations = [...accountFacts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sourceAccountRef, account]) => ({
    kind:'add',
    sourceAccountRef,
    observedAt:producedAt,
    account:normalizedAccount(account)
  }));

  return finishAdapterBatch({
    batchId,
    sourceKind:'csv',
    adapterKind:'csv.generic.v1',
    sourceNamespace:namespace,
    producedAt,
    accountMutations,
    transactionMutations,
    quarantinedRecords,
    sourceWarnings:[]
  });
}

export {DEFAULT_PROFILE as DEFAULT_CSV_INGESTION_PROFILE};
