// Data correction (no schema change), 2026-07-29.
//
// Surfaced by promoting defend/provoke to real verbs: trait:dusty-struggle was
// the last record hiding trigger types in params.
//
//   "After this creature attacks, casts, defends, or provokes, it and its
//    adjacent allies are afflicted with a random debuff and have a 20% chance
//    to be sent to the top of the Timeline."
//
// Three faults in one record:
//   1. four trigger types collapsed into trigger `other` + params.event, so
//      none of after_attack / after_cast / after_defend / after_provoke found it
//   2. rule.chance 20 gated the WHOLE rule, but the text applies the 20% only to
//      the Timeline move — the debuff is unconditional
//   3. the Timeline move targeted the holder alone, though the text says "it and
//      its adjacent allies"
//
// Run once from repo root: node scripts/migrations/0015-dusty-struggle-disjunction.js
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'data/annotations/traits/dusty-struggle.json';
const ann = JSON.parse(readFileSync(file, 'utf8'));

const TRIGGERS = ['after_attack', 'after_cast', 'after_defend', 'after_provoke'];
const debuff = target => ({
  verb: 'apply_status', target, statusKind: 'debuff', qualifiers: ['random'],
});
const toTop = target => ({ verb: 'timeline_move', target, params: { to: 'top' } });

ann.rules = TRIGGERS.flatMap(type => [
  // unconditional half
  {
    trigger: { type, subject: 'holder' },
    actions: [debuff('holder'), debuff('adjacent_allies')],
  },
  // the 20% half
  {
    trigger: { type, subject: 'holder' },
    chance: 20,
    actions: [toTop('holder'), toTop('adjacent_allies')],
  },
]);
ann.notes = 'Will not activate if another creature in your party also has this trait.';

writeFileSync(file, JSON.stringify(ann, null, 2) + '\n');
console.log('rebuilt trait:dusty-struggle as', ann.rules.length, 'rules across', TRIGGERS.length, 'triggers');
