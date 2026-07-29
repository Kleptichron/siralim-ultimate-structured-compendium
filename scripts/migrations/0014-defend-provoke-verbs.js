// Migration v12 -> v13 (2026-07-29).
//
// battle_action becomes two real verbs, `defend` and `provoke`.
//
// v9 introduced battle_action to unify Defend (then verb `other`) with Provoke
// (then `redirect_target`), which was the right call at the time — but it put
// WHICH action it was into params.action, and params are display-only. Nothing
// facets them, so "what provokes?" had no answer: you could filter the 44
// battle_action records and then read each card. The same escape hatch also
// collected four compound "defend or provoke" values, the trap that hides a
// searchable fact inside a string.
//
// Compound values split into two actions in the same rule, since the effect
// genuinely does both. params.mode 'remove' is preserved: it marks the effects
// that STOP a creature defending or provoking ("no longer Defending"), which is
// distinct from prevent_action's "cannot Provoke".
//
// Run once from repo root: node scripts/migrations/0014-defend-provoke-verbs.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const verbFor = value => (value === 'defend' ? 'defend' : 'provoke');

let migrated = 0, converted = 0, split = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 12) continue;

    for (const rule of ann.rules ?? []) {
      if (!rule.actions) continue;
      const out = [];
      for (const a of rule.actions) {
        if (a.verb !== 'battle_action') { out.push(a); continue; }
        const value = a.params?.action ?? '';
        const both = /defend/i.test(value) && /provoke/i.test(value);
        const targets = both ? ['defend', 'provoke'] : [verbFor(value)];
        for (const verb of targets) {
          const copy = structuredClone(a);
          copy.verb = verb;
          delete copy.params.action; // the verb now carries it
          if (Object.keys(copy.params).length === 0) delete copy.params;
          out.push(copy);
        }
        converted++;
        if (both) split++;
      }
      rule.actions = out;
    }
    ann.schemaVersion = 13;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v13`);
console.log(`  battle_action actions converted: ${converted} (of which ${split} split into defend + provoke)`);
