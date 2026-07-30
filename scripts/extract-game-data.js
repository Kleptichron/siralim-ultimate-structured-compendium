// Siralim Ultimate ships its own localization tables: one CSV per content area
// under <install>/localization, one row per string, one column per language.
// That is the game's authoritative text, and it carries semantic markup the
// community transcriptions flattened away (see scripts/lib/markup.js).
//
// This script is a MANUAL step — it needs the game installed, so it cannot run
// in CI. It reads the English column of the gameplay tables and vendors the
// result into source/game/*.json, which IS committed. Everything downstream
// (import, validate, build-index) reads only the vendored copy, so a clean
// checkout builds the same site without the game present.
//
//   npm run extract-game                     # default Steam location
//   npm run extract-game -- "D:/Games/Siralim Ultimate"
//   SIRALIM_DIR="..." npm run extract-game
//
// Re-run it after a game update; the diff on source/game/ is the changelog, and
// import.js turns changed effect text into `stale` manifest entries to re-review.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCSV } from './lib/csv.js';
import { normPunct, stripIcons, tokensIn, resolveMarkup, SEMANTIC_BRACKETS } from './lib/markup.js';

const DEFAULT_DIRS = [
  'C:/Program Files (x86)/Steam/steamapps/common/Siralim Ultimate',
  'C:/Program Files/Steam/steamapps/common/Siralim Ultimate',
  process.env.HOME ? `${process.env.HOME}/.steam/steam/steamapps/common/Siralim Ultimate` : null,
].filter(Boolean);

const arg = process.argv[2] ?? process.env.SIRALIM_DIR;
const gameDir = arg ?? DEFAULT_DIRS.find(d => existsSync(join(d, 'localization')));
if (!gameDir || !existsSync(join(gameDir, 'localization'))) {
  console.error('Could not find the Siralim Ultimate install (no localization/ directory).');
  console.error('Pass it explicitly:  npm run extract-game -- "<path to Siralim Ultimate>"');
  process.exit(1);
}
const LOC = join(gameDir, 'localization');
console.log(`reading ${LOC}`);

// Which build this data came from. The project previously had to say the game
// version was unrecorded; a Steam install states it, so it gets written down.
function steamBuild(dir) {
  // <library>/steamapps/common/Siralim Ultimate -> <library>/steamapps/appmanifest_1289810.acf
  const acf = join(dir, '..', '..', 'appmanifest_1289810.acf');
  if (!existsSync(acf)) return null;
  const txt = readFileSync(acf, 'utf8');
  const get = k => new RegExp(`"${k}"\\s+"([^"]*)"`).exec(txt)?.[1] ?? null;
  const updated = get('LastUpdated');
  return {
    steamAppId: '1289810',
    steamBuildId: get('buildid'),
    depotUpdated: updated ? new Date(Number(updated) * 1000).toISOString().slice(0, 10) : null,
  };
}

// --- tag -> English, per file and pooled ------------------------------------
const files = readdirSync(LOC).filter(f => f.endsWith('.csv'));
const perFile = new Map();
const pooled = new Map(); // first file wins; only used for name lookups
for (const f of files) {
  const rows = parseCSV(readFileSync(join(LOC, f), 'utf8'));
  const iEn = rows[0].indexOf('English');
  if (iEn < 0) continue;
  const m = new Map();
  for (const r of rows.slice(1)) {
    if (!r[0]?.startsWith('L_')) continue;
    const v = normPunct(r[iEn] ?? '');
    m.set(r[0], v);
    if (!pooled.has(r[0])) pooled.set(r[0], v);
  }
  perFile.set(f, m);
}
const file = f => {
  const m = perFile.get(f);
  if (!m) throw new Error(`missing localization file ${f}`);
  return m;
};
const tagsMatching = (f, re) => [...file(f).keys()].filter(k => re.test(k));

