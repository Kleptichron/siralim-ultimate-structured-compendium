// Migration v4 -> v5 (2026-07-28, 25% audit-gate user review).
// 1. Verb 'crit_modifier' renamed 'crit_chance_modifier' — the old name read
//    as covering crit damage too (that stays damage_modifier + criticalOnly).
// 2. New annotation field 'amplifies: [ids]' replaces flags.unmodeled on
//    card-set meta-records ("Doubles the potency of these effects"): the
//    record points at the tier 1-2 siblings it amplifies and the search index
//    inherits their facets, so meta-records answer the same queries.
// Run once from repo root: node scripts/migrations/0005-crit-rename-amplifies.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// The eleven "…these effects" meta-records, all card:<family>:3 amplifying
// tiers 1-2 of their own set.
const META_RECORDS = new Set([
  'card:automaton:3', 'card:carbuncle:3', 'card:cruncher:3', 'card:crusader:3',
  'card:diabolic-horde:3', 'card:grimore:3', 'card:hemomancer:3', 'card:mummy:3',
  'card:revenant:3', 'card:shapeshifter:3', 'card:wolpertinger:3',
]);

let migrated = 0, renamed = 0, converted = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 4) continue;
    for (const rule of ann.rules ?? []) {
      for (const a of rule.actions ?? []) {
        if (a.verb === 'crit_modifier') { a.verb = 'crit_chance_modifier'; renamed++; }
      }
    }
    if (META_RECORDS.has(ann.id)) {
      const family = ann.id.split(':')[1];
      ann.amplifies = [`card:${family}:1`, `card:${family}:2`];
      delete ann.flags.unmodeled;
      if (Object.keys(ann.flags).length === 0) delete ann.flags;
      converted++;
    }
    ann.schemaVersion = 5;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v5 (${renamed} verbs renamed, ${converted} meta-records converted to amplifies)`);
