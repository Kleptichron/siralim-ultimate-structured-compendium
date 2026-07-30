// source/game/*.json (the game's own strings, vendored by extract-game-data.js)
// + source/*.csv (community metadata the game's text does not carry)
//   -> data/normalized/*.json + generated lexicons + manifest drift detection.
// Run from repo root: npm run import
//
// Authority split. The game's localization tables are authoritative for every
// record's NAME and EFFECT TEXT, and supply the semantic markup that becomes
// each record's `refs`. They do not encode relationships — which creature a
// trait comes from, which specialization a perk belongs to, a spell's charge
// cost — because that lives in compiled code, not in the string tables. So the
// community CSVs remain authoritative for metadata, joined to the game rows by
// name. Where only one side has a row, that is reported rather than dropped.
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { readCSV } from './lib/csv.js';
import { slug, textHash, normText, idToPath } from './lib/ids.js';
import {
  resolveMarkup, extractRefs, markupEquivalent, hasRuntimeValue, SEMANTIC_BRACKETS,
} from './lib/markup.js';

const yes = v => /^yes$/i.test((v ?? '').trim());
const int = v => {
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const nameKey = s => normText(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// --dry-run reports the drift a re-import would cause without touching anything,
// which is how you check a game update before it rewrites annotations.
const DRY_RUN = process.argv.includes('--dry-run');
const write = (path, data) => { if (!DRY_RUN) writeFileSync(path, data); };

const gameFile = name => JSON.parse(readFileSync(`source/game/${name}.json`, 'utf8'));
const TOKENS = gameFile('tokens');

const out = {}; // sourceKey -> records
const push = r => (out[r.source] ??= []).push(r);
const notes = [];

// A record built from a game row: refs always come from the game's markup;
// display text normally does too.
//
// The exception is a string the game only finishes at display time. Perk text is
// a template — "<5>% of your creatures' chance to dodge attacks is applied to
// spells" — where <5> is the value PER RANK and the game multiplies it by the
// ranks bought. A static compendium cannot render that, and the community
// transcription already spells it out ("5% ... per rank ... Maximum Bonus:
// 100%"). So where the game ships a template and a transcription exists, the
// transcription is the better display text; the markup is still the authority
// for refs. `transcript` is that text, or null.
let templateTextKept = 0;
function gameRec(id, source, name, markup, meta = {}, transcript = null) {
  const useTranscript = transcript && hasRuntimeValue(markup);
  if (useTranscript) templateTextKept++;
  const text = useTranscript ? normText(transcript) : resolveMarkup(markup, TOKENS);
  const refs = extractRefs(markup, TOKENS, SEMANTIC_BRACKETS);
  return {
    id, source, name: normText(name), text, textHash: textHash(text),
    meta: { ...meta, ...(hasRuntimeValue(markup) && { perRankValues: true }) },
    markup, ...(Object.keys(refs).length && { refs }),
  };
}
// A record with no game counterpart (community-only sources).
function rec(id, source, name, text, meta = {}) {
  return { id, source, name: normText(name), text: normText(text), textHash: textHash(text), meta };
}

// Joins community rows onto game rows by name. Leftover community rows are
// matched a second time by text, which recovers rows whose transcribed name is
// misspelled ("Iceicle Rain" for the game's "Icicle Rain").
function joinByName(gameRows, communityRows, communityName) {
  const pool = new Map(); // nameKey -> [game rows]
  for (const g of gameRows) {
    const k = nameKey(g.name);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(g);
  }
  const pairs = new Map(); // game row -> community row
  const unmatchedCommunity = [];
  for (const c of communityRows) {
    const cands = (pool.get(nameKey(communityName(c))) ?? []).filter(g => !pairs.has(g));
    if (!cands.length) { unmatchedCommunity.push(c); continue; }
    // Several game rows can share a display name (boss traits come in tiers);
    // prefer the one whose text the community row actually transcribes.
    pairs.set(cands.find(g => markupEquivalent(g.markup, c.__text)) ?? cands[0], c);
  }
  for (const c of [...unmatchedCommunity]) {
    const hit = gameRows.find(g => !pairs.has(g) && g.markup && markupEquivalent(g.markup, c.__text));
    if (hit) {
      pairs.set(hit, c);
      unmatchedCommunity.splice(unmatchedCommunity.indexOf(c), 1);
      notes.push(`renamed: "${communityName(c)}" -> "${hit.name}" (matched on text)`);
    }
  }
  // Last pass: a name the game has since corrected by a character or two, where
  // the text has also been reworded so the text match cannot see it ("Red-eye
  // Flight" -> "Red-eye Fight"). Only a unique close match on a name long enough
  // for the distance to mean something counts, and it only carries METADATA
  // across — the game's text still wins, and the record still reads as changed.
  for (const c of [...unmatchedCommunity]) {
    const ck = nameKey(communityName(c));
    if (ck.length < 8) continue;
    const close = gameRows.filter(g => !pairs.has(g) && editDistanceWithin(ck, nameKey(g.name), 2));
    if (close.length !== 1) continue;
    pairs.set(close[0], c);
    unmatchedCommunity.splice(unmatchedCommunity.indexOf(c), 1);
    notes.push(`renamed: "${communityName(c)}" -> "${close[0].name}" (matched on near-identical name)`);
  }
  return { pairs, unmatchedCommunity };
}

// Levenshtein distance, bailing out as soon as it exceeds `max`.
function editDistanceWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, row[j]);
    }
    if (best > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

// --- traits -----------------------------------------------------------------
// The game ships every trait, including the enemy-only boss and False God ones
// the community sheet never covered. Those carry no class/family/creature and
// cannot occupy a build slot, so they land in their own source instead of
// diluting the trait facets.
{
  const gameTraits = gameFile('traits').filter(t => t.markup);
  const rows = readCSV('source/traits.csv').map(r => ({ ...r, __text: r['Trait Description'] }));
  const { pairs, unmatchedCommunity } = joinByName(gameTraits, rows, r => r['Trait Name']);

  const enemyOnly = gameTraits.filter(g => !pairs.has(g));
  const dupNames = new Map();
  for (const g of enemyOnly) dupNames.set(nameKey(g.name), (dupNames.get(nameKey(g.name)) ?? 0) + 1);
  const seenName = new Map();

  for (const g of gameTraits) {
    const c = pairs.get(g);
    if (c) {
      push(gameRec(`trait:${slug(g.name)}`, 'traits', g.name, g.markup, {
        class: c['Class'], family: c['Family'], creature: c['Creature'], material: c['Material Name'],
      }));
    } else {
      // Tiered variants share a display name; the id and the label both take the
      // variant number so two rows are never indistinguishable in a result list.
      const k = nameKey(g.name);
      const n = (seenName.get(k) ?? 0) + 1;
      seenName.set(k, n);
      const multi = dupNames.get(k) > 1;
      push(gameRec(
        `etrait:${slug(g.name)}${multi ? `-${n}` : ''}`, 'enemy-traits',
        multi ? `${g.name} (${n})` : g.name, g.markup,
        { enemyOnly: true, gameKey: g.key, ...(multi && { variant: n }) },
      ));
    }
  }
  for (const c of unmatchedCommunity) {
    // Keep it rather than silently dropping an annotated record, but say so.
    push(rec(`trait:${slug(c['Trait Name'])}`, 'traits', c['Trait Name'], c['Trait Description'], {
      class: c['Class'], family: c['Family'], creature: c['Creature'], material: c['Material Name'],
      notInGameData: true,
    }));
    notes.push(`trait "${c['Trait Name']}" is in source/traits.csv but not in the game's strings — kept, flagged notInGameData`);
  }
}

// --- spells (a few names repeat across classes, e.g. Colorwave x5) -----------
{
  const gameSpells = gameFile('spells').filter(s => s.markup);
  const rows = readCSV('source/spells.csv').map(r => ({ ...r, __text: r['Spell Description'] }));
  const { pairs, unmatchedCommunity } = joinByName(gameSpells, rows, r => r['Spell Name']);
  const count = {};
  for (const g of gameSpells) count[nameKey(g.name)] = (count[nameKey(g.name)] ?? 0) + 1;
  for (const g of gameSpells) {
    const c = pairs.get(g);
    const cls = c?.['Class'] ?? null;
    const dup = count[nameKey(g.name)] > 1;
    // Duplicate names are only separable by class, which only the community rows
    // carry; without one, fall back to the game's own key.
    const qualifier = dup ? (cls ? slug(cls) : slug(g.key)) : '';
    push(gameRec(`spell:${slug(g.name)}${qualifier ? `-${qualifier}` : ''}`, 'spells',
      dup && cls ? `${g.name} (${cls})` : g.name, g.markup,
      { class: cls, charges: c ? int(c['Charges']) : null, ...(c ? {} : { metadataMissing: true }) }));
  }
  for (const c of unmatchedCommunity) {
    notes.push(`spell "${c['Spell Name']}" is in source/spells.csv but not in the game's strings — dropped`);
  }
}

// --- perks ------------------------------------------------------------------
// The game's perk strings carry no specialization; that grouping exists only in
// the community sheet, so perks it does not cover are marked unassigned.
{
  const gamePerks = gameFile('perks').filter(p => p.markup);
  const rows = readCSV('source/perks.csv').map(r => ({ ...r, __text: r.description }));
  const { pairs, unmatchedCommunity } = joinByName(gamePerks, rows, r => r.name);
  for (const g of gamePerks) {
    const c = pairs.get(g);
    push(gameRec(`perk:${c ? slug(c.specialization) : 'unassigned'}:${slug(g.name)}`, 'perks', g.name, g.markup, {
      specialization: c?.specialization ?? null,
      ranks: c ? int(c.ranks) : null,
      costPerRank: c ? int(c.cost_per_rank) : null,
      anointment: c ? yes(c.anointment) : null,
      ascension: c ? yes(c.ascension) : null,
      ...(c ? {} : { specializationUnknown: true }),
    }, c?.description ?? null));
  }
  for (const c of unmatchedCommunity) {
    notes.push(`perk "${c.name}" (${c.specialization}) is in source/perks.csv but not in the game's strings — dropped`);
  }
}

// --- relics (31 relics x 10 cumulative unlocks) -----------------------------
// The two sources count differently: the game tags its unlocks 1..10, while the
// sheet records the relic LEVEL each one unlocks at (10, 20, ... 100). The level
// is the number the game shows a player, so it stays the record's rank; the
// game's index is kept alongside it as `unlock`.
{
  const gameRelics = gameFile('relics').filter(r => r.markup);
  const levels = new Map(); // relic|unlock index -> community row
  {
    const byRelic = new Map();
    for (const r of readCSV('source/relics.csv')) {
      const k = nameKey(r['Relic'].split(',')[0]);
      if (!byRelic.has(k)) byRelic.set(k, []);
      byRelic.get(k).push(r);
    }
    for (const [k, rows] of byRelic) {
      rows.sort((a, b) => int(a['Rank']) - int(b['Rank']));
      rows.forEach((r, i) => levels.set(`${k}|${i + 1}`, r));
    }
  }
  for (const g of gameRelics) {
    const c = levels.get(`${nameKey(g.relicName)}|${g.rank}`);
    const rank = c ? int(c['Rank']) : g.rank * 10;
    push(gameRec(`relic:${slug(g.relicName)}:r${rank}`, 'relics', `${g.relicName} (Rank ${rank})`, g.markup, {
      relic: g.relicTitle, shortName: g.relicName, god: g.god, rank, unlock: g.rank,
      statBonus: c?.['Stat Bonus'] ?? null, ...(c ? {} : { metadataMissing: true }),
    }));
  }
}

// --- cards (3 unlock effects per family) ------------------------------------
{
  const tierRequired = new Map(); // family|unlock -> cards collected
  for (const r of readCSV('source/cards.csv')) {
    const tiers = r['Tiers'].split('/').map(int);
    tiers.forEach((n, i) => tierRequired.set(`${nameKey(r['Family'])}|${i + 1}`, n));
  }
  for (const g of gameFile('cards')) {
    if (!g.markup) continue;
    const req = tierRequired.get(`${nameKey(g.family)}|${g.tier}`) ?? null;
    push(gameRec(`card:${slug(g.family)}:${g.tier}`, 'cards',
      req == null ? `${g.family} Cards (unlock ${g.tier})` : `${g.family} Cards (${req} collected)`,
      g.markup, { family: g.family, unlock: g.tier, tierRequired: req }));
  }
}

// --- buffs / debuffs / minions ----------------------------------------------
// One game table covers all three; the community sheets add default durations
// and a minion's chance to leave.
{
  const durations = new Map();
  for (const kind of ['buff', 'debuff']) {
    for (const r of readCSV(`source/${kind}s.csv`)) durations.set(nameKey(r['Name']), r['Default Duration']);
  }
  const leaveChance = new Map();
  for (const r of readCSV('source/minions.csv')) leaveChance.set(nameKey(r['Name']), r['Chance to leave']);

  for (const s of gameFile('statuses')) {
    const k = nameKey(s.name);
    const source = s.kind === 'minion' ? 'minions' : `${s.kind}s`;
    push(gameRec(`${s.kind}:${slug(s.name)}`, source, s.name, s.markup, s.kind === 'minion'
      ? { chanceToLeave: leaveChance.get(k) ?? null }
      : { kind: s.kind, defaultDuration: durations.get(k) ?? '' }));
  }
}

// --- nemesis modifiers (community only) -------------------------------------
for (const r of readCSV('source/nemesis_modifiers.csv')) {
  push(rec(`nemesis:${slug(r['Modifier'])}`, 'nemesis', r['Modifier'], r['Description'], {}));
}

// --- realm properties -------------------------------------------------------
// Left community-sourced: the sheet splits each property into its enemy-facing
// and ally-facing forms (77 rows against the game's 58 generic descriptions),
// which is the finer and more useful cut. 39 rows are self-descriptive and have
// no text of their own.
for (const r of readCSV('source/realm_properties.csv')) {
  const noText = !r['Description'].trim();
  push(rec(`realm:${slug(r['Target'])}:${slug(r['Modifier'])}`, 'realm', r['Modifier'], r['Description'], {
    target: r['Target'], hidden: yes(r['Hidden?']), ...(noText && { noText: true }),
  }));
}

// --- specializations (lore only; indexed for full-text, never rule-tagged) --
{
  const abbrev = new Map();
  for (const r of readCSV('source/specializations.csv')) abbrev.set(nameKey(r.name), r.abbreviation);
  // A specialization's blurb is two shipped strings: the flavour description and
  // the "As a Monk, you'll..." playstyle paragraph. They are one body of text
  // wherever the game shows them, and the sheet transcribed them joined, so they
  // are joined here too.
  for (const s of gameFile('specs')) {
    if (!s.name) continue;
    push(gameRec(`spec:${slug(s.name)}`, 'specs', s.name,
      [s.markup, s.playstyle].filter(Boolean).join(' '), {
        abbreviation: abbrev.get(nameKey(s.name)) ?? null, loreOnly: true,
      }));
  }
}

// --- artifact modifiers (new source) ---------------------------------------
// 45 of the 64 are stat pairs whose name is the whole effect ("Health & Attack")
// and ship no separate sentence; they are kept with noText so the rule model
// reads the name, exactly as self-descriptive realm properties do.
for (const a of gameFile('artifact-mods')) {
  const r = gameRec(`artmod:${slug(a.name)}`, 'artifact-mods', a.name, a.markup, {
    ...(a.markup ? {} : { noText: true }),
  });
  push(r);
}

// --- spell gem properties (new source) -------------------------------------
for (const p of gameFile('spell-gem-props')) {
  push(gameRec(`spellmod:${slug(p.name)}`, 'spell-gem-props', p.name, p.markup, {}));
}

// --- god blessings (new source) --------------------------------------------
for (const b of gameFile('blessings')) {
  if (!b.markup) continue;
  push(gameRec(`blessing:${slug(b.patron)}:${b.tier}`, 'blessings',
    `${b.patron} Blessing ${b.tier}`, b.markup, { patron: b.patron, tier: b.tier }));
}

// --- global ID uniqueness ---------------------------------------------------
const seen = new Map();
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

// --- prior state, for drift reconciliation ---------------------------------
const SOURCES = [...new Set(Object.keys(out))];
const prior = new Map();
for (const src of SOURCES) {
  const f = `data/normalized/${src}.json`;
  if (!existsSync(f)) continue;
  for (const r of JSON.parse(readFileSync(f, 'utf8'))) prior.set(r.id, r);
}
// Sources that existed before but produced nothing this run would otherwise be
// invisible; load them so their records are reported as removed.
for (const src of ['traits', 'spells', 'perks', 'relics', 'cards', 'buffs', 'debuffs',
  'minions', 'nemesis', 'realm', 'specs']) {
  const f = `data/normalized/${src}.json`;
  if (SOURCES.includes(src) || !existsSync(f)) continue;
  for (const r of JSON.parse(readFileSync(f, 'utf8'))) prior.set(r.id, r);
}

// --- write normalized files ------------------------------------------------
if (!DRY_RUN) mkdirSync('data/normalized', { recursive: true });
for (const [key, rs] of Object.entries(out)) {
  rs.sort((a, b) => a.id.localeCompare(b.id));
  write(`data/normalized/${key}.json`, JSON.stringify(rs, null, 2) + '\n');
}

// --- generated lexicons ----------------------------------------------------
// statuses now come from the game's own status table, which names each one's
// kind explicitly (the CONDNAME_BUFF_/DEBUFF_/MINION_ namespaces) instead of
// inferring it from which CSV the row sat in.
const extraStatuses = JSON.parse(readFileSync('data/lexicon/extra-statuses.json', 'utf8'));
const gameStatuses = gameFile('statuses');
const durationOf = new Map(
  [...(out.buffs ?? []), ...(out.debuffs ?? [])].map(r => [r.name, r.meta.defaultDuration ?? '']),
);
const statuses = [
  // Minions are battle entities, not statuses that get applied; the rule model
  // reaches them through summon_minion, so only buffs and debuffs go in here.
  ...gameStatuses.filter(s => s.kind !== 'minion').map(s => ({
    name: s.name, kind: s.kind, defaultDuration: durationOf.get(s.name) ?? '', token: s.token,
  })),
  ...extraStatuses
    .filter(s => !gameStatuses.some(g => g.name === s.name))
    .map(s => ({ ...s, extra: true })),
].sort((a, b) => a.name.localeCompare(b.name));
write('data/lexicon/statuses.json', JSON.stringify(statuses, null, 2) + '\n');

// families: the game's full roster, not just the families that happen to appear
// in the trait sheet's Family column.
const families = gameFile('families');
write('data/lexicon/families.json', JSON.stringify(families, null, 2) + '\n');

// The markup map doubles as a lexicon: every status, family, class and stat the
// game's own strings can refer to. validate.js checks refs against it.
write('data/lexicon/game-tokens.json', JSON.stringify(TOKENS, null, 2) + '\n');

// --- annotation reconciliation ---------------------------------------------
// Canonical game text differs from the community transcriptions in wording the
// markup fully accounts for (typing, capitalisation, typographic apostrophes).
// Those changes do not invalidate an annotation, so the annotation's textHash is
// refreshed in place instead of the record being flagged stale. Anything the
// markup does NOT account for is a real change and stays stale.
let rehashed = 0, renamed = 0;
const staleReal = new Set();
const renamedFrom = new Map(); // new id -> old id

function loadAnnotation(id) {
  const { dir, file } = idToPath(id);
  const path = `data/annotations/${dir}/${file}`;
  return existsSync(path) ? { path, ann: JSON.parse(readFileSync(path, 'utf8')) } : null;
}

const rehash = []; // ids whose text changed only in ways the markup accounts for
const arrivals = []; // ids with no prior record — possible renames
for (const [id, r] of seen) {
  const p = prior.get(id);
  if (p && p.textHash === r.textHash) continue;
  if (!p) { arrivals.push([id, r]); continue; }
  if (r.markup && markupEquivalent(r.markup, p.text)) rehash.push([id, r]);
  else staleReal.add(id);
}

// Rename detection has to be conservative: with 1,200 arriving records and
// plenty of near-identical effect texts, "some vanished record matches this one"
// finds spurious pairs. A pair only counts when the match is mutually
// exclusive — exactly one arrival for that departure and vice versa.
{
  const departures = [...prior].filter(([id]) => !seen.has(id));
  const byArrival = new Map(); // arrival id -> [departure ids]
  const byDeparture = new Map();
  for (const [id, r] of arrivals) {
    if (!r.markup) continue;
    for (const [oldId, o] of departures) {
      if (o.source !== r.source || !markupEquivalent(r.markup, o.text)) continue;
      if (!byArrival.has(id)) byArrival.set(id, []);
      if (!byDeparture.has(oldId)) byDeparture.set(oldId, []);
      byArrival.get(id).push(oldId);
      byDeparture.get(oldId).push(id);
    }
  }
  // Sets of records sharing one effect text (a card family's three tiers all say
  // the same thing) match each other n-to-n, so uniqueness alone rejects them.
  // The id structure breaks the tie: card:satyr:2 pairs with card:saytr:2 because
  // only the family segment changed.
  const tail = id => id.slice(id.lastIndexOf(':') + 1);
  for (const [id, olds] of byArrival) {
    const cands = olds.length === 1 ? olds : olds.filter(o => tail(o) === tail(id));
    if (cands.length !== 1) continue;
    const oldId = cands[0];
    const back = byDeparture.get(oldId);
    if (back.length !== 1 && back.filter(a => tail(a) === tail(oldId)).length !== 1) continue;
    renamedFrom.set(id, oldId);
  }
  // A record whose name the game corrected AND whose text it reworded is invisible
  // to the text match, but its id still says what it was: same source, same id
  // namespace, tail off by a character or two ("perk:reaver:red-eye-flight" ->
  // ":red-eye-fight"). The annotation belongs to the renamed record, but since the
  // text really did change it is queued for re-review rather than carried clean.
  {
    const taken = new Set(renamedFrom.values());
    const left = departures.filter(([id]) => !taken.has(id));
    for (const [id, r] of arrivals) {
      if (renamedFrom.has(id)) continue;
      const ns = id.slice(0, id.lastIndexOf(':') + 1);
      const cands = left.filter(([o, rec]) =>
        rec.source === r.source && o.startsWith(ns) && editDistanceWithin(tail(o), tail(id), 2));
      if (cands.length !== 1) continue;
      renamedFrom.set(id, cands[0][0]);
      staleReal.add(id);
      taken.add(cands[0][0]);
    }
  }
}

if (!DRY_RUN) {
  for (const [id, r] of rehash) {
    // Same sentence, better typed. Keep the annotation, refresh its hash.
    const a = loadAnnotation(id);
    if (!a) continue;
    a.ann.textHash = r.textHash;
    writeFileSync(a.path, JSON.stringify(a.ann, null, 2) + '\n');
    rehashed++;
  }
  for (const [id, oldId] of renamedFrom) {
    const oldAnn = loadAnnotation(oldId);
    if (!oldAnn) continue;
    const { dir, file } = idToPath(id);
    mkdirSync(`data/annotations/${dir}`, { recursive: true });
    oldAnn.ann.id = id;
    oldAnn.ann.textHash = seen.get(id).textHash;
    writeFileSync(oldAnn.path, JSON.stringify(oldAnn.ann, null, 2) + '\n');
    renameSync(oldAnn.path, `data/annotations/${dir}/${file}`);
    renamed++;
    notes.push(`annotation moved: ${oldId} -> ${id}`);
  }
  // A meta-record points at the siblings it amplifies by id, so a rename has to
  // be followed through those references or they dangle.
  if (renamedFrom.size) {
    const byOld = new Map([...renamedFrom].map(([n, o]) => [o, n]));
    for (const dir of readdirSync('data/annotations')) {
      for (const f of readdirSync(`data/annotations/${dir}`)) {
        if (!f.endsWith('.json')) continue;
        const p = `data/annotations/${dir}/${f}`;
        const ann = JSON.parse(readFileSync(p, 'utf8'));
        if (!ann.amplifies?.some(a => byOld.has(a))) continue;
        ann.amplifies = ann.amplifies.map(a => byOld.get(a) ?? a);
        writeFileSync(p, JSON.stringify(ann, null, 2) + '\n');
        notes.push(`updated amplifies references in ${ann.id}`);
      }
    }
  }
} else {
  rehashed = rehash.filter(([id]) => loadAnnotation(id)).length;
  renamed = [...renamedFrom].filter(([, oldId]) => loadAnnotation(oldId)).length;
  for (const [id, oldId] of renamedFrom) notes.push(`would move annotation: ${oldId} -> ${id}`);
}

// --- manifest: status lifecycle + drift detection --------------------------
// statuses: todo (needs tagging) | machine | tagged | stale (text changed under
// an existing annotation — needs re-review)
const manifestPath = 'data/manifest.json';
const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).records ?? {} : {};
const records = {};
let fresh = 0, kept = 0, staled = 0;
const renamedOldIds = new Set(renamedFrom.values());
for (const id of [...seen.keys()].sort()) {
  const hash = seen.get(id).textHash;
  const priorEntry = old[id] ?? old[renamedFrom.get(id)];
  if (!priorEntry) { records[id] = { hash, status: 'todo' }; fresh++; continue; }
  if (!staleReal.has(id)) {
    // Unchanged, re-hashed in place, or carried across a rename: the annotation
    // still describes this text, so its lifecycle status survives.
    records[id] = { ...priorEntry, hash };
    kept++;
    continue;
  }
  const wasAnnotated = priorEntry.status === 'tagged' || priorEntry.status === 'machine';
  records[id] = { hash, status: wasAnnotated ? 'stale' : 'todo', ...(priorEntry.provenance && { provenance: priorEntry.provenance }) };
  staled += wasAnnotated ? 1 : 0;
}
const removed = Object.keys(old).filter(id => !seen.has(id) && !renamedOldIds.has(id));
write(manifestPath, JSON.stringify({ records }, null, 2) + '\n');

