// Migration v9 -> v10 (2026-07-28, other-watch: trait-potency family hit 10).
// New verb 'trait_modifier' — effects that change how traits THEMSELVES behave
// (potency, strength, growth rate, removed downsides). Distinct from:
//   grant_ability      = gives a creature a trait
//   activation_modifier = makes trait effects fire extra times
// params.property names the aspect changed.
// Personality benefit (trait:false-bravado) is a different creature system and
// stays verb 'other'.
// Run once from repo root: node scripts/migrations/0010-trait-modifier.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// id -> [ruleIdx, actionIdx, property]
const RETAGS = {
  'trait:commanding-presence': [[0, 0, 'potency']],
  'trait:master-of-arbiters': [[0, 0, 'potency']],
  'trait:master-of-automatons': [[0, 0, 'strength']],
  'trait:master-of-bards': [[0, 0, 'Song trait effectiveness']],
  'trait:master-of-carbuncles': [[0, 0, 'growth rate']],
  'trait:master-of-clockworks': [[0, 0, 'potency']],
  'trait:master-of-devils': [[0, 0, 'additional damage granted by innate traits']],
  'trait:master-of-forsaken': [[0, 0, 'downsides removed']],
  'trait:master-of-krakens': [[0, 0, 'stat boosts from innate traits']],
};

let migrated = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 9) continue;
    for (const [ri, ai, property] of RETAGS[ann.id] ?? []) {
      const a = ann.rules[ri].actions[ai];
      if (a.verb !== 'other') throw new Error(`${ann.id}: expected 'other' at rules[${ri}].actions[${ai}], found '${a.verb}'`);
      a.verb = 'trait_modifier';
      const { what, effect, ...rest } = a.params ?? {};
      a.params = { ...rest, property };
      retagged++;
    }
    ann.schemaVersion = 10;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v10 (${retagged} actions retagged to trait_modifier)`);
