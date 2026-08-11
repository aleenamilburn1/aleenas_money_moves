import {migrateState, resolveMigrationTimestamp} from './domain/migrations.js';
import {aggregateMonthlyBucketActivity, bucketSemanticType} from './services/bucketService.js';

const clone = value => JSON.parse(JSON.stringify(value));

export function isValidMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function localDateParts(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function monthKey(value = new Date()) {
  if (typeof value === 'string' && isValidMonth(value.slice(0, 7))) return value.slice(0, 7);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return monthKey(new Date());
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;
}

export function monthLabel(value) {
  const month = isValidMonth(value) ? value : monthKey();
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber - 1, 1, 12);
  return new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric'}).format(date);
}

export function money(value) {
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value || 0));
}

export function normalizeMerchant(value) {
  return String(value || 'Unknown merchant').trim().replace(/\s+/g,' ');
}

export function merchantKey(value) {
  return normalizeMerchant(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}

export function weekStart(value) {
  const calendarDate = String(value).slice(0,10);
  if (!validCalendarDate(calendarDate)) return null;
  const [year, month, dayOfMonth] = calendarDate.split('-').map(Number);
  const date = new Date(year, month - 1, dayOfMonth, 12);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1-day));
  return localDateParts(date);
}

export function weekLabel(start) {
  if (!validCalendarDate(start)) return 'No week';
  const [year, month, day] = start.split('-').map(Number);
  const first = new Date(year, month - 1, day, 12);
  const last = new Date(first);
  last.setDate(first.getDate()+6);
  const f = new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric'});
  return `${f.format(first)}–${f.format(last)}`;
}

function slug(value) {
  return String(value || 'bucket').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'bucket';
}

function fingerprint(tx) {
  const raw = [tx.date,merchantKey(tx.merchant),Number(tx.amount||0).toFixed(2),String(tx.account||'').toLowerCase(),tx.flow].join('|');
  let hash = 2166136261;
  for (let i=0;i<raw.length;i+=1) { hash ^= raw.charCodeAt(i); hash = Math.imul(hash,16777619); }
  return `tx-${(hash>>>0).toString(16)}`;
}

function stableIdentifier(prefix, parts) {
  const text = parts.map(value => String(value || '')).join('|');
  let hash = 2166136261;
  for (let index=0; index<text.length; index+=1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash,16777619); }
  return `${prefix}-${(hash >>> 0).toString(16)}`;
}

export function normalizeTransaction(raw, state, {defaultTimestamp = new Date().toISOString()} = {}) {
  const date = String(raw.date || defaultTimestamp.slice(0,10)).slice(0,10);
  const merchant = normalizeMerchant(raw.merchant || raw.name || raw.description);
  const flow = ['outflow','inflow','transfer'].includes(raw.flow) ? raw.flow : 'outflow';
  const rule = state?.review?.merchantRules?.find(item => item.merchantKey === merchantKey(merchant));
  const bucketId = raw.bucketId || rule?.bucketId || null;
  return {
    ...raw,
    id: raw.id || raw.transactionId || fingerprint({date,merchant,amount:raw.amount,account:raw.account,flow}),
    date,
    weekStart: weekStart(date),
    merchant,
    merchantKey: merchantKey(merchant),
    name: String(raw.name || merchant),
    amount: Math.abs(Number(raw.amount || 0)),
    account: String(raw.account || raw.accountName || 'Unknown account'),
    providerCategory: String(raw.providerCategory || raw.category || ''),
    providerDetail: String(raw.providerDetail || ''),
    providerConfidence: String(raw.providerConfidence || ''),
    flow,
    bucketId,
    reviewStatus: raw.reviewStatus || (rule || bucketId ? 'suggested' : 'pending'),
    reviewedAt: raw.reviewedAt || null,
    source: raw.source || 'import',
    importedAt: raw.importedAt || defaultTimestamp
  };
}

