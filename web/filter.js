// Query state + predicate engine + facet counts. Plain data in, plain data out.

// key × interaction pickers all share one mechanism; `facet` names the
// record facet array holding "Key|interaction" pairs.
export const PICKERS = [
  { id: 'status', facet: 'statusInteractions', title: 'Status × interaction',
    interactions: ['inflicts', 'grants', 'removes', 'prevents', 'modifies', 'steals', 'detonates', 'triggers_off', 'conditions_on', 'interacts'] },
  { id: 'stat', facet: 'statInteractions', title: 'Stat × interaction',
    interactions: ['increases', 'decreases', 'steals', 'scales_with', 'modifies', 'triggers_off', 'conditions_on'] },
  { id: 'class', facet: 'classInteractions', title: 'Class × interaction',
    interactions: ['conditions_on', 'vs', 'spells'] },
  { id: 'race', facet: 'raceInteractions', title: 'Race × interaction',
    interactions: ['conditions_on', 'vs'] },
];

// Groups evaluated against a single rule's facet bag. Everything else
// (free text, source type) is a property of the record as a whole.
const RULE_SCOPED = ['triggers', 'verbs', 'actors', 'targets'];

export function emptyQuery() {
  const pickers = {};
  for (const p of PICKERS) pickers[p.id] = { key: '', on: new Set() };
  return {
    q: '',
    types: new Set(),
    triggers: new Set(),
    verbs: new Set(),
    actors: new Set(),
    targets: new Set(),
    pickers,
    // Default ON: "start of battle AND inflicts a debuff" should mean one rule
    // does both, not that the record happens to contain each somewhere.
    sameRule: true,
    showUntagged: true,
  };
}

// --- URL round-trip -------------------------------------------------------
// Param names mirror the rule vocabulary the app renders (WHEN / DO), so a
// shared link reads as the query it encodes.
const SET_PARAMS = [
  ['src', 'types'], ['when', 'triggers'], ['do', 'verbs'],
  ['actor', 'actors'], ['target', 'targets'],
];

export function queryToHash(query) {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  for (const [param, group] of SET_PARAMS) {
    if (query[group].size) p.set(param, [...query[group]].sort().join(','));
  }
  for (const cfg of PICKERS) {
    const sel = query.pickers[cfg.id];
    if (!sel.key && !sel.on.size) continue;
    p.set(cfg.id, `${sel.key}:${[...sel.on].sort().join(',')}`);
  }
  if (!query.sameRule) p.set('same', '0'); // on is the default, so only note the opt-out
  // ',' and ':' are legal fragment characters — keep them literal so the URL
  // stays readable. Everything else keeps standard form encoding.
  return p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}

export function hashToQuery(hash) {
  const query = emptyQuery();
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  query.q = p.get('q') ?? '';
  for (const [param, group] of SET_PARAMS) {
    for (const v of (p.get(param) ?? '').split(',').filter(Boolean)) query[group].add(v);
  }
  for (const cfg of PICKERS) {
    const raw = p.get(cfg.id);
    if (raw === null) continue;
    const cut = raw.indexOf(':');
    query.pickers[cfg.id].key = cut < 0 ? raw : raw.slice(0, cut);
    for (const v of (cut < 0 ? '' : raw.slice(cut + 1)).split(',').filter(Boolean)) {
      query.pickers[cfg.id].on.add(v);
    }
  }
  if (p.get('same') === '0') query.sameRule = false;
  return query;
}

export function cloneQuery(query) {
  const pickers = {};
  for (const [id, p] of Object.entries(query.pickers)) pickers[id] = { key: p.key, on: new Set(p.on) };
  return {
    ...query,
    types: new Set(query.types), triggers: new Set(query.triggers), verbs: new Set(query.verbs),
    actors: new Set(query.actors), targets: new Set(query.targets), pickers,
  };
}

const tokens = q => q.toLowerCase().split(/\s+/).filter(Boolean);

function textMatch(rec, toks) {
  if (!toks.length) return true;
  const hay = (rec.name + ' ' + rec.text).toLowerCase();
  return toks.every(t => hay.includes(t));
}

