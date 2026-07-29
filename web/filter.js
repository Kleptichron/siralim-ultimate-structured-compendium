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
  // Named "referenced by rules" to keep it apart from the Creature family
  // group: in this game family and race are the same vocabulary, so two
  // controls both labelled for it would read as duplicates. This one is about
  // rules that CHECK a race; that one is about whose effect it is.
  { id: 'race', facet: 'raceInteractions', title: 'Race referenced by rules',
    interactions: ['conditions_on', 'vs'] },
];

// Groups evaluated against a single rule's facet bag. Everything else — free
// text, source type, markers — is a property of the record as a whole.
// `markers` is deliberately absent: it is only derived at record level, so
// testing it against a single rule's bag would never match.
const RULE_SCOPED = [
  'triggers', 'verbs', 'actors', 'targets',
  'conditions', 'flows', 'scaleRefs', 'tiers', 'qualifiers',
];

// How many results a reveal step adds, and the serialization default for it.
export const PAGE = 250;

// First entry is the default. 'relevance' with no text query is identical to
// 'source', so the out-of-the-box order is unchanged until you actually search.
export const SORTS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'name', label: 'Name A–Z' },
  { id: 'source', label: 'Source' },
];

// Groups that support exclusion, i.e. every value-list group.
export const EXCLUDABLE = [
  'types', 'triggers', 'verbs', 'actors', 'targets',
  'conditions', 'flows', 'scaleRefs', 'tiers', 'qualifiers', 'markers', 'families',
];

// Properties of the whole record rather than of any one rule. `types` is
// handled separately because it lives on the record, not in its facet bag.
const RECORD_LEVEL = ['markers', 'families'];

// Groups where requiring ALL selected values is impossible by construction: a
// record has exactly one source and one family, so an AND there is always zero.
const NO_ALL_MODE = new Set(['types', 'families']);
export const canUseAllMode = group => !NO_ALL_MODE.has(group);

// Is this group currently in "match all" mode? One selected value makes ALL and
// ANY identical, so the mode only bites from two.
export const isAllMode = (query, group, size) => query.allOf.has(group) && size > 1;

export function emptyQuery() {
  const pickers = {};
  for (const p of PICKERS) pickers[p.id] = { key: '', on: new Set(), off: new Set() };
  return {
    q: '',
    // A single record, by id — the permalink form. Narrows to exactly that
    // record so a link to one effect resolves to one effect.
    recordId: '',
    types: new Set(),
    triggers: new Set(),
    verbs: new Set(),
    actors: new Set(),
    targets: new Set(),
    conditions: new Set(),
    flows: new Set(),
    scaleRefs: new Set(),
    tiers: new Set(),
    qualifiers: new Set(),
    markers: new Set(),
    families: new Set(),
    // Percentage-magnitude range; null means unbounded on that side.
    pctMin: null,
    pctMax: null,
    // Groups switched from "any of these" to "all of these". Evaluated at
    // RECORD level: an action holds one verb and a rule one trigger, so "damages
    // AND heals" can only ever be a statement about the whole effect.
    allOf: new Set(),
    // Exclusion is RECORD-scoped even in same-rule mode: "not attack" means
    // this effect never attacks, not "some rule of it happens not to". Saying
    // hide-me and still seeing the thing would be the surprising reading.
    excluded: Object.fromEntries(EXCLUDABLE.map(g => [g, new Set()])),
    pickers,
    // Default ON: "start of battle AND inflicts a debuff" should mean one rule
    // does both, not that the record happens to contain each somewhere.
    sameRule: true,
    sort: SORTS[0].id,
    // View state, not a filter: how many results have been revealed. Lives here
    // so it round-trips through the URL with everything else.
    shown: PAGE,
  };
}

// --- URL round-trip -------------------------------------------------------
// Param names mirror the rule vocabulary the app renders (WHEN / DO), so a
// shared link reads as the query it encodes.
const SET_PARAMS = [
  ['src', 'types'], ['when', 'triggers'], ['do', 'verbs'],
  ['actor', 'actors'], ['target', 'targets'],
  // 'if' mirrors the IF keyword the rule chips render.
  ['if', 'conditions'], ['flow', 'flows'], ['scales', 'scaleRefs'],
  ['tier', 'tiers'], ['qual', 'qualifiers'], ['is', 'markers'],
  ['family', 'families'],
];

// Excluded values ride in the same param with a '!' prefix, so the relationship
// stays visible: do=apply_status,!attack. No facet value starts with '!'.
const withExclusions = (inc, exc) =>
  [...[...inc].sort(), ...[...exc].sort().map(v => `!${v}`)].join(',');