// Strings the game ships as a short bare name, indexed by value. Used to prove a
// resolved display name is a string the game can actually render, rather than a
// plausible-looking guess.
const shippedNames = new Set(
  [...pooled.values()].filter(v => v && v.length <= 40 && !/[{}]/.test(v)),
);
const squash = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Tag keys are squashed ("HELLKNIGHT") while the shipped name tag may be
// segmented ("L_HELL_KNIGHT"), so a bare L_<KEY> lookup misses. Index every tag
// by its squashed form and fall back to that.
const bySquashedTag = new Map();
for (const k of pooled.keys()) {
  const s = squash(k.slice(2));
  if (!bySquashedTag.has(s)) bySquashedTag.set(s, k);
}
function bareName(key) {
  const direct = pooled.get(`L_${key}`);
  if (direct) return direct;
  const tag = bySquashedTag.get(squash(key));
  return tag ? pooled.get(tag) : null;
}
// Realm display names, keyed the same way relics and blessings are.
const realmName = key => pooled.get(`L_BIOME_${key}`) ?? null;
// "Arbiter, Holy Shield of Surathli" -> Surathli. The relic's own title is the
// only place the game pairs a relic with its god in shipped text. One title is
// written in caps ("SPARE BOOT OF TORUN"), so the name is matched
// case-insensitively and then normalised back to the god's shipped spelling.
const godFromTitle = title => {
  const m = /\bof\s+([^,]+)$/i.exec(title ?? '');
  if (!m) return null;
  const raw = m[1].trim();
  return bareName(raw.toUpperCase().replace(/[^A-Z0-9]/g, '')) ?? raw;
};

// --- token -> display name --------------------------------------------------
// Most families resolve by rule. CONDNAME does not: the token key is the game's
// internal id (DEBUFF_BURNED) and the display name is an inflected word
// ("Burning") the key does not contain, so it is resolved against the shipped
// strings instead.
const GODS_BY_REALM = { VOID: 'Vertraag' }; // extend when an ingested string needs one
const SPELL_CATEGORIES = { alcohol: 'Booze Spell', equipment: 'Arsenal Spell', ultimate: 'Ultimate Spell' };

// A status's internal key is not its display name, and the two differ by more
// than a prefix: DEBUFF_BURNED shows as "Burning", BUFF_WARD as "Warded",
// MINION_LITTLETORUN as "Torun Junior". Only compiled code holds that mapping,
// so it is curated in data/lexicon/status-names.json — 65 entries that change
// about once a content patch. Each value is checked against the strings the game
// actually ships, and an unlisted token is a hard error rather than a guess, so
// a patch that adds a status fails the extract instead of inventing a name.
const STATUS_NAMES = JSON.parse(readFileSync('data/lexicon/status-names.json', 'utf8'));
const statusNameProblems = [];

function resolveCondname(token) {
  const name = STATUS_NAMES[token];
  if (!name) {
    statusNameProblems.push(`${token} is not in data/lexicon/status-names.json`);
    return null;
  }
  if (!shippedNames.has(name)) {
    statusNameProblems.push(`${token} -> "${name}" is not a string the game ships`);
  }
  return name;
}

// Resolve one token, or null. `condDesc` supplies the nested status-description
// expansions, which are only available on the second pass.
function resolveToken(token, family, key, condDesc) {
  switch (family) {
    // The key is the display name verbatim: {RACE_Diabolic Horde}, {CLASS_Chaos}.
    case 'RACE': case 'CLASS': return key;
    // Lowercase lemmas the game capitalises at a sentence start.
    case 'STAT': case 'ACTION': return key;
    case 'TIMELINE': return 'Timeline';
    case 'CONDNAME': return resolveCondname(token);
    // {CONDDESC_BUFF_AGILE} inlines that buff's whole description sentence.
    case 'CONDDESC': return condDesc?.[key] ?? null;
    case 'SPELL': return SPELL_CATEGORIES[key] ?? null;
    // {RES_BRIMSTONE} -> L_BRIMSTONE, {SPEC_DRUID} -> L_DRUID.
    case 'RES': case 'SPEC': return bareName(key);
    case 'GOD': case 'GODT': case 'GODTI': return GODS_BY_REALM[key] ?? null;
    // A bare runtime number ("kill {X} more enemies").
    case 'X': return 'X';
    default: return null;
  }
}

