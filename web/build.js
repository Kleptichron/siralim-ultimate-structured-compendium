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