export function queryToHash(query) {
  const p = new URLSearchParams();
  // A permalink stands alone: carrying the filters that happened to be set when
  // it was copied would make the same link resolve differently for someone else.
  if (query.recordId) return `id=${encodeURIComponent(query.recordId)}`;
  if (query.q) p.set('q', query.q);
  for (const [param, group] of SET_PARAMS) {
    const v = withExclusions(query[group], query.excluded[group]);
    if (v) p.set(param, v);
  }
  for (const cfg of PICKERS) {
    const sel = query.pickers[cfg.id];
    if (!sel.key && !sel.on.size && !sel.off.size) continue;
    p.set(cfg.id, `${sel.key}:${withExclusions(sel.on, sel.off)}`);
  }
  if (!query.sameRule) p.set('same', '0'); // on is the default, so only note the opt-out
  if (pctRangeActive(query)) p.set('pct', `${query.pctMin ?? ''}-${query.pctMax ?? ''}`);
  if (query.allOf.size) p.set('all', [...query.allOf].sort().join(','));
  if (query.sort !== SORTS[0].id) p.set('sort', query.sort);
  if (query.shown > PAGE) p.set('show', String(query.shown));
  // ',' ':' and '!' are all legal fragment characters — keep them literal so
  // the URL stays readable. Everything else keeps standard form encoding.
  return p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%21/g, '!');
}