function hydrateLegacyUiState(input, seed, {now, currentDate} = {}) {
  const state = clone(input || seed);
  const migrationNow = resolveMigrationTimestamp(state, now);
  state.app = {...clone(seed.app), ...(state.app || {})};
  state.preferences = {...clone(seed.preferences), ...(state.preferences || {})};
  state.monthly = {...clone(seed.monthly), ...(state.monthly || {})};
  state.review = state.review || {};
  state.review.buckets = Array.isArray(state.review.buckets) ? state.review.buckets : [];
  state.review.transactions = Array.isArray(state.review.transactions) ? state.review.transactions : [];
  state.review.merchantRules = Array.isArray(state.review.merchantRules) ? state.review.merchantRules : [];
  state.review.importSettings = {...clone(seed.review.importSettings), ...(state.review.importSettings || {})};

  const oldCategoryById = new Map((state.categories || []).map(item => [item.id,item]));
  for (const seedBucket of seed.review.buckets) {
    let bucket = state.review.buckets.find(item => item.id === seedBucket.id);
    if (!bucket) {
      const legacyAlias = seedBucket.id === 'subscriptions'
        ? state.review.buckets.find(item => item.id === 'services')
        : null;
      if (legacyAlias) {
        legacyAlias.id = 'subscriptions';
        bucket = legacyAlias;
        for (const tx of state.review.transactions) if (tx.bucketId === 'services') tx.bucketId = 'subscriptions';
      } else {
        bucket = clone(seedBucket);
        state.review.buckets.push(bucket);
      }
    }
    const legacyCategory = oldCategoryById.get(bucket.id) || oldCategoryById.get(seedBucket.id);
    bucket.name = bucket.name || seedBucket.name;
    bucket.group = bucket.group || seedBucket.group;
    bucket.target = Number(bucket.target ?? legacyCategory?.target ?? seedBucket.target ?? 0);
    bucket.system = Boolean(bucket.system ?? seedBucket.system);
    bucket.order = Number(bucket.order ?? seedBucket.order ?? 999);
    bucket.protected = Boolean(bucket.protected ?? seedBucket.protected);
  }
  state.review.buckets.sort((a,b) => a.order-b.order);
  state.review.buckets.forEach((bucket,index) => { bucket.order = index+1; });

  const normalizedRules = state.review.merchantRules.map((rule,index) => ({
    ...rule,
    id: rule.id || stableIdentifier('legacy-rule', [index, rule.merchantKey, rule.merchant, rule.pattern, rule.bucketId]),
    merchant: rule.merchant || rule.pattern || rule.merchantKey,
    merchantKey: rule.merchantKey || merchantKey(rule.merchant || rule.pattern),
    bucketId: rule.bucketId,
    createdAt: rule.createdAt || migrationNow
  }));
  const validBucketIds = new Set(state.review.buckets.map(bucket => bucket.id));
  const unresolvedRules = normalizedRules.filter(rule => !validBucketIds.has(rule.bucketId));
  state.review.merchantRules = normalizedRules.filter(rule => validBucketIds.has(rule.bucketId));
  if (unresolvedRules.length) {
    state.legacyV1 = state.legacyV1 || {};
    const existing = Array.isArray(state.legacyV1.unresolvedMerchantRules) ? state.legacyV1.unresolvedMerchantRules : [];
    const existingIds = new Set(existing.map(rule => rule.id));
    state.legacyV1.unresolvedMerchantRules = [...existing, ...unresolvedRules.filter(rule => !existingIds.has(rule.id))];
  }

  state.review.transactions = state.review.transactions.map(raw => normalizeTransaction(raw,state,{defaultTimestamp:migrationNow}));

  state.providerSnapshot = state.providerSnapshot && typeof state.providerSnapshot === 'object'
    ? clone(state.providerSnapshot)
    : {};
  state.providerSnapshot.accounts = Array.isArray(state.providerSnapshot.accounts) ? state.providerSnapshot.accounts : [];
  state.providerSnapshot.recurring = Array.isArray(state.providerSnapshot.recurring) ? state.providerSnapshot.recurring : [];

  state.travel = state.travel || {};
  state.travel.visited = Array.isArray(state.travel.visited) ? state.travel.visited : [];
  state.travel.destinations = Array.isArray(state.travel.destinations) ? state.travel.destinations : [];
  state.scriptures = Array.isArray(state.scriptures) ? state.scriptures : [];

  const current = monthKey(currentDate === undefined ? new Date() : currentDate);
  if (!isValidMonth(state.monthly.selectedMonth)) state.monthly.selectedMonth = current;
  state.monthly.activeMonth = state.monthly.selectedMonth;
  state.monthly.lastOpenedMonth = current;

  const weeks = availableWeeks(state);
  if (!state.review.selectedWeek || !weeks.includes(state.review.selectedWeek)) {
    state.review.selectedWeek = weeks[0] || weekStart(localDateParts(currentDate instanceof Date ? currentDate : new Date(currentDate || Date.now())));
  }
  if (Array.isArray(state.categories)) {
    state.legacyV1 = state.legacyV1 || {};
    if (!Array.isArray(state.legacyV1.categories)) state.legacyV1.categories = clone(state.categories);
  }
  return state;
}

export function upgradeStateWithMigration(input, seed, options = {}) {
  const original = clone(input || seed);
  const migrationNow = resolveMigrationTimestamp(original, options.now);
  const currentDate = options.currentDate ?? options.now ?? new Date();
  const firstPass = migrateState(original, {...options, now:migrationNow});
  const hydrated = hydrateLegacyUiState(firstPass.state, seed, {now:migrationNow, currentDate});
  const finalPass = migrateState(hydrated, {...options, now:migrationNow});
  return {
    ...finalPass,
    fromVersion:firstPass.fromVersion,
    applied:firstPass.applied,
    changed:!Object.is(JSON.stringify(original), JSON.stringify(finalPass.state))
  };
}

