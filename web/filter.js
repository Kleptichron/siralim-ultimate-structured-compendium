// Query state + predicate engine + facet counts. Plain data in, plain data out.

// key × interaction pickers all share one mechanism; `facet` names the
// record facet array holding "Key|interaction" pairs.
export const PICKERS = [
  { id: 'status', facet: 'statusInteractions', title: 'Status × interaction',
    interactions: ['inflicts', 'grants', 'removes', 'prevents', 'modifies', 'steals', 'detonates', 'triggers_off', 'conditions_on', 'interacts'] },
  { id: 'stat', facet: 'statInteractions', title: 'Stat × interaction',
    interactions: ['increases', 'decreases', 'steals', 'scales_with', 'modifies', 'triggers_off', 'conditions_on'] },
  { id: 'class', facet: 'classInteractions', title: 'Class × interaction',
    interactions: ['conditions_on', 'vs'] },
  { id: 'race', facet: 'raceInteractions', title: 'Race × interaction',
    interactions: ['conditions_on', 'vs'] },
];

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
    showUntagged: true,
  };
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

function facetMatch(rec, query) {
  const f = rec.facets;
  if ((query.triggers.size || query.verbs.size || query.actors.size || query.targets.size
       || anyPickerActive(query)) && !f) return false;
  if (query.triggers.size && ![...query.triggers].some(t => f.triggers?.includes(t))) return false;
  if (query.verbs.size && ![...query.verbs].some(v => f.verbs?.includes(v))) return false;
  if (query.actors.size && ![...query.actors].some(a => f.actors?.includes(a))) return false;
  if (query.targets.size && ![...query.targets].some(t => f.targets?.includes(t))) return false;
  for (const p of PICKERS) {
    if (!pickerMatch(f?.[p.facet], query.pickers[p.id])) return false;
  }
  return true;
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
  if (group.startsWith('picker:')) {
    const facet = PICKERS.find(p => p.id === group.slice(7)).facet;
    const pairs = new Map();
    const perInteraction = new Map();
    for (const rec of pool) {
      const seen = new Set();
      for (const pair of rec.facets?.[facet] ?? []) {
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
    else for (const v of rec.facets?.[group] ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}
