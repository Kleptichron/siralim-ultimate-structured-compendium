// normalized -> data/evidence/{source}.json (machine facts about each text)
// plus full machine-draft annotations for texts that entirely match a
// high-confidence template. Never touches claude/human annotations.
// Run from repo root: npm run extract
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadLexicon } from './lib/lexicon.js';
import { termRegex, escapeRe } from './lib/normalize.js';
import { idToPath, SOURCE_DIRS } from './lib/ids.js';
import { SCHEMA_VERSION, validateAnnotation, crossCheckStatuses } from './lib/schema.js';

const lex = loadLexicon();
const sources = Object.values(SOURCE_DIRS);
const byId = new Map();
for (const src of sources) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) byId.set(r.id, r);
}

// ---------------- evidence ----------------

const sentencesOf = t => t.split(/(?<=[.!?])\s+/);

// Exact-word stat matcher. Case-insensitive: trait text sometimes lowercases
// stats ("gains 50% attack, intelligence"). No plural: "Attacks" is the verb,
// "Attack" the stat.
const statRegex = name => new RegExp(`(?<![A-Za-z])${escapeRe(name)}(?![a-zA-Z])`, 'i');

function statusContexts(text, forms) {
  const ctx = new Set();
  for (const s of sentencesOf(text)) {
    const form = forms.find(f => termRegex(f).test(s));
    if (!form) continue;
    if (/afflict/i.test(s)) ctx.add('afflict');
    if (new RegExp(`(?:gains?|start(?:s)? (?:each |the )?battles? with|always ha(?:s|ve))[^.]*?${escapeRe(form)}`).test(s)) ctx.add('gain');
    if (new RegExp(`\\b(?:creatures?|enem(?:y|ies)|targets?|all(?:y|ies)|bearer|master) with [^.]*?${escapeRe(form)}`).test(s)) ctx.add('cond');
    if (/immune to/i.test(s)) ctx.add('immune');
    if (/remov/i.test(s)) ctx.add('remove');
    if (/steal/i.test(s)) ctx.add('steal');
    if (ctx.size === 0) ctx.add('mention');
  }
  return [...ctx];
}

const OPENINGS = [
  [/^At the start of (?:each )?battle/, 'start_of_battle'],
  [/^After start-of-battle effects/, 'after_start_of_battle_effects'],
  [/^At the start of [^.]*turn/, 'start_of_turn'],
  [/^At the end of [^.]*turn/, 'end_of_turn'],
  [/^At the end of (?:each )?battle/, 'end_of_battle'],
  [/^After [^.]*? (?:attacks|Attacks)/, 'after_attack'],
  [/^After [^.]*? (?:is|are) attacked/, 'after_attacked'],
  [/^After [^.]*? (?:is|are) killed/, 'after_death'],
  [/^After [^.]*? dies/, 'after_death'],
  [/^After [^.]*? (?:is|are) resurrected/, 'after_resurrected'],
  [/^After [^.]*? (?:casts|Casts)/, 'after_cast'],
  [/^After [^.]*? (?:is|are) afflicted/, 'after_afflicted'],
  [/^After [^.]*? gains? a buff/, 'after_gains_buff'],
  [/^After [^.]*? takes? damage/, 'after_damaged'],
  [/^After [^.]*? deals? damage/, 'after_deals_damage'],
  [/^After [^.]*? provokes/, 'after_provoke'],
  [/^After [^.]*? defends/, 'after_defend'],
  [/^After [^.]*? dodges/, 'after_dodge'],
  [/^(?:While|If all the creatures|This creature|Your creatures|Enemies|Creatures with)/, 'passive'],
];

function evidenceFor(r) {
  const t = r.text;
  const statuses = {};
  for (const name of lex.statusNames) {
    const forms = lex.statusForms[name] ?? [name];
    if (forms.some(f => termRegex(f).test(t))) statuses[name] = statusContexts(t, forms);
  }
  const stats = lex.stats.filter(s => statRegex(s).test(t));
  const ev = {
    statuses,
    stats,
    allStats: /\d+% (?:more |less )?stats\b/.test(t),
    percents: [...t.matchAll(/(\d+(?:\.\d+)?)%/g)].map(m => Number(m[1])),
    tiers: [...t.matchAll(/\b(small|moderate|large|massive|devastating)\b/g)].map(m => m[1]),
    chance: t.match(/(\d+)% chance/)?.[1] ? Number(t.match(/(\d+)% chance/)[1]) : null,
    doesNotStack: /does not stack/i.test(t),
    perRank: /per rank/i.test(t),
    maxBonus: t.match(/Maximum (?:Bonus|Potency)?:? ?([^.]+)\./)?.[1] ?? null,
    openingGuess: OPENINGS.find(([re]) => re.test(t))?.[1] ?? null,
  };
  return ev;
}