function buildTokenMap(texts, condDesc) {
  const map = {};
  const unresolved = new Set();
  for (const text of texts) {
    for (const { token, family, key } of tokensIn(text)) {
      if (map[token]) continue;
      const v = resolveToken(token, family, key, condDesc);
      if (v) map[token] = v; else unresolved.add(token);
    }
  }
  return { map, unresolved: [...unresolved].sort() };
}

// --- gameplay sources -------------------------------------------------------
// Each entry pulls one content area. `markup` keeps the game's string verbatim
// (minus sprite refs); import.js resolves and diffs it.
const clean = s => stripIcons(s).replace(/\s+/g, ' ').trim();

// Unreleased content ships with a stub for its effect text. Carrying "NYI" into
// the corpus would add records with nothing to annotate, so they are dropped and
// counted.
const PLACEHOLDER = /^(nyi|tbd|todo|placeholder|n\/a|\?+|-+)\.?$/i;
const isPlaceholder = markup => PLACEHOLDER.test((markup ?? '').trim());
const dropped = [];
function keep(rows, label) {
  const out = rows.filter(r => !isPlaceholder(r.markup));
  const n = rows.length - out.length;
  if (n) dropped.push(`${label}: ${n} row(s) with placeholder effect text (NYI and similar)`);
  return out;
}

// Every creature family the game names, from two places: the bare name tags in
// creatures.csv, and the keys of {RACE_*} tokens (which ARE display names, and
// cover multi-word families like "Doom Fortress" that have no name tag). Indexed
// by squashed form so card keys such as DOOMFORTRESS resolve.
const familyNames = new Set(
  [...file('creatures.csv').entries()]
    .filter(([k, v]) => !k.startsWith('L_CRIT_') && v && !/[{}]/.test(v))
    .map(([, v]) => v),
);
for (const m of perFile.values()) {
  for (const v of m.values()) {
    for (const t of v.matchAll(/\{RACE_([^}]+)\}/g)) familyNames.add(t[1]);
  }
}
const familyBySquashed = new Map([...familyNames].map(n => [squash(n), n]));

// traits: L_TRAIT_NAME_<KEY> / L_TRAIT_DESC_<KEY>
const traits = keep(tagsMatching('traits.csv', /^L_TRAIT_NAME_/).map(tag => {
  const key = tag.slice('L_TRAIT_NAME_'.length);
  return { key, name: file('traits.csv').get(tag), markup: clean(file('traits.csv').get(`L_TRAIT_DESC_${key}`) ?? '') };
}).filter(t => t.name), 'traits');

// spells: L_SN_<KEY> / L_SD_<KEY>
const spells = keep(tagsMatching('spells.csv', /^L_SN_/).map(tag => {
  const key = tag.slice('L_SN_'.length);
  return { key, name: file('spells.csv').get(tag), markup: clean(file('spells.csv').get(`L_SD_${key}`) ?? '') };
}).filter(s => s.name), 'spells');

// cards: L_CARD_<FAMILYKEY><1|2|3>; the family display name is a bare L_<KEY> tag
const cards = [];
for (const tag of tagsMatching('cards.csv', /^L_CARD_/)) {
  const m = /^L_CARD_(.+?)(\d)$/.exec(tag);
  if (!m) { console.warn(`  card tag not understood: ${tag}`); continue; }
  const [, famKey, tier] = m;
  cards.push({
    key: `${famKey}${tier}`,
    familyKey: famKey,
    family: familyBySquashed.get(squash(famKey)) ?? bareName(famKey),
    tier: Number(tier),
    markup: clean(file('cards.csv').get(tag)),
  });
}

