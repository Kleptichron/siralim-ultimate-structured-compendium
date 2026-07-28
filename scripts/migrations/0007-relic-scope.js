// Migration v6 -> v7 (2026-07-28, user correction during perks tagging).
// Relics are battle entities that take their own actions — modeling
// "this relic Attacks" as actor holder + params.byRelic conflated the relic
// with its bearer. New first-class scope 'relic' (valid only in relic
// records):
//   - triggers with params.byRelic  -> subject 'relic'
//   - actions  with params.byRelic  -> actor 'relic'
//   - whisper r80 ("This relic has additional Attack") -> target 'relic'
// params.byRelicOrBearer stays a trigger param (genuinely either source);
// params.includesRelic stays on "relic and bearer" modifiers.
// Run once from repo root: node scripts/migrations/0007-relic-scope.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const dropParam = (obj, key) => {
  delete obj.params[key];
  if (Object.keys(obj.params).length === 0) delete obj.params;
};

let migrated = 0, triggers = 0, actors = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 6) continue;
    for (const rule of ann.rules ?? []) {
      const t = rule.trigger;
      if (t?.params?.byRelic === true) {
        t.subject = 'relic';
        dropParam(t, 'byRelic');
        triggers++;
      }
      for (const a of rule.actions ?? []) {
        if (a.params?.byRelic !== true) continue;
        if (ann.id === 'relic:whisper:r80') {
          a.target = 'relic';           // the relic's own Attack stat
          delete a.params.appliesTo;
        } else {
          a.actor = 'relic';
        }
        dropParam(a, 'byRelic');
        actors++;
      }
    }
    ann.schemaVersion = 7;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v7 (${triggers} trigger subjects, ${actors} actions moved to scope 'relic')`);