export function upgradeState(input, seed, options = {}) {
  return upgradeStateWithMigration(input, seed, options).state;
}

export function availableMonths(state, {clock = new Date()} = {}) {
  const months = new Set();
  for (const tx of [...(state.review?.transactions || []), ...(state.domain?.transactions || [])]) {
    const month = String(tx.date || tx.displayDate || tx.postedAt || tx.authorizedAt || '').slice(0, 7);
    if (isValidMonth(month)) months.add(month);
  }
  months.add(monthKey(clock));
  if (isValidMonth(state.monthly?.selectedMonth)) months.add(state.monthly.selectedMonth);
  return [...months].sort((a,b)=>b.localeCompare(a));
}

export function availableWeeks(state) {
  return [...new Set(state.review.transactions.map(tx => tx.weekStart).filter(Boolean))].sort((a,b)=>b.localeCompare(a));
}

export function weekTransactions(state, selected = state.review.selectedWeek) {
  return state.review.transactions.filter(tx => tx.weekStart === selected)
    .sort((a,b)=>b.date.localeCompare(a.date) || a.merchant.localeCompare(b.merchant));
}

export function weekStats(state, selected = state.review.selectedWeek) {
  const items = weekTransactions(state,selected);
  const reviewed = items.filter(tx => tx.reviewStatus === 'reviewed').length;
  return {
    total:items.length,
    reviewed,
    remaining:items.length-reviewed,
    completion:items.length ? Math.round(reviewed/items.length*100) : 0
  };
}

export function reviewQueue(state) {
  return weekTransactions(state).filter(tx => tx.reviewStatus !== 'reviewed');
}

export function bucketById(state,id) {
  return state.review.buckets.find(bucket => bucket.id === id) || null;
}

export function sortedBuckets(state, includeSystem = true, includeArchived = false) {
  return state.review.buckets.filter(bucket => (includeSystem || !bucket.system) && (includeArchived || bucket.active !== false)).sort((a,b)=>a.order-b.order);
}

export function assignBucket(state, transactionId, bucketId, rememberRule=false) {
  const tx = state.review.transactions.find(item => item.id === transactionId);
  if (!tx || !bucketById(state,bucketId)) return false;
  tx.bucketId = bucketId;
  tx.reviewStatus = 'reviewed';
  tx.reviewedAt = new Date().toISOString();
  if (rememberRule) {
    let rule = state.review.merchantRules.find(item => item.merchantKey === tx.merchantKey);
    if (!rule) {
      rule = {id:crypto.randomUUID(),merchant:tx.merchant,merchantKey:tx.merchantKey,bucketId,createdAt:new Date().toISOString()};
      state.review.merchantRules.push(rule);
    } else rule.bucketId = bucketId;
  }
  return true;
}

export function addTransactions(state, rawTransactions, source='csv') {
  const ids = new Set(state.review.transactions.map(tx=>tx.id));
  let imported=0, duplicates=0;
  for (const raw of rawTransactions) {
    // Legacy compatibility only. Current CSV/manual ingestion uses the V3A
    // source-key reconciler. Even here, semantic facts never establish identity.
    const id = raw.id || raw.transactionId || crypto.randomUUID();
    const tx = normalizeTransaction({...raw,id,source},state);
    if (ids.has(tx.id)) { duplicates+=1; continue; }
    state.review.transactions.push(tx);
    ids.add(tx.id); imported+=1;
  }
  const weeks = availableWeeks(state);
  if (weeks.length) state.review.selectedWeek = weeks[0];
  return {imported,duplicates};
}

export function addBucket(state,name,group='Wants',target=0) {
  const clean = String(name||'').trim();
  if (!clean) throw new Error('Enter a bucket name.');
  let id = slug(clean), n=2;
  while (state.review.buckets.some(bucket=>bucket.id===id)) id=`${slug(clean)}-${n++}`;
  const maxOrder = Math.max(0,...state.review.buckets.map(bucket=>bucket.order||0));
  state.review.buckets.push({id,name:clean,group,target:Number(target||0),system:false,order:maxOrder+1,protected:false});
  return id;
}

export function updateBucket(state,id,patch) {
  const bucket = bucketById(state,id);
  if (!bucket) return false;
  if (patch.name !== undefined && String(patch.name).trim()) bucket.name=String(patch.name).trim();
  if (patch.group !== undefined && !bucket.system) bucket.group=patch.group;
  if (patch.target !== undefined && !bucket.system) bucket.target=Math.max(0,Number(patch.target)||0);
  if (patch.protected !== undefined && !bucket.system) bucket.protected=Boolean(patch.protected);
  return true;
}

