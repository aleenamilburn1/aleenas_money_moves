export const SOURCE_SIGN_CONVENTIONS = Object.freeze([
  'money_moves_signed',
  'positive_outflow',
  'positive_inflow',
  'debit_credit'
]);

const SIGN_CONVENTIONS = new Set(SOURCE_SIGN_CONVENTIONS);
const DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d{1,2})?$/;

export class ExactMoneyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExactMoneyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ExactMoneyError(code, message);
}

function applySignConvention(value, signConvention, direction) {
  if (!SIGN_CONVENTIONS.has(signConvention)) fail('INVALID_SIGN_CONVENTION', 'The source sign convention is invalid.');
  if (signConvention === 'positive_outflow') return -value;
  if (signConvention === 'positive_inflow' || signConvention === 'money_moves_signed') return value;
  if (direction !== 'debit' && direction !== 'credit') {
    fail('MISSING_DEBIT_CREDIT_DIRECTION', 'Debit/credit source amounts require an explicit direction.');
  }
  const magnitude = value < 0n ? -value : value;
  return direction === 'debit' ? -magnitude : magnitude;
}

// Exact source parsing is deliberately string/BigInt-only. No source amount is
// ever routed through Number, parseFloat, or binary floating-point rounding.
export function parseExactUsdAmount(decimal, {
  signConvention = 'money_moves_signed',
  direction = null,
  allowZero = true
} = {}) {
  if (typeof decimal !== 'string') fail('INVALID_DECIMAL', 'The source amount must be decimal text.');
  const sourceDecimal = decimal.trim();
  if (!sourceDecimal || !DECIMAL_PATTERN.test(sourceDecimal)) {
    fail('INVALID_DECIMAL', 'The source amount must be a plain decimal with at most two fractional digits.');
  }
  const sign = sourceDecimal.startsWith('-') ? -1n : 1n;
  const unsigned = sourceDecimal.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  let signed = applySignConvention(sign * magnitude, signConvention, direction);
  if (signed === 0n) signed = 0n;
  if (!allowZero && signed === 0n) fail('ZERO_AMOUNT', 'A source transaction amount must not be zero.');
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (signed > maximum || signed < -maximum) fail('UNSAFE_AMOUNT', 'The source amount exceeds the safe integer-cent range.');
  return {
    amountCents:Number(signed),
    sourceDecimal,
    normalizedDecimal:formatSignedCents(signed)
  };
}

export function formatSignedCents(value) {
  const cents = typeof value === 'bigint' ? value : BigInt(value);
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = String(magnitude % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function normalizeCurrency(value) {
  if (typeof value !== 'string') return null;
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export function parseActiveUsdSourceAmount({decimal, currency, signConvention, direction = null} = {}) {
  const normalizedCurrency = normalizeCurrency(currency);
  if (normalizedCurrency !== 'USD') {
    fail(normalizedCurrency ? 'UNSUPPORTED_CURRENCY' : 'INVALID_CURRENCY', 'Only explicit USD source amounts enter active accounting.');
  }
  return {
    ...parseExactUsdAmount(decimal, {signConvention, direction, allowZero:false}),
    currency:normalizedCurrency
  };
}
