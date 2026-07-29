// Compile normalized + annotations (+ overrides) into the app's search index:
// web/public/index.json (minified; gitignored build artifact).
// Every record is included — untagged ones are text-searchable and flagged so
// the app can show coverage honestly. Run from repo root: npm run build-index
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { loadLexicon } from './lib/lexicon.js';
import { SOURCE_DIRS } from './lib/ids.js';
import { SCHEMA_VERSION } from './lib/schema.js';

const lex = loadLexicon();
const statusKind = Object.fromEntries(lex.statuses.map(s => [s.name, s.kind]));

// --- load annotations, overrides win wholesale ---
const anns = new Map();
for (const base of ['data/annotations', 'data/overrides']) {
  if (!existsSync(base)) continue;
  for (const dir of readdirSync(base)) {
    for (const f of readdirSync(`${base}/${dir}`)) {
      if (!f.endsWith('.json')) continue;
      const ann = JSON.parse(readFileSync(`${base}/${dir}/${f}`, 'utf8'));
      anns.set(ann.id, ann);
    }
  }
}

// interaction facet per status: how does this effect relate to it?
const VERB_INTERACTION = {
  apply_status: s => (statusKind[s] === 'buff' ? 'grants' : 'inflicts'),
  remove_status: () => 'removes',
  steal_status: () => 'steals',
  prevent_status: () => 'prevents',
  status_modifier: () => 'modifies',
  detonate: () => 'detonates',
};

// Facets are derived ONE RULE AT A TIME. The record-level bag is their union;
// the per-rule bags are what make "same rule" search possible — without them a
// trait whose rule A is passive and rule B attacks would answer "passive AND
// attacks", which no single rule of it actually does.
// Canonical key order — keeps the built artifact byte-stable across runs.
const FACET_KEYS = [
  'triggers', 'verbs', 'actors', 'targets', 'conditions', 'tiers', 'scaleStats',
  'scaleRefs', 'qualifiers', 'flows', 'statusInteractions', 'statInteractions',
  'classInteractions', 'raceInteractions',
];