export function reorderBucket(state,draggedId,targetId) {
  const buckets=sortedBuckets(state,true);
  const from=buckets.findIndex(item=>item.id===draggedId);
  const to=buckets.findIndex(item=>item.id===targetId);
  if (from<0 || to<0 || from===to) return false;
  const [moved]=buckets.splice(from,1);
  buckets.splice(to,0,moved);
  buckets.forEach((bucket,index)=>bucket.order=index+1);
  state.review.buckets=buckets;
  return true;
}

export function moveBucket(state,id,direction) {
  const buckets=sortedBuckets(state,true);
  const index=buckets.findIndex(item=>item.id===id);
  const next=index+direction;
  if (index<0 || next<0 || next>=buckets.length) return false;
  [buckets[index],buckets[next]]=[buckets[next],buckets[index]];
  buckets.forEach((bucket,i)=>bucket.order=i+1);
  state.review.buckets=buckets;
  return true;
}

export function transactionsForMonth(state,month=state.monthly.selectedMonth) {
  const selectedMonth=isValidMonth(month) ? month : monthKey();
  return state.review.transactions.filter(tx=>tx.date.startsWith(`${selectedMonth}-`));
}

export function monthSummary(state,month=state.monthly.selectedMonth) {
  const selectedMonth=isValidMonth(month) ? month : monthKey();
  const activity=aggregateMonthlyBucketActivity(state, selectedMonth);
  const actuals=Object.fromEntries(Object.entries(activity.actualsCents).map(([id, cents]) => [id, cents / 100]));
  const spend=activity.spendCents / 100;
  const income=activity.incomeCents / 100;
  const debtPayments=activity.debtPaymentCents / 100;
  const reviewedSpend=activity.reviewedSpendCents / 100;
  const provisionalSpend=activity.provisionalSpendCents / 100;
  const protectedRemaining=(state.domain?.buckets || [])
    .filter(bucket=>bucket.protected && bucketSemanticType(bucket)==='spending' && bucket.parentId===null && bucket.active!==false)
    .reduce((sum,bucket)=>sum+Math.max(0,bucket.targetCents/100-Number(actuals[bucket.id]||0)),0);
  const baselineIncome=Number(state.preferences?.monthlyIncome || state.providerSnapshot?.averageMonthlyIncome || 0);
  return {
    month:selectedMonth, actuals, spend, income, debtPayments, cashFlow:income-spend-debtPayments,
    safeToSpend:Math.max(0,baselineIncome-spend-debtPayments-protectedRemaining),
    protectedRemaining, reviewedSpend, provisionalSpend
  };
}

export function debtAccounts(state) {
  return (state.providerSnapshot.accounts||[]).filter(account=>account.kind==='credit').map(account=>({
    ...account,
    utilization: account.limit ? account.balance/account.limit*100 : null
  })).sort((a,b)=>(b.utilization??-1)-(a.utilization??-1));
}

export function rankedDestinations(state,month=state.monthly.selectedMonth) {
  const monthNumber=Number(month.slice(5,7));
  const visited=new Set(state.travel.visited.map(item=>`${item.city}|${item.state}`.toLowerCase()));
  return state.travel.destinations
    .filter(item=>!visited.has(`${item.city}|${item.state}`.toLowerCase()))
    .map(item=>{
      const baseScore=Number.isFinite(Number(item.baseScore)) ? Number(item.baseScore) : 0;
      const estimate=Number.isFinite(Number(item.est)) ? Number(item.est) : 0;
      const maxBudget=Number(state.preferences.maxGroundBudget);
      return {
        ...item,
        score:baseScore+(Array.isArray(item.bestMonths) && item.bestMonths.includes(monthNumber) ? 5 : 0)
          -(Number.isFinite(maxBudget) && estimate>maxBudget ? 20 : 0)
      };
    })
    .sort((a,b)=>b.score-a.score || Number(a.est||0)-Number(b.est||0))
    .slice(0,3);
}

export function addVisited(state,city,region) {
  const cleanCity=String(city||'').trim(), cleanState=String(region||'').trim().toUpperCase();
  if (!cleanCity || !cleanState) throw new Error('Enter both city and state.');
  if (state.travel.visited.some(item=>item.city.toLowerCase()===cleanCity.toLowerCase() && item.state.toLowerCase()===cleanState.toLowerCase())) return false;
  state.travel.visited.push({id:crypto.randomUUID(),city:cleanCity,state:cleanState});
  return true;
}

export function scriptureForMonth(state,month=state.monthly.selectedMonth) {
  const index=(Number(month.slice(0,4))*12+Number(month.slice(5,7))-1)%state.scriptures.length;
  return state.scriptures[index];
}