// ---------------- machine templates ----------------

const STATUS_ALT = [...lex.statusNames].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const STAT_ALT = [...lex.stats].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
const CLASS_ALT = lex.classes.join('|');
const TIER_ALT = 'small|moderate|large|massive|devastating';
// A run of status names separated by commas/and/or, e.g. "Weak and Vulnerable".
const LIST = `(?:${STATUS_ALT})(?:(?:, | and | or |, and |, or )(?:${STATUS_ALT}))*`;

function parseList(blob) {
  return blob.split(/, and |, or |, | and | or /).map(s => s.trim());
}

const dir = { 'more': 'up', 'less': 'down', 'higher': 'up', 'lower': 'down' };
const scopeOf = { 'your creatures': 'allies', 'the bearer': 'holder', 'this creature': 'holder', 'Enemies': 'enemies', 'Your creatures': 'allies', 'Target': 'target', 'The bearer': 'holder' };

const rule = (trigger, actions, extra = {}) => ({ trigger, conditions: [], actions, ...extra });

const TEMPLATES = [
  {
    name: 'stat-mod-allies', sources: ['cards'],
    re: new RegExp(`^Your creatures have (\\d+)% (more|less) (${STAT_ALT})\\.$`),
    build: m => [rule({ type: 'passive', subject: 'allies' },
      [{ verb: 'stat_change', target: 'allies', stats: [m[3]], magnitude: { amountPct: Number(m[1]), direction: dir[m[2]] } }])],
  },
  {
    name: 'immune-group', sources: ['cards', 'perks', 'realm', 'relics'],
    re: new RegExp(`^(Your creatures|Enemies|The bearer) (?:are|is) immune to (${LIST})\\.$`),
    build: m => [rule({ type: 'passive', subject: scopeOf[m[1]] },
      [{ verb: 'prevent_status', target: scopeOf[m[1]], statuses: parseList(m[2]) }])],
  },
  {
    name: 'always-have', sources: ['cards', 'perks', 'realm'],
    re: new RegExp(`^(Your creatures|Enemies) always ha(?:ve|s) (${LIST})\\.$`),
    build: m => [rule({ type: 'passive', subject: scopeOf[m[1]] },
      [{ verb: 'apply_status', target: scopeOf[m[1]], statuses: parseList(m[2]), qualifiers: ['permanent'] }])],
  },
  {
    name: 'start-battle-gain', sources: ['cards', 'perks', 'realm', 'relics', 'traits'],
    re: new RegExp(`^At the start of battle, (your creatures|the bearer|this creature) gains? (${LIST})\\.$`),
    build: m => [rule({ type: 'start_of_battle', subject: scopeOf[m[1]] },
      [{ verb: 'apply_status', target: scopeOf[m[1]], statuses: parseList(m[2]) }])],
  },
  {
    name: 'enemies-start-with', sources: ['realm', 'nemesis'],
    re: new RegExp(`^Enemies start battles? with (${LIST})\\.$`),
    build: m => [rule({ type: 'start_of_battle', subject: 'enemies' },
      [{ verb: 'apply_status', target: 'enemies', statuses: parseList(m[1]) }])],
  },
  {
    name: 'spell-afflict', sources: ['spells'],
    re: new RegExp(`^(Target|Enemies) (?:is|are) afflicted with (${LIST})\\.$`),
    build: m => [rule({ type: 'activated' },
      [{ verb: 'apply_status', target: scopeOf[m[1]], statuses: parseList(m[2]) }])],
  },
  {
    name: 'spell-gain', sources: ['spells'],
    re: new RegExp(`^Your creatures gain (${LIST})\\.$`),
    build: m => [rule({ type: 'activated' },
      [{ verb: 'apply_status', target: 'allies', statuses: parseList(m[1]) }])],
  },
  {
    name: 'spell-damage', sources: ['spells'],
    re: new RegExp(`^(Target|Enemies) takes? a (${TIER_ALT}) amount of damage(?:,? and (?:is|are) afflicted with (${LIST}))?\\.$`),
    build: m => [rule({ type: 'activated' },
      [
        { verb: 'deal_damage', target: scopeOf[m[1]], magnitude: { tier: m[2] } },
        ...(m[3] ? [{ verb: 'apply_status', target: scopeOf[m[1]], statuses: parseList(m[3]) }] : []),
      ])],
  },
  {
    name: 'card-class-spell-dr', sources: ['cards'],
    re: new RegExp(`^Your creatures take (\\d+)% less damage from (${CLASS_ALT}) spells\\.$`),
    build: m => [rule({ type: 'passive', subject: 'allies' },
      [{ verb: 'damage_modifier', target: 'allies', flow: 'taken', magnitude: { amountPct: Number(m[1]), direction: 'down' }, params: { sourceClass: m[2], sourceKind: 'spells' } }])],
  },
  {
    name: 'card-class-attack-dr', sources: ['cards'],
    re: new RegExp(`^Your creatures take (\\d+)% less damage from attacks from (${CLASS_ALT}) creatures\\.$`),
    build: m => [rule({ type: 'passive', subject: 'allies' },
      [{ verb: 'damage_modifier', target: 'allies', flow: 'taken', magnitude: { amountPct: Number(m[1]), direction: 'down' }, params: { sourceClass: m[2], sourceKind: 'attacks' } }])],
  },
];

