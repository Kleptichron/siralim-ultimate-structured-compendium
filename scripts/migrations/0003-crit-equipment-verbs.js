// Migration v2 -> v3 (2026-07-28, first bulk cards batch audit).
// Additive verb extension — no scope/field semantics change:
// 1. New verb 'crit_modifier': critical-hit CHANCE changes. Crit damage
//    AMOUNT stays damage_modifier + params.criticalOnly (hell-knight precedent).
// 2. New verb 'equipment_modifier': amplifiers of carried gear (artifact
//    properties, Nether Stones); params.equipment names the gear.
// Retags the 'other' actions that motivated the extension; the two genuinely
// unclassifiable 'other' uses (spell:afterlife, trait:master-of-amphisbaenas)
// are untouched. Machine drafts are bumped in place (content unaffected by an
// additive change; extract.js stamps v3 on its next run anyway).
// Run once from repo root: node scripts/migrations/0003-crit-equipment-verbs.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// id -> [ruleIndex, actionIndex, patch]; patch replaces verb/params wholesale
// and the now-redundant "no verb for this" notes are dropped.
const RETAGS = {
  'card:asura:1': [[0, 0, { verb: 'crit_modifier' }]],
  'card:beacon:1': [[0, 0, { verb: 'equipment_modifier', params: { equipment: 'artifact', property: 'Strength' } }]],
  'card:beacon:2': [[0, 0, { verb: 'equipment_modifier', params: { equipment: 'artifact', property: 'Strength' } }]],
  'card:beacon:3': [[0, 0, { verb: 'equipment_modifier', params: { equipment: 'artifact', property: 'Strength' } }]],
  'card:chimera:1': [[0, 0, { verb: 'equipment_modifier', params: { equipment: 'nether_stone' } }]],
  'card:chimera:2': [[0, 0, { verb: 'equipment_modifier', params: { equipment: 'nether_stone' } }]],
  'card:chimera:3': [[0, 0, { verb: 'equipment_modifier', params: { equipment: 'nether_stone' } }]],
};

let migrated = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 2) continue;
    for (const [ri, ai, patch] of RETAGS[ann.id] ?? []) {
      const a = ann.rules[ri].actions[ai];
      if (a.verb !== 'other') throw new Error(`${ann.id}: expected 'other' at rules[${ri}].actions[${ai}], found '${a.verb}'`);
      a.verb = patch.verb;
      if (patch.params) a.params = patch.params; else delete a.params;
      delete ann.notes;
      retagged++;
    }
    ann.schemaVersion = 3;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v3 (${retagged} actions retagged)`);