// perks: L_P_<KEY> (name) / L_P_<KEY>_DESC
const perks = tagsMatching('perks.csv', /^L_P_/)
  .filter(t => !t.endsWith('_DESC'))
  .map(tag => {
    const key = tag.slice('L_P_'.length);
    return { key, name: file('perks.csv').get(tag), markup: clean(file('perks.csv').get(`${tag}_DESC`) ?? '') };
  })
  .filter(p => p.name);


// relics: ui L_RELIC_<GOD><rank>; name + extended title in vocabulary
const relics = [];
for (const tag of tagsMatching('ui.csv', /^L_RELIC_[A-Z]+\d+$/)) {
  const m = /^L_RELIC_([A-Z]+?)(\d+)$/.exec(tag);
  const [, key, rank] = m;
  const title = file('vocabulary.csv').get(`L_RELIC_${key}_EXT`) ?? null;
  relics.push({
    key: `${key}${rank}`,
    relicKey: key,
    relicName: file('vocabulary.csv').get(`L_RELIC_${key}`) ?? null,
    relicTitle: title,
    // The relic's full title is the only shipped text pairing it with its god.
    god: godFromTitle(title),
    rank: Number(rank),
    markup: clean(file('ui.csv').get(tag)),
  });
}

// statuses: vocabulary L_CDESC_<BUFF|DEBUFF|MINION>_<KEY>
const statuses = [];
for (const tag of tagsMatching('vocabulary.csv', /^L_CDESC_(BUFF|DEBUFF|MINION)_/)) {
  const m = /^L_CDESC_(BUFF|DEBUFF|MINION)_(.+)$/.exec(tag);
  const [, kind, key] = m;
  const token = `CONDNAME_${kind}_${key}`;
  statuses.push({
    token, key, kind: kind.toLowerCase(),
    name: resolveCondname(token),
    markup: clean(file('vocabulary.csv').get(tag)),
  });
}

// realm properties: codex L_RP_<KEY>
const realm = tagsMatching('codex.csv', /^L_RP_/).map(tag => ({
  key: tag.slice('L_RP_'.length), markup: clean(file('codex.csv').get(tag)),
}));

// specializations: ui L_SPEC_DESC_<KEY> + L_SPEC_STYLE_<KEY>; name is bare L_<KEY>
const specs = tagsMatching('ui.csv', /^L_SPEC_DESC_/).map(tag => {
  const key = tag.slice('L_SPEC_DESC_'.length);
  return {
    key,
    name: bareName(key),
    markup: clean(file('ui.csv').get(tag)),
    playstyle: clean(file('ui.csv').get(`L_SPEC_STYLE_${key}`) ?? ''),
  };
});

// artifact modifiers: vocabulary holds the authoritative name list; the effect
// text lives in ui, under a tag that does not always share the name's key. The
// status-inflicting family is keyed by the status's INTERNAL id on the ui side
// and by its DISPLAY name on the vocabulary side — "Agile On Damage" pairs with
// L_ARTMOD_BUFFHIT_AGILE, "Bleeding On Damage" with L_ARTMOD_DEBUFFHIT_BLEED — so
// the status-name map is inverted to bridge them. Stat-pair mods ("Health &
// Attack") are self-descriptive and genuinely have no separate text.
// Indexed by both spellings a mod's name might use: the status's display name
// ("Bleeding On Damage") or its internal key ("Sleep On Damage", where the status
// displays as "Sleeping").
const statusByDisplay = new Map();
for (const [token, name] of Object.entries(STATUS_NAMES)) {
  statusByDisplay.set(squash(name), token);
  const key = token.replace(/^CONDNAME_(BUFF|DEBUFF|MINION)_/, '');
  if (!statusByDisplay.has(squash(key))) statusByDisplay.set(squash(key), token);
}
function artifactModDesc(key, name) {
  const ui = file('ui.csv');
  const direct = ui.get(`L_ARTMOD_${key}_DESC`) ?? ui.get(`L_ARTMOD_${key}`);
  if (direct) return direct;
  const m = /^(.+?)\s+On Damage$/i.exec(name ?? '');
  if (!m) return '';
  const token = statusByDisplay.get(squash(m[1]));
  const st = token && /^CONDNAME_(BUFF|DEBUFF)_(.+)$/.exec(token);
  return st ? (ui.get(`L_ARTMOD_${st[1]}HIT_${st[2]}`) ?? '') : '';
}
const artifactMods = tagsMatching('vocabulary.csv', /^L_ARTMOD_/).map(tag => {
  const key = tag.slice('L_ARTMOD_'.length);
  const name = file('vocabulary.csv').get(tag);
  return { key, name, markup: clean(artifactModDesc(key, name)) };
});

