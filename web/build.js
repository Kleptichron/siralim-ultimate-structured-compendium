// Team builder: six creatures, up to four traits each.
//
// In Siralim a creature has its innate trait, a second from fusion, a third
// from an artifact, and — only with the right nether stone — a fourth. The
// fourth is behind a checkbox because it is rare enough that most builds do not
// have it, and showing six empty slots that most people cannot fill is noise.
//
// Every slot is a plain trait pick rather than "creature, then its trait":
// players think in traits, fused traits come from other creatures anyway, and
// artifact and nether-stone traits are unconstrained. The creature each trait
// belongs to is shown alongside, so the sheet still reads as a team.

export const SLOTS = 6;
export const TRAITS_PER_CREATURE = 4;
export const SLOT_LABELS = ['Innate', 'Fusion', 'Artifact', 'Nether stone'];
// Matches SLOT_LABELS by position; the index tags each trait with the keys it
// may occupy (see traitSlots in build-index.js).
export const SLOT_KEYS = ['innate', 'fusion', 'artifact', 'nether'];

// Why a trait was refused, in the player's terms rather than the data's.
export const SLOT_REFUSAL = {
  innate: 'does not come from a creature, so it cannot be an innate trait',
  fusion: 'does not come from a creature, so it cannot be fused',
  artifact: 'has no material, so it cannot be put on an artifact',
  nether: 'cannot go in a nether stone slot', // unreachable: nether takes anything
};

// Where a warning applies, named the way the sheet labels it. A bare count
// ("1 slots") tells the reader nothing about where to look.
export const placeLabel = p => `Creature ${p.creature + 1} · ${SLOT_LABELS[p.slot]}`;

export function slotAccepts(rec, slot) {
  // Only traits go in slots at all — the stale-index fallback below must not
  // turn into "a spell fits anywhere".
  if (rec?.type !== 'traits') return false;
  // An index built before slots existed tags nothing. Accepting every trait
  // then is the right failure: a stale deploy should behave as it did before,
  // not refuse everything in the builder.
  return !rec.slots || rec.slots.includes(SLOT_KEYS[slot]);
}

export function emptyBuild() {
  return {
    // [creature][slot] = trait id, or '' for empty
    slots: Array.from({ length: SLOTS }, () => Array(TRAITS_PER_CREATURE).fill('')),
    nether: false, // does this build have the 4th (nether stone) slot?
  };
}

const slug = id => id.replace(/^trait:/, '');
const unslug = s => `trait:${s}`;

// Creatures separated by ';', that creature's traits by ','. Ids carry no
// separator characters, so nothing needs escaping. Trailing empties are
// trimmed, which keeps a two-creature build short instead of padding to 24.
export function buildToParam(build) {
  const rows = build.slots.map(row =>
    row.slice(0, build.nether ? 4 : 3).map(id => (id ? slug(id) : '')).join(','),
  );
  while (rows.length && /^,*$/.test(rows[rows.length - 1])) rows.pop();
  return rows.join(';').replace(/,+(?=;|$)/g, ''); // drop trailing empty slots
}

export function buildFromParam(param, netherFlag) {
  const build = emptyBuild();
  build.nether = netherFlag;
  String(param ?? '').split(';').forEach((row, i) => {
    if (i >= SLOTS) return;
    row.split(',').forEach((s, j) => {
      if (j >= TRAITS_PER_CREATURE || !s) return;
      build.slots[i][j] = unslug(s);
    });
  });
  return build;
}

export const buildIsEmpty = build => build.slots.every(row => row.every(id => !id));

export const buildCount = build =>
  build.slots.reduce((n, row) =>
    n + row.filter((id, s) => id && (build.nether || s !== 3)).length, 0);

// A build assembled from the search results has to outlive the page: while you
// are searching, the URL is carrying the QUERY, so there is nowhere in it to
// keep the build. Local storage holds the working copy; the URL stays the way
// you share one, and a shared link always wins over what is stored.
const STORE_KEY = 'su-compendium-build';

export function saveBuild(build) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ slots: build.slots, nether: build.nether }));
  } catch { /* private mode or full quota — the build simply won't persist */ }
}

export function loadBuild() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (!raw || !Array.isArray(raw.slots)) return null;
    const build = emptyBuild();
    build.nether = !!raw.nether;
    raw.slots.slice(0, SLOTS).forEach((row, c) => {
      if (!Array.isArray(row)) return;
      row.slice(0, TRAITS_PER_CREATURE).forEach((id, s) => {
        if (typeof id === 'string') build.slots[c][s] = id;
      });
    });
    return build;
  } catch { return null; }
}

// Non-stacking traits are the one duplication the game actively punishes: a
// second copy does nothing. Everything else may legitimately repeat.
export function buildWarnings(build, byId) {
  const seen = new Map();
  for (const [c, row] of build.slots.entries()) {
    for (const [s, id] of row.entries()) {
      if (!id || (!build.nether && s === 3)) continue;
      if (!seen.has(id)) seen.set(id, []);
      seen.get(id).push({ creature: c, slot: s });
    }
  }
  const warnings = [];
  // A shared link predates nothing and validates nothing, so a build can arrive
  // with a trait in a slot it may not occupy. Say so rather than silently
  // dropping it — the reader needs to know their link was not what they meant.
  for (const [c, row] of build.slots.entries()) {
    for (const [s, id] of row.entries()) {
      if (!id || (!build.nether && s === 3)) continue;
      const rec = byId.get(id);
      if (!rec || slotAccepts(rec, s)) continue;
      warnings.push({
        id,
        name: rec.name,
        places: [{ creature: c, slot: s }],
        severity: 'invalid',
        note: SLOT_REFUSAL[SLOT_KEYS[s]],
      });
    }
  }
  for (const [id, places] of seen) {
    if (places.length < 2) continue;
    const rec = byId.get(id);
    if (!rec) continue;
    const noStack = (rec.facets?.markers ?? []).includes('noStack');
    warnings.push({
      id,
      name: rec.name,
      places,
      severity: noStack ? 'wasted' : 'duplicate',
      note: noStack
        ? 'does not stack — the extra copies do nothing'
        : 'appears more than once',
    });
  }
  return warnings;
}

// What the whole team does, from the facets already derived per trait. Answers
// "is anything actually inflicting Burning for my Burning payoff to use".
export function buildSummary(build, byId) {
  const chosen = build.slots
    .flatMap(row => row.filter((id, s) => id && (build.nether || s !== 3)))
    .map(id => byId.get(id))
    .filter(Boolean);
  const tally = key => {
    const counts = new Map();
    for (const rec of chosen) {
      for (const v of rec.facets?.[key] ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const statuses = tally('statusInteractions')
    .filter(([pair]) => pair.endsWith('|inflicts') || pair.endsWith('|grants'))
    .map(([pair, n]) => [pair.split('|')[0], n])
    .filter(([name]) => name !== '*');
  return {
    count: chosen.length,
    triggers: tally('triggers'),
    statuses,
    noStack: chosen.filter(r => (r.facets?.markers ?? []).includes('noStack')).length,
  };
}
