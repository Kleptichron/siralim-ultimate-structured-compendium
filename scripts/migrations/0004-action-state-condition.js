// Migration v3 -> v4 (2026-07-28, batch-2 audit tripped the condition quota).
// Additive condition extension: new type 'action_state' for "while they're
// Provoking/Defending" — the creature is in an action-derived battle state.
// Retags every {type:'other', params:{while:...}} condition (boastful-protector
// from the pilot, doom-fortress 1-3 from cards batch 2). Machine drafts are
// bumped in place, as in 0003.
// Run once from repo root: node scripts/migrations/0004-action-state-condition.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

let migrated = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 3) continue;
    for (const rule of ann.rules ?? []) {
      for (const c of rule.conditions ?? []) {
        if (c.type === 'other' && typeof c.params?.while === 'string') {
          c.type = 'action_state';
          c.params = { state: c.params.while };
          retagged++;
        }
      }
    }
    ann.schemaVersion = 4;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v4 (${retagged} conditions retagged)`);
