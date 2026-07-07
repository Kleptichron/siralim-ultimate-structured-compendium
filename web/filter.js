// Query state + predicate engine + facet counts. Plain data in, plain data out.

export function emptyQuery() {
  return {
    q: '',
    types: new Set(),
    triggers: new Set(),
    verbs: new Set(),
    status: '',          // one status name
    interactions: new Set(), // interactions paired with `status`
    showUntagged: true,
  };
}

const tokens = q => q.toLowerCase().split(/\s+/).filter(Boolean);

// Text match: every token must appear in name or text.
function textMatch(rec, toks) {
  if (!toks.length) return true;
  const hay = (rec.name + ' ' + rec.text).toLowerCase();
  return toks.every(t => hay.includes(t));
}

function facetMatch(rec, query) {
  const f = rec.facets;
  if (query.triggers.size || query.verbs.size || (query.status && query.interactions.size)) {
    if (!f) return false; // untagged records can't satisfy facet filters
  }
  if (query.triggers.size && ![...query.triggers].some(t => f.triggers?.includes(t))) return false;
  if (query.verbs.size && ![...query.verbs].some(v => f.verbs?.includes(v))) return false;
  if (query.status && query.interactions.size) {
    const ok = [...query.interactions].some(i => f.statusInteractions?.includes(`${query.status}|${i}`));
    if (!ok) return false;
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

// Facet counts use the standard convention: count what selecting this value
// would yield, i.e. apply every filter EXCEPT the group being counted.
export function facetCounts(records, query, group) {
  const sub = { ...query, types: new Set(query.types), triggers: new Set(query.triggers), verbs: new Set(query.verbs), interactions: new Set(query.interactions) };
  if (group === 'types') sub.types = new Set();
  if (group === 'triggers') sub.triggers = new Set();
  if (group === 'verbs') sub.verbs = new Set();
  if (group === 'statusInteractions') { sub.status = ''; sub.interactions = new Set(); }
  const pool = runQuery(records, sub);
  const counts = new Map();
  for (const rec of pool) {
    if (group === 'types') counts.set(rec.type, (counts.get(rec.type) ?? 0) + 1);
    else if (group === 'triggers') for (const t of rec.facets?.triggers ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    else if (group === 'verbs') for (const v of rec.facets?.verbs ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
    else if (group === 'statusInteractions') for (const si of rec.facets?.statusInteractions ?? []) counts.set(si, (counts.get(si) ?? 0) + 1);
  }
  return counts;
}
