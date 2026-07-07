// Compile normalized + annotations (+ overrides) into the app's search index:
// web/public/index.json (minified; gitignored build artifact).
// Every record is included — untagged ones are text-searchable and flagged so
// the app can show coverage honestly. Run from repo root: npm run build-index
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { loadLexicon } from './lib/lexicon.js';
import { SOURCE_DIRS } from './lib/ids.js';

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

function deriveFacets(ann) {
  const f = {
    triggers: new Set(), verbs: new Set(), actors: new Set(), targets: new Set(),
    conditions: new Set(), tiers: new Set(), scaleStats: new Set(), scaleRefs: new Set(),
    qualifiers: new Set(), flows: new Set(), statusInteractions: new Set(),
  };
  let chanceBased = false, perRank = false;
  const statusesOf = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
  for (const rule of ann.rules ?? []) {
    const t = rule.trigger ?? {};
    f.triggers.add(t.type);
    for (const s of [...statusesOf(t.params?.status), ...statusesOf(t.params?.statuses)]) {
      f.statusInteractions.add(`${s}|triggers_off`);
    }
    for (const c of rule.conditions ?? []) {
      f.conditions.add(c.type);
      for (const s of [...statusesOf(c.params?.status), ...statusesOf(c.params?.statuses)]) {
        f.statusInteractions.add(`${s}|conditions_on`);
      }
    }
    if (rule.chance) chanceBased = true;
    for (const a of rule.actions ?? []) {
      f.verbs.add(a.verb);
      if (a.actor) f.actors.add(a.actor);
      if (a.target) f.targets.add(a.target);
      if (a.flow) f.flows.add(a.flow);
      for (const q of a.qualifiers ?? []) f.qualifiers.add(q);
      const inter = VERB_INTERACTION[a.verb];
      for (const s of a.statuses ?? []) {
        f.statusInteractions.add(`${s}|${inter ? inter(s) : 'interacts'}`);
      }
      const m = a.magnitude;
      if (m) {
        if (m.tier) f.tiers.add(m.tier);
        if (m.scaleStat) f.scaleStats.add(m.scaleStat);
        if (m.scaleRef) f.scaleRefs.add(m.scaleRef);
        if (m.perRank) perRank = true;
      }
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(f)) if (v.size) out[k] = [...v].sort();
  if (chanceBased) out.chanceBased = true;
  if (perRank) out.perRank = true;
  if (ann.flags?.stacks === false) out.noStack = true;
  if (ann.flags?.unmodeled) out.unmodeled = true;
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
      entry.facets = deriveFacets(ann);
      entry.rules = ann.rules;
      if (ann.flags) entry.flags = ann.flags;
      if (ann.notes) entry.notes = ann.notes;
    }
    records.push(entry);
  }
}

const index = {
  generated: new Date().toISOString(),
  schemaVersion: 2,
  statuses: lex.statuses.map(s => ({ name: s.name, kind: s.kind })),
  counts: { total: records.length, tagged: records.filter(r => r.rules).length },
  records,
};
mkdirSync('web/public', { recursive: true });
const json = JSON.stringify(index);
writeFileSync('web/public/index.json', json);
console.log(`index: ${records.length} records (${index.counts.tagged} tagged), ${(json.length / 1024).toFixed(0)} KB`);