// A picker matches when some selected interaction pairs with the chosen key —
// or, with no key chosen, pairs with ANY key ("removes any status").
function pickerMatch(pairs, sel) {
  if (!sel.on.size) return true;
  if (!pairs) return false;
  return [...sel.on].some(i =>
    sel.key ? pairs.includes(`${sel.key}|${i}`) : pairs.some(p => p.endsWith(`|${i}`))
  );
}

function anyPickerActive(query) {
  return Object.values(query.pickers).some(p => p.on.size);
}

export function anyRuleScopedFilter(query) {
  return RULE_SCOPED.some(g => query[g].size) || anyPickerActive(query);
}

// Does ONE facet bag satisfy every active rule-scoped group? The bag is either
// a record's union (cross-rule mode) or a single rule's (same-rule mode) —
// the predicate is identical, only what you feed it changes.
function satisfiesBag(f, query) {
  if (!f) return false;
  for (const g of RULE_SCOPED) {
    if (query[g].size && ![...query[g]].some(v => f[g]?.includes(v))) return false;
  }
  for (const p of PICKERS) {
    if (!pickerMatch(f[p.facet], query.pickers[p.id])) return false;
  }
  return true;
}

// Indexes of the rules that satisfy the query on their own — drives both
// same-rule matching and the "matched" marker on result cards.
export function matchingRules(rec, query) {
  const out = [];
  (rec.ruleFacets ?? []).forEach((rf, i) => { if (satisfiesBag(rf, query)) out.push(i); });
  return out;
}

function facetMatch(rec, query) {
  if (!anyRuleScopedFilter(query)) return true;
  if (query.sameRule) return matchingRules(rec, query).length > 0;
  return satisfiesBag(rec.facets, query);
}

export function runQuery(records, query) {
  const toks = tokens(query.q);
  return records.filter(rec => {
    if (query.types.size && !query.types.has(rec.type)) return false;
    if (!query.showUntagged && !rec.rules) return false;
    if (!textMatch(rec, toks)) return false;
    return facetMatch(rec, query);
  });
}

// Counts follow the standard facet convention: apply every filter EXCEPT the
// group being counted. For pickers, returns {pairs, perInteraction} where
// perInteraction counts records having ANY key with that interaction.
export function facetCounts(records, query, group) {
  const sub = cloneQuery(query);
  if (group === 'types') sub.types = new Set();
  else if (group === 'triggers') sub.triggers = new Set();
  else if (group === 'verbs') sub.verbs = new Set();
  else if (group === 'actors') sub.actors = new Set();
  else if (group === 'targets') sub.targets = new Set();
  else if (group.startsWith('picker:')) {
    const id = group.slice(7);
    sub.pickers[id] = { key: '', on: new Set() };
  }
  const pool = runQuery(records, sub);
  // In same-rule mode a count must answer "how many results if I ALSO pick
  // this?" — so only the rules that already satisfy the other filters get to
  // contribute values. Otherwise a record's unrelated second rule would
  // advertise a combination that clicking it won't actually produce.
  const scoped = sub.sameRule && anyRuleScopedFilter(sub);
  const bagsFor = rec => (scoped ? matchingRules(rec, sub).map(i => rec.ruleFacets[i]) : [rec.facets]);
  const valuesOf = (rec, key) =>
    new Set(bagsFor(rec).flatMap(f => f?.[key] ?? []));

  if (group.startsWith('picker:')) {
    const facet = PICKERS.find(p => p.id === group.slice(7)).facet;
    const pairs = new Map();
    const perInteraction = new Map();
    for (const rec of pool) {
      const seen = new Set();
      for (const pair of valuesOf(rec, facet)) {
        pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
        const i = pair.split('|')[1];
        if (!seen.has(i)) { seen.add(i); perInteraction.set(i, (perInteraction.get(i) ?? 0) + 1); }
      }
    }
    return { pairs, perInteraction };
  }
  const counts = new Map();
  for (const rec of pool) {
    if (group === 'types') counts.set(rec.type, (counts.get(rec.type) ?? 0) + 1);
    else for (const v of valuesOf(rec, group)) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}