// spell gem properties: codex L_SPMOD_<KEY>; no shipped display name, so the key
// is title-cased for one
const titleCase = k => k.charAt(0) + k.slice(1).toLowerCase();
const spellGemProps = tagsMatching('codex.csv', /^L_SPMOD_/).map(tag => {
  const key = tag.slice('L_SPMOD_'.length);
  return { key, name: bareName(key) ?? titleCase(key), markup: clean(file('codex.csv').get(tag)) };
});

// god blessings: ui L_BLESS_<KEY>_<N>. The key space mixes god names
// (ALEXANDRIA) with realm names (GEM, REACTOR) and a few legacy keys the game
// ships no string for (WINTER, ROBO, GENERAL), so `patron` takes whichever label
// exists and title-cases the key otherwise, rather than asserting which it is.
const blessings = [];
for (const tag of tagsMatching('ui.csv', /^L_BLESS_[A-Z]+_\d+$/)) {
  const m = /^L_BLESS_([A-Z]+)_(\d+)$/.exec(tag);
  const [, key, n] = m;
  blessings.push({
    key: `${key}_${n}`,
    patronKey: key,
    patron: bareName(key) ?? realmName(key) ?? titleCase(key),
    tier: Number(n),
    markup: clean(file('ui.csv').get(tag)),
  });
}

// --- token map over everything we actually ingest ---------------------------
const ingested = [
  ...traits.map(t => t.markup), ...spells.map(s => s.markup), ...cards.map(c => c.markup),
  ...perks.map(p => p.markup), ...relics.map(r => r.markup), ...statuses.map(s => s.markup),
  ...realm.map(r => r.markup), ...artifactMods.map(a => a.markup),
  ...spellGemProps.map(s => s.markup), ...blessings.map(b => b.markup),
];
// Two passes: {CONDDESC_BUFF_AGILE} inlines that status's whole description, so
// the status descriptions have to be resolved before the texts that embed them.
const pass1 = buildTokenMap(ingested);
const condDesc = {};
for (const s of statuses) {
  const key = `${s.kind.toUpperCase()}_${s.key}`;
  try { condDesc[key] = resolveMarkup(s.markup, pass1.map); } catch { /* left unresolved, reported below */ }
}
const { map: tokens, unresolved } = buildTokenMap(ingested, condDesc);

const families = [...familyNames].sort();

// --- bracket markup inventory ----------------------------------------------
// [slot_spell] and friends are semantic; [ad_mirrorball] is a sprite. Anything
// new shows up here rather than silently becoming a facet.
const brackets = new Map();
for (const t of ingested) {
  for (const m of t.matchAll(/\[([a-z][a-z_0-9]*)\]/g)) brackets.set(m[1], (brackets.get(m[1]) ?? 0) + 1);
}
const unknownBrackets = [...brackets.keys()].filter(b => !SEMANTIC_BRACKETS.includes(b));

