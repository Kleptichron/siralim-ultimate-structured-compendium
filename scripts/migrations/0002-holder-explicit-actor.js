// Migration v1 -> v2 (2026-07-06, actor-semantics review).
// 1. Scope 'self' renamed 'holder' (the entity the record's effect is attached
//    to: trait holder, relic bearer, the minion itself). Applies to
//    trigger.subject, condition.who, action.actor, action.target.
// 2. Omitted action.actor no longer defaults to the holder — omitted now means
//    "ambient, no performer". Verbs with an intrinsic performer (attack, cast)
//    require an explicit actor; this migration adds the correct one to pilot
//    records that relied on the old default.
// Machine drafts are skipped (extract.js regenerates them).
// Run once from repo root: node scripts/migrations/0002-holder-explicit-actor.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// id -> [ruleIndex, actionIndex, actor] for attack/cast actions that had no actor
const ACTOR_PATCHES = {
  'trait:atmosphere': [[0, 0, 'holder']],
  'trait:bounce': [[0, 0, 'holder']],
  'trait:ambush': [[0, 0, 'holder']],
  'minion:animated-gem': [[0, 0, 'holder']],
  'minion:amalgamation': [[0, 0, 'holder']], // deal_damage performed by the minion
};

const renameScope = v => (v === 'self' ? 'holder' : v);

let migrated = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.provenance === 'machine') continue;
    if (ann.schemaVersion !== 1) continue;
    for (const rule of ann.rules ?? []) {
      if (rule.trigger?.subject) rule.trigger.subject = renameScope(rule.trigger.subject);
      for (const c of rule.conditions ?? []) if (c.who) c.who = renameScope(c.who);
      for (const a of rule.actions ?? []) {
        if (a.actor) a.actor = renameScope(a.actor);
        if (a.target) a.target = renameScope(a.target);
      }
    }
    for (const [ri, ai, actor] of ACTOR_PATCHES[ann.id] ?? []) {
      ann.rules[ri].actions[ai].actor = actor;
    }
    ann.schemaVersion = 2;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v2`);