// --- report ----------------------------------------------------------------
for (const [key, rs] of Object.entries(out).sort()) {
  const before = [...prior.values()].filter(r => r.source === key).length;
  const delta = rs.length - before;
  console.log(`${key.padEnd(17)} ${String(rs.length).padStart(5)} records${before ? ` (${delta >= 0 ? '+' : ''}${delta})` : ' (new source)'}`);
}
console.log(`total             ${String(seen.size).padStart(5)} records`);
console.log(`\nmanifest: ${fresh} new, ${kept} unchanged, ${staled} stale${removed.length ? `, ${removed.length} removed` : ''}`);
console.log(`annotations: ${rehashed} re-hashed (text equivalent under markup), ${renamed} moved to a renamed id`);
console.log(`lexicons: ${statuses.length} statuses, ${families.length} families, ${Object.keys(TOKENS).length} markup tokens`);
if (staleReal.size) {
  const bySource = {};
  for (const id of staleReal) {
    const src = seen.get(id).source;
    bySource[src] = (bySource[src] ?? 0) + 1;
  }
  console.log(`\n${staleReal.size} record(s) whose text genuinely changed — re-review:`);
  for (const [src, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${src.padEnd(17)} ${String(n).padStart(4)}`);
  }
  // --verbose prints the before/after so a run can be judged rather than trusted.
  if (process.argv.includes('--verbose')) {
    const perSource = {};
    for (const id of staleReal) {
      const src = seen.get(id).source;
      perSource[src] = (perSource[src] ?? 0) + 1;
      if (perSource[src] > 4) continue;
      console.log(`\n  ${id}\n    was: ${prior.get(id).text}\n    now: ${seen.get(id).text}`);
    }
  }
}
if (removed.length) {
  console.log(`\n${removed.length} record(s) no longer in source:`);
  for (const id of removed.slice(0, 20)) console.log(`  ${id}`);
  if (removed.length > 20) console.log(`  … ${removed.length - 20} more`);
}
if (notes.length) {
  console.log(`\n${notes.length} note(s):`);
  for (const n of notes.slice(0, 30)) console.log(`  ${n}`);
  if (notes.length > 30) console.log(`  … ${notes.length - 30} more`);
}
