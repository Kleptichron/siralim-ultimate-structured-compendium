// Compile normalized + annotations (+ overrides) into the app's search index:
// web/public/index.json (minified; gitignored build artifact).
// Every record is included — untagged ones are text-searchable and flagged so
// the app can show coverage honestly. Run from repo root: npm run build-index
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadLexicon } from './lib/lexicon.js';
import { SOURCE_DIRS } from './lib/ids.js';
import { SCHEMA_VERSION, TIERS } from './lib/schema.js';

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
  // Percentage magnitudes as "verb|pct" pairs, so a range query can be checked
  // per ACTION. Storing bare numbers made "damage_modifier at 100%+" match a
  // rule holding a 50% damage_modifier next to a 100% stat_change — the same
  // cross-contamination as record-level facets, one level further down.
  'pcts',
];

// Default sort is lexicographic, which orders numbers 10, 100, 2, 25.
const sortVals = arr =>
  (arr.every(v => typeof v === 'number') ? arr.sort((a, b) => a - b) : arr.sort());

// One MATCH BAG per action, each carrying its own rule's trigger and condition
// facets alongside that single action's. Two action-level filters then have to
// land on the same action, while a trigger filter is satisfied by any bag of
// the rule — three levels of scoping falling out of one flat predicate.
//
// Without this, "deal_damage → caster" matched a rule holding some deal_damage
// beside some caster-targeted action: 18 of its 21 results were wrong.
function deriveRuleBags(rule, ruleIndex) {
  const statusesOf = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
  const t = rule.trigger ?? {};
  const chanceBased = !!rule.chance;

  // --- rule-level: trigger + conditions, shared by every bag of this rule ---
  const base = Object.fromEntries(FACET_KEYS.map(k => [k, new Set()]));
  {
    const f = base;
    f.triggers.add(t.type);
    for (const s of [...statusesOf(t.params?.status), ...statusesOf(t.params?.statuses)]) {
      f.statusInteractions.add(`${s}|triggers_off`);
    }
    // Plural form for triggers that name several stats at once ("gain attack,
    // intelligence, defense, or speed") — same reason statuses accept arrays.
    for (const s of [...statusesOf(t.params?.stat), ...statusesOf(t.params?.stats)]) {
      f.statInteractions.add(`${s}|triggers_off`);
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
  }

  // For side-of-battle search, indirection resolves to the trigger's side:
  // "the enemy that was healed casts…" facets as actor: enemy.
  const resolve = v => (v === 'trigger_subject' ? (t.subject ?? v) : v);

  const finish = (f, perRank) => {
    const out = { r: ruleIndex };
    for (const k of FACET_KEYS) if (f[k].size) out[k] = sortVals([...f[k]]);
    if (chanceBased) out.chanceBased = true;
    if (perRank) out.perRank = true;
    return out;
  };

  const actions = rule.actions ?? [];
  // A rule with no actions still needs a bag so its trigger stays searchable.
  if (!actions.length) return [finish(base, false)];

  return actions.map(a => {
    const f = Object.fromEntries(FACET_KEYS.map(k => [k, new Set(base[k])]));
    let perRank = false;
    {
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
        if (typeof m.amountPct === 'number') f.pcts.add(`${a.verb}|${m.amountPct}`);
        if (m.tier) f.tiers.add(m.tier);
        if (m.scaleStat) { f.scaleStats.add(m.scaleStat); f.statInteractions.add(`${m.scaleStat}|scales_with`); }
        if (m.scaleRef) f.scaleRefs.add(m.scaleRef);
        if (m.perRank) perRank = true;
      }
    }
    return finish(f, perRank);
  });
}

// Record-level bag = union of the match bags, plus the flags that belong to the
// annotation rather than any one rule.
function unionFacets(bags, ann) {
  const out = {};
  for (const k of FACET_KEYS) {
    const merged = sortVals([...new Set(bags.flatMap(b => b[k] ?? []))]);
    if (merged.length) out[k] = merged;
  }
  // Whole-record properties, as a value list rather than loose booleans: the
  // app's include/exclude/count machinery works on arrays, so this makes them
  // filterable ("does not stack", "chance-based") with no special cases.
  const markers = [];
  if (bags.some(b => b.chanceBased)) markers.push('chanceBased');
  if (bags.some(b => b.perRank)) markers.push('perRank');
  if (ann?.flags?.stacks === false) markers.push('noStack');
  if (ann?.flags?.unmodeled) markers.push('unmodeled');
  if (markers.length) out.markers = markers;
  return out;
}

// --- which build slots a trait may occupy ----------------------------------
// Both exclusions are stated outright in the source data rather than inferred.
// Three "creatures" name a mechanic instead of a being — mastery sigils, backer
// rewards and Zantai's jewels are earned, not fused from a creature — and the
// god and unique-boss traits carry a literal "No Material Exists", which is
// exactly what stops them being imbued onto an artifact. A nether stone takes
// anything, so every trait keeps that slot.
const NOT_A_CREATURE = new Set(['Mastery Trait', 'Backer Trait', 'Zantai Material']);
const NO_MATERIAL = 'No Material Exists';
// `class` carries the same distinction independently and agrees on all 1,780
// traits. Cross-checking the two costs nothing and means a corpus update that
// changes either one fails the build instead of silently mis-filtering the
// builder — a wrong slot rule is invisible until someone cannot pick a trait.
const NON_CREATURE_CLASSES = new Set(['Backer', 'Rodian Master', 'Boss']);

