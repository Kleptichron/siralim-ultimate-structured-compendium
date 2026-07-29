// Migration v10 -> v11 (2026-07-28, surfaced by the audit other-watch).
// Standing rule: recurring 'other' families become real enum members.
//
// 1. trigger 'after_status_effect' — the {event+status} family hit 8 uses:
//    "after their Bomb detonates", "after a creature is damaged or healed by
//    Burning", "after it deals damage as a result of Blighted", "after it
//    breaks free from Snared". These all fire when a STATUS's own payload
//    resolves, which is not the same event as the victim taking damage
//    (after_damaged) — and some of them fire for a third party entirely.
// 2. The Retribution / Celerity perk events retag onto the EXISTING
//    after_effect_activates trigger (params.what) rather than a new type —
//    a named effect firing is exactly what that trigger already means.
// Run once from repo root: node scripts/migrations/0011-status-effect-trigger.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const NAMED_EFFECT = /Retribution|Celerity/i;

let migrated = 0, statusEffects = 0, effectActivates = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 10) continue;

    for (const rule of ann.rules ?? []) {
      const t = rule.trigger;
      if (t?.type !== 'other') continue;
      const event = t.params?.event;
      if (!event) continue;

      if (t.params.status !== undefined) {
        t.type = 'after_status_effect';
        statusEffects++;
      } else if (NAMED_EFFECT.test(event)) {
        t.type = 'after_effect_activates';
        t.params = { ...t.params, what: event };
        delete t.params.event;
        effectActivates++;
      }
    }
    ann.schemaVersion = 11;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v11`);
console.log(`  after_status_effect: ${statusEffects} | after_effect_activates retags: ${effectActivates}`);
