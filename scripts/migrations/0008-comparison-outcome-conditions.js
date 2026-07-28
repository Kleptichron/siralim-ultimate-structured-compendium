// Migration v7 -> v8 (2026-07-28, 50% gate ruling: "get them out of other
// once they're that common").
// New condition types:
//   'comparison' — dynamic property checks (class equality, party position)
//   'outcome'    — riders on a prior action's result (kill succeeded/failed,
//                  debuff removed)
// Composition requirements (demon sets, Infusion match) fold into the
// existing 'count_comparison'. Condition 'other' drops to zero.
// Run once from repo root: node scripts/migrations/0008-comparison-outcome-conditions.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// id -> [ruleIdx, condIdx, replacementCondition]
const RETAGS = {
  'spell:cannibalize': [[1, 0, { type: 'comparison', params: { what: 'class', of: 'target', equals: "the caster's class" } }]],
  'spell:powered-blast': [[1, 0, { type: 'comparison', params: { what: 'class', of: 'target', equals: "the caster's class" } }]],
  'perk:grovetender:deep-roots': [
    [0, 0, { type: 'comparison', params: { what: 'party position', equals: 'first' } }],
    [1, 0, { type: 'comparison', params: { what: 'party position', equals: 'sixth' } }],
  ],
  'spell:heat-beam': [[1, 0, { type: 'outcome', params: { result: 'the kill failed (target cannot be killed)' } }]],
  'spell:internal-combustion': [[1, 0, { type: 'outcome', params: { result: 'this spell killed the target' } }]],
  'spell:nutrition': [[1, 0, { type: 'outcome', params: { result: 'a debuff was successfully removed' } }]],
  'spell:spontaneous-combustion': [[1, 0, { type: 'outcome', params: { result: 'the kill succeeded' } }]],
  'perk:demonologist:summon-lucifer': [[0, 0, { type: 'count_comparison', params: { what: 'of Asmodeus, Beelzebub, Mammon, Leviathan, Belphegor held by the team', all: 5 } }]],
  'perk:demonologist:summon-satanachia': [[0, 0, { type: 'count_comparison', params: { what: 'of Asmodeus, Beelzebub, Mammon, Leviathan, Belphegor held by the team', all: 5 } }]],
  'perk:necromancer:four-horsemen': [[0, 0, { type: 'count_comparison', params: { what: 'of Conquest, Famine, Death, War held by the creature', all: 4 } }]],
  'perk:spellweaver:prismatic-barrier': [[0, 0, { type: 'count_comparison', params: { what: "Infusions matching the creature's class", atLeast: 1 } }]],
};

let migrated = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 7) continue;
    for (const [ri, ci, replacement] of RETAGS[ann.id] ?? []) {
      const c = ann.rules[ri].conditions[ci];
      if (c.type !== 'other') throw new Error(`${ann.id}: expected 'other' at rules[${ri}].conditions[${ci}], found '${c.type}'`);
      ann.rules[ri].conditions[ci] = replacement;
      retagged++;
    }
    ann.schemaVersion = 8;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v8 (${retagged} conditions retagged)`);