// Slot key -> facet value, in the order the sidebar should list them. Fusion is
// absent because it accepts exactly what innate does, nether because it accepts
// everything.
const EQUIP_FROM_SLOT = [['innate', 'creature'], ['artifact', 'artifact']];

function traitSlots(id, meta) {
  const fromCreature = !NOT_A_CREATURE.has(meta.creature);
  if (fromCreature === NON_CREATURE_CLASSES.has(meta.class)) {
    throw new Error(
      `${id}: creature "${meta.creature}" and class "${meta.class}" disagree about whether `
      + 'this trait comes from a creature — the build-slot rules need revisiting',
    );
  }
  const slots = [];
  if (fromCreature) slots.push('innate', 'fusion');
  if (meta.material !== NO_MATERIAL) slots.push('artifact');
  slots.push('nether');
  return slots;
}

const manifest = JSON.parse(readFileSync('data/manifest.json', 'utf8')).records;
const records = [];
for (const src of Object.values(SOURCE_DIRS)) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) {
    const status = manifest[r.id]?.status ?? 'todo';
    // A `stale` annotation was written against text the source has since changed.
    // Its rules are not merely incomplete, they can contradict the text now shown
    // — trait:bonding read "the same class" where the game says "a different
    // class" — and a rule that disagrees with its own record is worse than no rule
    // at all, because the reader has no way to see it. So the annotation is
    // withheld from the index until it is re-reviewed, and the record ships as
    // searchable text with an honest badge instead of a wrong answer.
    const ann = status === 'stale' ? null : anns.get(r.id);
    const entry = {
      id: r.id,
      type: src,
      name: r.name,
      text: r.text,
      meta: r.meta,
      status,
    };
    if (src === 'traits') entry.slots = traitSlots(r.id, r.meta);
    if (ann) {
      entry.provenance = ann.provenance;
      entry.matchBags = (ann.rules ?? []).flatMap((rule, i) => deriveRuleBags(rule, i));
      entry.facets = unionFacets(entry.matchBags, ann);
      entry.rules = ann.rules;
      if (ann.flags) entry.flags = ann.flags;
      if (ann.notes) entry.notes = ann.notes;
      if (ann.amplifies) entry.amplifies = ann.amplifies;
    }
    // Record-level facets: these come from the record's own metadata, not from
    // its rules, so they hold whether or not it has an annotation. They used to
    // sit inside the branch above, which was invisible while coverage was 100%
    // and became wrong the moment it wasn't — an untagged trait still has a known
    // family and a known slot, and filtering on either must still find it.
    //
    // Whose effect this IS — distinct from raceInteractions, which is about rules
    // that CHECK a race. Same vocabulary, opposite direction.
    if (r.meta?.family) (entry.facets ??= {}).families = [r.meta.family];
    // Where a trait can be equipped, from the slots derived above. Innate and
    // fusion collapse to one value: they are the same predicate, and two facet
    // values that can never disagree are noise in a list you scan. Nether is left
    // out entirely — it accepts every trait, so offering it would be a filter
    // that cannot filter.
    if (entry.slots) {
      (entry.facets ??= {}).equip = EQUIP_FROM_SLOT
        .filter(([slot]) => entry.slots.includes(slot)).map(([, value]) => value);
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
      e.matchBags = [...(e.matchBags ?? []), ...(s.matchBags ?? [])];
    }
  }
}

// Which game build the effect text was read from, so the footer can state it
// instead of only saying when the index was built.
const gameBuild = existsSync('source/game/meta.json')
  ? (({ steamBuildId, depotUpdated, extractedOn }) => ({ steamBuildId, depotUpdated, extractedOn }))(
      JSON.parse(readFileSync('source/game/meta.json', 'utf8')))
  : null;

const index = {
  generated: new Date().toISOString(),
  schemaVersion: SCHEMA_VERSION,
  ...(gameBuild?.steamBuildId && { gameBuild }),
  statuses: lex.statuses.map(s => ({ name: s.name, kind: s.kind })),
  // Groups whose values have an inherent order the app should display them in,
  // rather than the by-frequency default. Shipped so the scale lives only in
  // the schema and is never retyped in the UI.
  ordered: { tiers: TIERS, equip: EQUIP_FROM_SLOT.map(([, v]) => v) },
  counts: { total: records.length, tagged: records.filter(r => r.rules).length },
  records,
};
mkdirSync('web/public', { recursive: true });
const json = JSON.stringify(index);
writeFileSync('web/public/index.json', json);
// Ship a pre-compressed copy too. This index is ~9x smaller gzipped, and
// whether that saving arrives is otherwise entirely up to the host — Vite's dev
// server does not compress static files at all. The app prefers this file and
// falls back to the plain one, so hosts that DO compress lose nothing.
const gz = gzipSync(json, { level: 9 });
writeFileSync('web/public/index.json.gz', gz);
const kb = n => `${(n / 1024).toFixed(0)} KB`;
console.log(`index: ${records.length} records (${index.counts.tagged} tagged), `
  + `${kb(json.length)} raw, ${kb(gz.length)} gzip (${(json.length / gz.length).toFixed(1)}x)`);
