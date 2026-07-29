// Data correction (no schema change), 2026-07-29.
//
// Six records buried a SECOND TRIGGER TYPE in trigger params.alsoAfter:
// "After this creature defends or provokes" was tagged after_defend with
// "provoking" as display-only text. Filtering after_provoke missed them, and
// the card showed only half the trigger. Eleven records with the same phrasing
// already used the correct two-rule shape (click-click-boom, rattle, scraaaw …)
// — these were simply the outliers.
//
// Also fixes trait:hearty-appetite, whose trigger params.stats was the compound
// string "Attack, Intelligence, Defense or Speed". Compound strings in a
// faceted key are the trap the conventions doc calls out: it produced no stat
// interactions at all, so "Attack × triggers off" could never find it.
//
// Run once from repo root: node scripts/migrations/0013-split-disjunct-triggers.js
import { readFileSync, writeFileSync } from 'node:fs';

// id -> the full list of trigger types the text describes
const SPLIT = {
  'traits/stampede': ['after_attack', 'after_defend', 'after_provoke'],
  'traits/stoke': ['after_defend', 'after_provoke'],
  'traits/surge-of-vitality': ['after_attack', 'after_attacked'],
  'traits/vitja-s-surprise': ['after_death', 'after_resurrected'],
  'traits/wallflower': ['after_defend', 'after_provoke'],
  'traits/war-dance': ['after_defend', 'after_provoke'],
};

let split = 0, rulesAdded = 0;
for (const [path, types] of Object.entries(SPLIT)) {
  const file = `data/annotations/${path}.json`;
  const ann = JSON.parse(readFileSync(file, 'utf8'));
  const rules = [];
  for (const rule of ann.rules) {
    if (!rule.trigger?.params?.alsoAfter) { rules.push(rule); continue; }
    for (const type of types) {
      const copy = structuredClone(rule);
      copy.trigger.type = type;
      delete copy.trigger.params.alsoAfter;
      if (Object.keys(copy.trigger.params).length === 0) delete copy.trigger.params;
      rules.push(copy);
    }
    rulesAdded += types.length - 1;
    split++;
  }
  ann.rules = rules;
  writeFileSync(file, JSON.stringify(ann, null, 2) + '\n');
}

{
  const file = 'data/annotations/traits/hearty-appetite.json';
  const ann = JSON.parse(readFileSync(file, 'utf8'));
  for (const rule of ann.rules) {
    if (typeof rule.trigger?.params?.stats !== 'string') continue;
    rule.trigger.params.stats = ['Attack', 'Intelligence', 'Defense', 'Speed'];
  }
  writeFileSync(file, JSON.stringify(ann, null, 2) + '\n');
}

console.log(`split ${split} disjunct triggers into ${rulesAdded} extra rules`);
console.log('normalised trait:hearty-appetite trigger params.stats to an array');
