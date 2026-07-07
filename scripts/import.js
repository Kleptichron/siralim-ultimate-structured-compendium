// CSV -> data/normalized/*.json + generated lexicons + manifest drift detection.
// Run from repo root: npm run import
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readCSV } from './lib/csv.js';
import { slug, textHash, normText } from './lib/ids.js';

const yes = v => /^yes$/i.test((v ?? '').trim());
const int = v => {
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

function rec(id, source, name, text, meta = {}) {
  return { id, source, name, text: normText(text), textHash: textHash(text), meta };
}

const out = {}; // sourceKey -> records
const push = r => (out[r.source] ??= []).push(r);

// --- traits ---
for (const r of readCSV('source/traits.csv')) {
  push(rec(`trait:${slug(r['Trait Name'])}`, 'traits', r['Trait Name'], r['Trait Description'], {
    class: r['Class'], family: r['Family'], creature: r['Creature'], material: r['Material Name'],
  }));
}

// --- spells (a few names repeat across classes, e.g. Colorwave x5 — qualify those) ---
{
  const rows = readCSV('source/spells.csv');
  const nameCount = {};
  for (const r of rows) nameCount[r['Spell Name']] = (nameCount[r['Spell Name']] ?? 0) + 1;
  for (const r of rows) {
    const dup = nameCount[r['Spell Name']] > 1;
    const id = `spell:${slug(r['Spell Name'])}${dup ? `-${slug(r['Class'])}` : ''}`;
    push(rec(id, 'spells', dup ? `${r['Spell Name']} (${r['Class']})` : r['Spell Name'], r['Spell Description'], {
      class: r['Class'], charges: int(r['Charges']),
    }));
  }
}

// --- perks ---
for (const r of readCSV('source/perks.csv')) {
  push(rec(`perk:${slug(r.specialization)}:${slug(r.name)}`, 'perks', r.name, r.description, {
    specialization: r.specialization,
    ranks: int(r.ranks),
    costPerRank: int(r.cost_per_rank),
    anointment: yes(r.anointment),
    ascension: yes(r.ascension),
  }));
}

// --- relics (31 relics x 10 cumulative rank unlocks) ---
for (const r of readCSV('source/relics.csv')) {
  const full = r['Relic'];
  const short = full.split(',')[0].trim();
  const rank = int(r['Rank']);
  push(rec(`relic:${slug(short)}:r${rank}`, 'relics', `${short} (Rank ${rank})`, r['Relic Description'], {
    relic: full, shortName: short, statBonus: r['Stat Bonus'], rank,
  }));
}

// --- cards (3 unlock effects per family) ---
for (const r of readCSV('source/cards.csv')) {
  const tiers = r['Tiers'].split('/').map(s => int(s));
  const effects = [r['First Unlock Effect'], r['Second Unlock Effect'], r['Third Unlock Effect']];
  effects.forEach((text, i) => {
    if (!text) return;
    push(rec(`card:${slug(r['Family'])}:${i + 1}`, 'cards',
      `${r['Family']} Cards (${tiers[i] ?? '?'} collected)`, text, {
        family: r['Family'], unlock: i + 1, tierRequired: tiers[i],
      }));
  });
}

// --- buffs / debuffs ---
for (const kind of ['buff', 'debuff']) {
  for (const r of readCSV(`source/${kind}s.csv`)) {
    push(rec(`${kind}:${slug(r['Name'])}`, `${kind}s`, r['Name'], r['Effect'], {
      kind, defaultDuration: r['Default Duration'],
    }));
  }
}

// --- minions ---
for (const r of readCSV('source/minions.csv')) {
  push(rec(`minion:${slug(r['Name'])}`, 'minions', r['Name'], r['Effect'], {
    chanceToLeave: r['Chance to leave'],
  }));
}

// --- nemesis modifiers ---
for (const r of readCSV('source/nemesis_modifiers.csv')) {
  push(rec(`nemesis:${slug(r['Modifier'])}`, 'nemesis', r['Modifier'], r['Description'], {}));
}

// --- realm properties (39 rows have a self-descriptive name and no text) ---
for (const r of readCSV('source/realm_properties.csv')) {
  const noText = !r['Description'].trim();
  push(rec(`realm:${slug(r['Target'])}:${slug(r['Modifier'])}`, 'realm', r['Modifier'], r['Description'], {
    target: r['Target'], hidden: yes(r['Hidden?']), ...(noText && { noText: true }),
  }));
}

// --- specializations (lore only; indexed for full-text, never rule-tagged) ---
for (const r of readCSV('source/specializations.csv')) {
  push(rec(`spec:${slug(r.name)}`, 'specs', r.name, r.description, {
    abbreviation: r.abbreviation, loreOnly: true,
  }));
}

// --- global ID uniqueness ---
const seen = new Map(); // id -> record
let collisions = 0;
for (const rs of Object.values(out)) {
  for (const r of rs) {
    if (seen.has(r.id)) {
      console.error(`ID COLLISION: ${r.id}\n  a: ${seen.get(r.id).name}\n  b: ${r.name}`);
      collisions++;
    } else seen.set(r.id, r);
  }
}
if (collisions) {
  console.error(`\n${collisions} ID collision(s) — fix the slug scheme before proceeding.`);
  process.exit(1);
}

// --- write normalized files ---
for (const [key, rs] of Object.entries(out)) {
  rs.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(`data/normalized/${key}.json`, JSON.stringify(rs, null, 2) + '\n');
}

// --- generated lexicons (statuses from buffs/debuffs + curated extras, families from traits) ---
const extraStatuses = JSON.parse(readFileSync('data/lexicon/extra-statuses.json', 'utf8'));
const statuses = [
  ...[...out.buffs, ...out.debuffs]
    .map(r => ({ name: r.name, kind: r.meta.kind, defaultDuration: r.meta.defaultDuration })),
  ...extraStatuses.map(s => ({ ...s, extra: true })),
].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('data/lexicon/statuses.json', JSON.stringify(statuses, null, 2) + '\n');

const families = [...new Set(out.traits.map(r => r.meta.family).filter(Boolean))].sort();
writeFileSync('data/lexicon/families.json', JSON.stringify(families, null, 2) + '\n');

// --- manifest: status lifecycle + drift detection ---
// statuses: todo (needs tagging) | machine | tagged | stale (text changed under
// an existing annotation — needs re-review)
const manifestPath = 'data/manifest.json';
const old = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8')).records ?? {}
  : {};
const records = {};
let fresh = 0, kept = 0, staled = 0;
for (const id of [...seen.keys()].sort()) {
  const hash = seen.get(id).textHash;
  const prior = old[id];
  if (!prior) { records[id] = { hash, status: 'todo' }; fresh++; }
  else if (prior.hash !== hash) {
    const wasAnnotated = prior.status === 'tagged' || prior.status === 'machine';
    records[id] = { hash, status: wasAnnotated ? 'stale' : 'todo', ...(prior.provenance && { provenance: prior.provenance }) };
    staled += wasAnnotated ? 1 : 0;
  } else { records[id] = prior; kept++; }
}
const removed = Object.keys(old).filter(id => !seen.has(id));
if (removed.length) console.warn(`removed from source (${removed.length}): ${removed.slice(0, 10).join(', ')}${removed.length > 10 ? '…' : ''}`);
writeFileSync(manifestPath, JSON.stringify({ records }, null, 2) + '\n');

// --- report ---
for (const [key, rs] of Object.entries(out)) console.log(`${key.padEnd(8)} ${String(rs.length).padStart(5)} records`);
console.log(`total    ${String(seen.size).padStart(5)} records`);
console.log(`manifest: ${fresh} new, ${kept} unchanged, ${staled} stale${removed.length ? `, ${removed.length} removed` : ''}`);
console.log(`lexicons: ${statuses.length} statuses, ${families.length} families`);
