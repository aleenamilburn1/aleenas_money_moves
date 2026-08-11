function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (character !== '\r') field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1)
    .filter(values => values.some(value => String(value).trim()))
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function firstValue(row, names) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function parseAmount(value, signConvention) {
  try { return parseExactUsdAmount(String(value || '').trim(), {signConvention, allowZero:false}); }
  catch { return null; }
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0,10);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0,10);
}

export function rowsToTransactions(rows, settings = {}) {
  const positiveMeansSpend = settings.positiveMeansSpend !== false;
  const includeMoneyMovement = settings.includeMoneyMovement !== false;
  const transactions = [];
  const rejected = [];

  rows.forEach((row, index) => {
    const date = normalizeDate(firstValue(row,['date','posted_date','posted_datetime','datetime','transaction_date','authorized_date']));
    const merchant = firstValue(row,['merchant_name','merchant','name','description','transaction','payee']);
    const normalizedAmountRaw = firstValue(row,['normalized_amount']);
    const amountRaw = normalizedAmountRaw || firstValue(row,['amount','debit','charge','transaction_amount','value']);
    const parsedAmount = parseAmount(amountRaw, positiveMeansSpend ? 'positive_outflow' : 'money_moves_signed');
    const primary = String(firstValue(row,['personal_finance_category_primary','primary_category','category']) || '').toLowerCase();
    const detail = firstValue(row,['personal_finance_category_detailed','category_detail','subcategory']);
    const account = firstValue(row,['account_name','account','account_label','card']);
    const transactionId = firstValue(row,['transaction_id','id','transactionid']);

    if (!date || !merchant || !parsedAmount) {
      rejected.push({row:index + 2, reason:'Missing date, merchant, or amount'});
      return;
    }

    const flow = parsedAmount.amountCents > 0 ? 'inflow' : 'outflow';

    if (!includeMoneyMovement && flow !== 'outflow') return;
    transactions.push({
      id:transactionId || undefined,
      date,
      merchant:String(merchant),
      amount:formatSignedCents(BigInt(Math.abs(parsedAmount.amountCents))),
      amountCents:Math.abs(parsedAmount.amountCents),
      account:String(account || 'Imported account'),
      providerCategory:String(primary || ''),
      providerDetail:String(detail || ''),
      flow
    });
  });

  return {transactions, rejected};
}
import {formatSignedCents, parseExactUsdAmount} from './domain/exactMoney.js';