const STACK_RE = /\s*This (?:trait|perk) does not stack\.$/;

function machineDraft(r) {
  let text = r.text;
  const flags = {};
  if (STACK_RE.test(text)) { flags.stacks = false; text = text.replace(STACK_RE, '').trim(); }
  for (const t of TEMPLATES) {
    if (!t.sources.includes(r.source)) continue;
    const m = text.match(t.re);
    if (!m) continue;
    return {
      id: r.id,
      textHash: r.textHash,
      schemaVersion: SCHEMA_VERSION,
      provenance: 'machine',
      machineTemplate: t.name,
      rules: t.build(m),
      ...(Object.keys(flags).length ? { flags } : {}),
    };
  }
  return null;
}

// ---------------- run ----------------

const manifest = JSON.parse(readFileSync('data/manifest.json', 'utf8'));
let drafts = 0, skippedHuman = 0, templateErrors = 0;
const templateHits = {};

for (const src of sources) {
  const records = JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'));
  const evidence = {};
  mkdirSync(`data/annotations/${src}`, { recursive: true });
  for (const r of records) {
    if (r.meta?.loreOnly) continue;
    evidence[r.id] = evidenceFor(r);

    const draft = machineDraft(r);
    if (!draft) continue;
    const { dir: d, file } = idToPath(r.id);
    const path = `data/annotations/${d}/${file}`;
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (existing.provenance !== 'machine') { skippedHuman++; continue; }
    }
    const errs = [...validateAnnotation(draft, r, lex), ...crossCheckStatuses(draft, r, lex)];
    if (errs.length) {
      console.error(`TEMPLATE BUG (${draft.machineTemplate}):\n  ${errs.join('\n  ')}`);
      templateErrors++;
      continue;
    }
    writeFileSync(path, JSON.stringify(draft, null, 2) + '\n');
    manifest.records[r.id] = { hash: r.textHash, status: 'machine', provenance: 'machine' };
    templateHits[draft.machineTemplate] = (templateHits[draft.machineTemplate] ?? 0) + 1;
    drafts++;
  }
  writeFileSync(`data/evidence/${src}.json`, JSON.stringify(evidence, null, 2) + '\n');
}

writeFileSync('data/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`evidence written for ${sources.length} sources`);
console.log(`machine drafts: ${drafts} (${skippedHuman} skipped over non-machine annotations)`);
for (const [k, v] of Object.entries(templateHits).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
if (templateErrors) { console.error(`${templateErrors} template errors`); process.exit(1); }