// --- write ------------------------------------------------------------------
mkdirSync('source/game', { recursive: true });
const write = (name, data) => {
  writeFileSync(`source/game/${name}.json`, JSON.stringify(data, null, 2) + '\n');
  console.log(`  source/game/${name}.json  ${Array.isArray(data) ? data.length : Object.keys(data).length}`);
};
console.log('\nwrote:');
const build = steamBuild(gameDir);
writeFileSync('source/game/meta.json', JSON.stringify({
  extractedOn: new Date().toISOString().slice(0, 10),
  ...(build ?? { steamBuildId: null, note: 'not a Steam install — build id unavailable' }),
  counts: {
    traits: traits.length, spells: spells.length, cards: cards.length, perks: perks.length,
    relics: relics.length, statuses: statuses.length, realmProperties: realm.length,
    specializations: specs.length, artifactMods: artifactMods.length,
    spellGemProperties: spellGemProps.length, blessings: blessings.length, families: families.length,
  },
}, null, 2) + '\n');
console.log(`  source/game/meta.json  build ${build?.steamBuildId ?? 'unknown'}`);
write('tokens', tokens);
write('traits', traits);
write('spells', spells);
write('cards', cards);
write('perks', perks);
write('relics', relics);
write('statuses', statuses);
write('realm', realm);
write('specs', specs);
write('artifact-mods', artifactMods);
write('spell-gem-props', spellGemProps);
write('blessings', blessings);
write('families', families);

// --- report -----------------------------------------------------------------
const gaps = [];
if (unresolved.length) gaps.push(`${unresolved.length} unresolved token(s): ${unresolved.join(', ')}`);
for (const p of [...new Set(statusNameProblems)]) gaps.push(p);
// Names curated for statuses the game no longer has are dead weight worth seeing.
const liveTokens = new Set(statuses.map(s => s.token));
const orphanNames = Object.keys(STATUS_NAMES).filter(t => !liveTokens.has(t));
if (orphanNames.length) {
  gaps.push(`status-names.json has ${orphanNames.length} entr(y/ies) for statuses not in the game: ${orphanNames.join(', ')}`);
}
// Fields that must resolve for every row — a null here means the extractor's
// assumption about the game's tag layout no longer holds.
for (const [label, list, field] of [
  ['cards', cards, 'family'], ['relics', relics, 'relicName'], ['relics', relics, 'god'],
  ['statuses', statuses, 'name'], ['specs', specs, 'name'], ['artifact mods', artifactMods, 'name'],
  ['blessings', blessings, 'patron'],
]) {
  const missing = list.filter(x => !x[field]);
  if (missing.length) gaps.push(`${label}: ${missing.length} missing ${field} (e.g. ${missing.slice(0, 4).map(x => x.key).join(', ')})`);
}
// Empty effect text: fine for self-descriptive rows, worth seeing the count.
for (const [label, list] of [['artifact mods', artifactMods], ['blessings', blessings], ['realm props', realm]]) {
  const empty = list.filter(x => !x.markup).length;
  if (empty) console.log(`  note: ${label}: ${empty} row(s) have a self-descriptive name and no separate effect text`);
}
// Hundreds of sprite tags are expected — realm decorations, perk and spell
// icons. Only ones shaped like the semantic family are worth a warning.
const suspiciousBrackets = unknownBrackets.filter(b => /^(slot|temp|perm|stack|cond)/.test(b));
if (unknownBrackets.length) {
  console.log(`  note: ${unknownBrackets.length} bracket tag(s) treated as sprite refs`
    + ` (${SEMANTIC_BRACKETS.length} are allowlisted as semantic)`);
}
if (suspiciousBrackets.length) {
  gaps.push(`bracket tag(s) that look semantic but are not allowlisted: ${suspiciousBrackets.map(b => `[${b}]`).join(' ')}`);
}
for (const d of dropped) console.log(`  note: ${d}`);
console.log(`\ngame version dir: ${gameDir}`);
if (gaps.length) {
  console.log(`\n${gaps.length} thing(s) to look at:`);
  for (const g of gaps) console.log(`  ! ${g}`);
} else console.log('\nno gaps.');
