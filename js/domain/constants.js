export const PRODUCT_NAME = 'Money Moves';
export const STATE_SCHEMA_VERSION = 10;
export const DEFAULT_CURRENCY = 'USD';
export const UNKNOWN_ACCOUNT_ID = 'unknown-account';

// These values describe how a top-level bucket affects financial totals. They are
// deliberately explicit rather than inferred from a bucket name: a user bucket
// named "Income" is still ordinary spending unless it carries the reserved
// classification below.
export const BUCKET_SEMANTIC_TYPES = new Set(['spending', 'income', 'transfer', 'debt_payment']);
export const SYSTEM_BUCKET_IDS = Object.freeze({
  income:'mm-system-income',
  transfer:'mm-system-money-transfer',
  debtPayment:'mm-system-debt-payment'
});

export const STARTER_SPENDING_BUCKETS = Object.freeze([
  {id:'mm-starter-housing', name:'Housing', group:'Essentials'},
  {id:'mm-starter-food', name:'Food', group:'Essentials'},
  {id:'mm-starter-transportation', name:'Transportation', group:'Essentials'}
]);

export const DEVOTIONAL_RESPONSE_MAX_CHARS = 10000;
export const DEVOTIONAL_PRIVATE_NOTES_MAX_CHARS = 20000;

// V2_VAULT_KEY, V2_TEMP_VAULT_KEY, and V2_VAULT_WRITE_LEASE_KEY (former localStorage
// keys for the active vault, its in-flight temp record, and the persisted write
// lease) were retired when the vault moved to hosted storage — Postgres's atomic
// conditional write superseded all three. The platform lock name lives on: it is
// still the same-device Web Lock name, now a coalescing optimization rather than
// the write-safety authority. See js/services/hostedVaultStorage.js.
export const V2_VAULT_PLATFORM_LOCK_NAME = 'money-moves-vault-v2-writer';
export const V1_VAULT_KEY = 'verdant-vault-v1';
export const V1_TEMP_VAULT_KEY = 'verdant-vault-v1-temp';
export const V1_LEGACY_STATE_KEY = 'verdant-console-v2';

export const V1_VAULT_AAD = 'Verdant Vault v1';
export const V2_VAULT_AAD = 'Money Moves Vault v2';