export function hashToQuery(hash) {
  const query = emptyQuery();
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  const split = (raw, inc, exc) => {
    for (const v of String(raw ?? '').split(',').filter(Boolean)) {
      if (v.startsWith('!')) { if (v.length > 1) exc.add(v.slice(1)); } else inc.add(v);
    }
  };
  query.recordId = p.get('id') ?? '';
  if (query.recordId) return query; // permalink: nothing else applies
  query.q = p.get('q') ?? '';
  for (const [param, group] of SET_PARAMS) {
    split(p.get(param), query[group], query.excluded[group]);
  }
  for (const cfg of PICKERS) {
    const raw = p.get(cfg.id);
    if (raw === null) continue;
    const cut = raw.indexOf(':');
    query.pickers[cfg.id].key = cut < 0 ? raw : raw.slice(0, cut);
    split(cut < 0 ? '' : raw.slice(cut + 1), query.pickers[cfg.id].on, query.pickers[cfg.id].off);
  }
  if (p.get('same') === '0') query.sameRule = false;
  for (const g of String(p.get('all') ?? '').split(',').filter(Boolean)) {
    if (canUseAllMode(g)) query.allOf.add(g);
  }
  if (p.has('pct')) {
    const [lo, hi] = String(p.get('pct')).split('-');
    const num = s => (s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
    query.pctMin = num(lo);
    query.pctMax = num(hi);
  }
  if (SORTS.some(s => s.id === p.get('sort'))) query.sort = p.get('sort');
  // Clamp hard: a negative `show` would turn slice(0, n) into "drop the last n",
  // silently hiding results. Unparseable values fall back to the default.
  const show = Number.parseInt(p.get('show') ?? '', 10);
  query.shown = Number.isFinite(show) ? Math.max(PAGE, show) : PAGE;
  return query;
}

// How many filter values are set, for the Filters button — the count is the
// only cue that filters are active while the sidebar is collapsed or drawered.
// Counts the text query too, so this always equals the number of summary chips.
// Two visible numbers disagreeing reads as a bug, whatever the distinction.
export function activeFilterCount(query) {
  let n = (pctRangeActive(query) ? 1 : 0) + (query.q ? 1 : 0);
  for (const g of EXCLUDABLE) n += query[g].size + query.excluded[g].size;
  for (const cfg of PICKERS) {
    const sel = query.pickers[cfg.id];
    n += (sel.key ? 1 : 0) + sel.on.size + sel.off.size;
  }
  return n;
}

export function cloneQuery(query) {
  const pickers = {};
  for (const [id, p] of Object.entries(query.pickers)) {
    pickers[id] = { key: p.key, on: new Set(p.on), off: new Set(p.off) };
  }
  return {
    ...query,
    ...Object.fromEntries(EXCLUDABLE.map(g => [g, new Set(query[g])])),
    excluded: Object.fromEntries(EXCLUDABLE.map(g => [g, new Set(query.excluded[g])])),
    allOf: new Set(query.allOf),
    pickers,
  };
}

const tokens = q => q.toLowerCase().split(/\s+/).filter(Boolean);

// People look for the creature that HAS a trait far more often than the trait's
// own name — "Toxdweller", not "A Gift For You". Every identity-bearing meta
// value is a string (creature, family, class, material, specialization, relic,
// shortName, abbreviation…) while numbers and booleans are structural, so
// taking the strings picks up exactly what someone would type. This is already
// the line printed on each card; it just wasn't searchable.
const metaStrings = rec => Object.values(rec.meta ?? {}).filter(v => typeof v === 'string');

// Memoised on first use: the old code rebuilt and lowercased a haystack for all
// 4,068 records on every keystroke.
const metaHay = rec => (rec._metaHay ??= metaStrings(rec).join(' ').toLowerCase());
// The fields that NAME the thing, as opposed to describing it. Kept separate
// from metaHay because class and material must stay searchable without
// affecting rank — otherwise searching "Chaos" would bury "Chaos Bolt" among
// every Chaos-class record.
const identityHay = rec =>
  (rec._idHay ??= [rec.meta?.family, rec.meta?.creature].filter(Boolean).join(' ').toLowerCase());
const hay = rec => (rec._hay ??= `${rec.name} ${rec.text} ${metaStrings(rec).join(' ')}`.toLowerCase());

function textMatch(rec, toks) {
  if (!toks.length) return true;
  const h = hay(rec);
  return toks.every(t => h.includes(t));
}

// A picker matches when some selected interaction pairs with the chosen key —
// or, with no key chosen, pairs with ANY key ("removes any status").
function pickerMatch(pairs, sel, all = false) {
  if (!sel.on.size) return true;
  if (!pairs) return false;
  const hit = i => (sel.key ? pairs.includes(`${sel.key}|${i}`) : pairs.some(p => p.endsWith(`|${i}`)));
  return all ? [...sel.on].every(hit) : [...sel.on].some(hit);
}

function anyPickerActive(query) {
  return Object.values(query.pickers).some(p => p.on.size);
}

export function pctRangeActive(query) {
  return query.pctMin !== null || query.pctMax !== null;
}

export function anyRuleScopedFilter(query) {
  return RULE_SCOPED.some(g => query[g].size) || anyPickerActive(query) || pctRangeActive(query);
}

// Does ONE facet bag satisfy every active rule-scoped group? The bag is either
// a record's union (cross-rule mode) or a single ACTION's, carrying its rule's
// trigger and conditions (same-rule mode) — the predicate is identical, only
// what you feed it changes. Feeding it per-action bags is what makes two
// action-level filters have to land on the same action.
function satisfiesBag(f, query) {
  if (!f) return false;
  for (const g of RULE_SCOPED) {
    // "All of these" is checked once against the record in runQuery — a single
    // action can't hold two verbs, so demanding both of one bag finds nothing.
    if (isAllMode(query, g, query[g].size)) continue;
    if (query[g].size && ![...query[g]].some(v => f[g]?.includes(v))) return false;
  }
  if (pctRangeActive(query)) {
    const lo = query.pctMin ?? -Infinity;
    const hi = query.pctMax ?? Infinity;
    // Checked per action: with a verb filter active, the SAME action must carry
    // both the verb and the magnitude, not merely share a rule with it.
    const ok = (f.pcts ?? []).some(entry => {
      const bar = entry.lastIndexOf('|');
      if (query.verbs.size && !query.verbs.has(entry.slice(0, bar))) return false;
      const pct = Number(entry.slice(bar + 1));
      return pct >= lo && pct <= hi;
    });
    if (!ok) return false;
  }
  for (const p of PICKERS) {
    if (isAllMode(query, p.id, query.pickers[p.id].on.size)) continue; // record level
    if (!pickerMatch(f[p.facet], query.pickers[p.id])) return false;
  }
  return true;
}

// Indexes of the rules that satisfy the query on their own — drives both
// same-rule matching and the "matched" marker on result cards. A rule counts
// as matching when any ONE of its action bags does.
export function matchingRules(rec, query) {
  const out = new Set();
  for (const bag of rec.matchBags ?? []) if (satisfiesBag(bag, query)) out.add(bag.r);
  return [...out];
}

function facetMatch(rec, query) {
  if (!anyRuleScopedFilter(query)) return true;
  if (query.sameRule) return matchingRules(rec, query).length > 0;
  return satisfiesBag(rec.facets, query);
}

// Record-scoped by design (see emptyQuery): if ANY rule of the record carries
// an excluded value, the record is out. Evaluated against the union bag, which
// is exactly "does this effect ever do X".
function isExcluded(rec, query) {
  if (query.excluded.types.has(rec.type)) return true;
  const f = rec.facets;
  if (!f) return false;
  for (const g of EXCLUDABLE) {
    if (g === 'types') continue;
    for (const v of query.excluded[g]) if (f[g]?.includes(v)) return true;
  }
  for (const cfg of PICKERS) {
    const sel = query.pickers[cfg.id];
    const pairs = f[cfg.facet];
    if (!sel.off.size || !pairs) continue;
    for (const i of sel.off) {
      const hit = sel.key ? pairs.includes(`${sel.key}|${i}`) : pairs.some(p => p.endsWith(`|${i}`));
      if (hit) return true;
    }
  }
  return false;
}

export function runQuery(records, query) {
  if (query.recordId) return records.filter(rec => rec.id === query.recordId);
  const toks = tokens(query.q);
  return records.filter(rec => {
    if (query.types.size && !query.types.has(rec.type)) return false;
    // "All of these" groups: the whole record must carry every selected value,
    // wherever in it they occur.
    for (const g of EXCLUDABLE) {
      if (!isAllMode(query, g, query[g].size)) continue;
      if (![...query[g]].every(v => rec.facets?.[g]?.includes(v))) return false;
    }
    for (const p of PICKERS) {
      const sel = query.pickers[p.id];
      if (!isAllMode(query, p.id, sel.on.size)) continue;
      if (!pickerMatch(rec.facets?.[p.facet], sel, true)) return false;
    }
    // Record-level like types, not rule-scoped — "does not stack" and "is an
    // Uralos effect" are properties of the whole record, not of one of its rules.
    for (const g of RECORD_LEVEL) {
      if (query[g].size && ![...query[g]].some(v => rec.facets?.[g]?.includes(v))) return false;
    }
    if (!textMatch(rec, toks)) return false;
    if (isExcluded(rec, query)) return false;
    return facetMatch(rec, query);
  });
}

// Cheap, explainable ranking: a hit in the NAME beats a hit in the body text,
// and an exact/prefix name hit beats a scattered one. No corpus statistics —
// this is a lookup tool, not a search engine, and a rule you can predict beats
// a score you can't.
function relevanceRank(rec, q, toks) {
  const name = rec.name.toLowerCase();
  if (!toks.length) return 0;
  if (name === q) return 0; // an exact name hit always wins outright
  // A name hit that the record's own identity already explains is the same fact
  // restated, not a stronger signal: "Toxdweller Cards (2 collected)" contains
  // the word only because its family IS Toxdweller. Awarding it a name-tier
  // rank pushed the derived card names ahead of that family's actual creature
  // traits, which is not what someone typing a creature name is looking for.
  const isIdentity = toks.every(t => identityHay(rec).includes(t));
  if (!isIdentity) {
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    if (toks.every(t => name.includes(t))) return 3;
  }
  // Searching a creature or family should surface ITS effects above effects
  // that merely mention the word in their rules text.
  if (toks.every(t => metaHay(rec).includes(t))) return 4;
  return 5;
}

// Returns a NEW array — callers slice it for display, so it must not alias the
// filtered result.
export function sortResults(results, query) {
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (query.sort === 'name') return [...results].sort(byName);
  if (query.sort === 'source') {
    return [...results].sort((a, b) => a.type.localeCompare(b.type) || byName(a, b));
  }
  const q = query.q.trim().toLowerCase();
  const toks = tokens(query.q);
  if (!toks.length) return [...results]; // nothing to rank by: keep corpus order
  const rank = new Map(results.map(r => [r.id, relevanceRank(r, q, toks)]));
  // Index tie-break keeps the sort stable and predictable within a rank.
  const pos = new Map(results.map((r, i) => [r.id, i]));
  return [...results].sort((a, b) =>
    rank.get(a.id) - rank.get(b.id) || pos.get(a.id) - pos.get(b.id));
}

// Counts follow the standard facet convention: apply every filter EXCEPT the
// group being counted. For pickers, returns {pairs, perInteraction} where
// perInteraction counts records having ANY key with that interaction.
export function facetCounts(records, query, group) {
  const sub = cloneQuery(query);
  if (EXCLUDABLE.includes(group)) {
    sub[group] = new Set();
    sub.excluded[group] = new Set(); // clearing a group clears BOTH its states
  } else if (group.startsWith('picker:')) {
    const id = group.slice(7);
    sub.pickers[id] = { key: '', on: new Set(), off: new Set() };
  }
  const pool = runQuery(records, sub);
  // In same-rule mode a count must answer "how many results if I ALSO pick
  // this?" — so only the rules that already satisfy the other filters get to
  // contribute values. Otherwise a record's unrelated second rule would
  // advertise a combination that clicking it won't actually produce.
  const scoped = sub.sameRule && anyRuleScopedFilter(sub);
  const bagsFor = rec =>
    (scoped ? (rec.matchBags ?? []).filter(b => satisfiesBag(b, sub)) : [rec.facets]);
  const valuesOf = (rec, key) =>
    // These exist only on the record bag; reading them from rule bags would
    // count zero the moment any rule-scoped filter is active.
    RECORD_LEVEL.includes(key)
      ? new Set(rec.facets?.[key] ?? [])
      : new Set(bagsFor(rec).flatMap(f => f?.[key] ?? []));

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