function deriveRuleFacets(rule) {
  const f = Object.fromEntries(FACET_KEYS.map(k => [k, new Set()]));
  let chanceBased = false, perRank = false;
  const statusesOf = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
  {
    const t = rule.trigger ?? {};
    f.triggers.add(t.type);
    for (const s of [...statusesOf(t.params?.status), ...statusesOf(t.params?.statuses)]) {
      f.statusInteractions.add(`${s}|triggers_off`);
    }
    if (t.type === 'after_stat_change' && t.params?.stat) {
      f.statInteractions.add(`${t.params.stat}|triggers_off`);
    }
    // "cares about <class> SPELLS" reads the same key wherever it appears —
    // "after casting a Life spell" is as searchable as "amplifies Life spells".
    if (t.params?.spellClass) f.classInteractions.add(`${t.params.spellClass}|spells`);
    for (const c of rule.conditions ?? []) {
      f.conditions.add(c.type);
      for (const s of [...statusesOf(c.params?.status), ...statusesOf(c.params?.statuses)]) {
        f.statusInteractions.add(`${s}|conditions_on`);
      }
      // Plural forms cover conditions that name several races/classes at once
      // ("your Imlers and Imlings") — same reason statuses accept arrays.
      for (const cl of [...statusesOf(c.params?.class), ...statusesOf(c.params?.classes)]) {
        f.classInteractions.add(`${cl}|conditions_on`);
      }
      for (const r of [...statusesOf(c.params?.race), ...statusesOf(c.params?.races)]) {
        f.raceInteractions.add(`${r}|conditions_on`);
      }
      if (c.type === 'stat_comparison' && c.params?.stat) {
        f.statInteractions.add(`${c.params.stat}|conditions_on`);
      }
      if (c.params?.spellClass) f.classInteractions.add(`${c.params.spellClass}|spells`);
    }
    if (rule.chance) chanceBased = true;
    // For side-of-battle search, indirection resolves to the trigger's side:
    // "the enemy that was healed casts…" facets as actor: enemy.
    const resolve = v => (v === 'trigger_subject' ? (t.subject ?? v) : v);
    for (const a of rule.actions ?? []) {
      f.verbs.add(a.verb);
      if (a.actor) f.actors.add(resolve(a.actor));
      if (a.target) f.targets.add(resolve(a.target));
      if (a.flow) f.flows.add(a.flow);
      for (const q of a.qualifiers ?? []) f.qualifiers.add(q);
      const inter = VERB_INTERACTION[a.verb];
      for (const s of a.statuses ?? []) {
        f.statusInteractions.add(`${s}|${inter ? inter(s) : 'interacts'}`);
      }
      // Unnamed statuses ("a random debuff", "lose 1 buff") still answer
      // interaction-only queries via a wildcard key.
      if (inter && !(a.statuses?.length)) {
        const kind = a.statusKind;
        const wildInter = a.verb === 'apply_status'
          ? (kind === 'buff' ? 'grants' : kind === 'debuff' ? 'inflicts' : null)
          : inter('');
        if (wildInter) f.statusInteractions.add(`*|${wildInter}`);
        else if (a.verb === 'apply_status') { f.statusInteractions.add('*|grants'); f.statusInteractions.add('*|inflicts'); }
      }
      if (a.verb === 'stat_change') {
        const stolen = a.qualifiers?.includes('stolen');
        const dirInter = a.magnitude?.direction === 'down' ? 'decreases' : 'increases';
        for (const s of a.stats ?? []) {
          f.statInteractions.add(`${s}|${dirInter}`);
          if (stolen) f.statInteractions.add(`${s}|steals`);
        }
      }
      if (a.verb === 'stat_rule') {
        for (const s of a.stats ?? []) f.statInteractions.add(`${s}|modifies`);
      }
      // "damage from/to <class> creatures|spells" lives in conventional params
      if (a.params?.sourceClass) f.classInteractions.add(`${a.params.sourceClass}|vs`);
      if (a.params?.vsClass) f.classInteractions.add(`${a.params.vsClass}|vs`);
      if (a.params?.sourceRace) f.raceInteractions.add(`${a.params.sourceRace}|vs`);
      // "cares about <class> SPELLS" — distinct from vs-class damage.
      if (a.params?.spellClass) f.classInteractions.add(`${a.params.spellClass}|spells`);
      const m = a.magnitude;
      if (m) {
        if (m.tier) f.tiers.add(m.tier);
        if (m.scaleStat) { f.scaleStats.add(m.scaleStat); f.statInteractions.add(`${m.scaleStat}|scales_with`); }
        if (m.scaleRef) f.scaleRefs.add(m.scaleRef);
        if (m.perRank) perRank = true;
      }
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(f)) if (v.size) out[k] = [...v].sort();
  if (chanceBased) out.chanceBased = true;
  if (perRank) out.perRank = true;
  return out;
}

// Record-level bag = union of the rule bags, plus the flags that belong to the
// annotation rather than any one rule.
function unionFacets(ruleFacets, ann) {
  const out = {};
  for (const k of FACET_KEYS) {
    const merged = [...new Set(ruleFacets.flatMap(rf => rf[k] ?? []))].sort();
    if (merged.length) out[k] = merged;
  }
  if (ruleFacets.some(rf => rf.chanceBased)) out.chanceBased = true;
  if (ruleFacets.some(rf => rf.perRank)) out.perRank = true;
  if (ann?.flags?.stacks === false) out.noStack = true;
  if (ann?.flags?.unmodeled) out.unmodeled = true;
  return out;
}

const manifest = JSON.parse(readFileSync('data/manifest.json', 'utf8')).records;
const records = [];
for (const src of Object.values(SOURCE_DIRS)) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) {
    const ann = anns.get(r.id);
    const entry = {
      id: r.id,
      type: src,
      name: r.name,
      text: r.text,
      meta: r.meta,
      status: manifest[r.id]?.status ?? 'todo',
    };
    if (ann) {
      entry.provenance = ann.provenance;
      entry.ruleFacets = (ann.rules ?? []).map(deriveRuleFacets);
      entry.facets = unionFacets(entry.ruleFacets, ann);
      entry.rules = ann.rules;
      if (ann.flags) entry.flags = ann.flags;
      if (ann.notes) entry.notes = ann.notes;
      if (ann.amplifies) entry.amplifies = ann.amplifies;
    }
    records.push(entry);
  }
}

// Meta-records inherit the facets of the records they amplify, so "Doubles the
// potency of these effects" answers the same queries its siblings do. The
// sibling's RULE bags are inherited intact rather than merged, so an inherited
// rule stays one rule-scoped unit under "same rule" search.
{
  const byEntry = new Map(records.map(e => [e.id, e]));
  for (const e of records) {
    if (!e.amplifies) continue;
    for (const sid of e.amplifies) {
      const s = byEntry.get(sid);
      if (!s?.facets) continue;
      e.facets ??= {};
      for (const [k, v] of Object.entries(s.facets)) {
        if (Array.isArray(v)) e.facets[k] = [...new Set([...(e.facets[k] ?? []), ...v])].sort();
      }
      e.ruleFacets = [...(e.ruleFacets ?? []), ...(s.ruleFacets ?? [])];
    }
  }
}

const index = {
  generated: new Date().toISOString(),
  schemaVersion: SCHEMA_VERSION,
  statuses: lex.statuses.map(s => ({ name: s.name, kind: s.kind })),
  counts: { total: records.length, tagged: records.filter(r => r.rules).length },
  records,
};
mkdirSync('web/public', { recursive: true });
const json = JSON.stringify(index);
writeFileSync('web/public/index.json', json);
console.log(`index: ${records.length} records (${index.counts.tagged} tagged), ${(json.length / 1024).toFixed(0)} KB`);
