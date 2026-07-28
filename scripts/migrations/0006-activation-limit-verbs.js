// Migration v5 -> v6 (2026-07-28, user ruling at the 25% gate).
// Breaks the two remaining verb-'other' families into proper verbs:
// 1. 'activation_modifier' — effects/traits activate extra times or on demand
//    (Fable's on-X relics, Master of Amphisbaenas, doomguard:3, Afterlife).
// 2. 'limit_modifier' — rule caps (phoenix:3 resurrection limit,
//    thousand-needles:r60 per-turn action cap).
// Retags replace the whole action; stale "no verb models this" notes drop.
// Run once from repo root: node scripts/migrations/0006-activation-limit-verbs.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const plus1 = { amountFlat: 1, direction: 'up' };
// id -> [ruleIdx, actionIdx, replacementAction, dropNotes]
const RETAGS = {
  'relic:fable:r10': [[0, 0, {
    verb: 'activation_modifier', target: 'holder', magnitude: plus1,
    params: { what: 'on-attack or on-cast effects', basis: 'higher of Attack or Intelligence' },
  }, true]],
  'relic:fable:r30': [[0, 0, {
    verb: 'activation_modifier', target: 'holder', magnitude: plus1,
    params: { what: 'on-defend or on-provoke effects', basis: 'higher of Defense or Speed' },
  }, true]],
  'relic:fable:r50': [[0, 0, {
    verb: 'activation_modifier', target: 'holder', magnitude: plus1,
    params: { what: 'on-heal, on-debuff, and on-buff effects', includesRelic: true },
  }, true]],
  'relic:fable:r60': [[0, 0, {
    verb: 'activation_modifier', target: 'holder',
    magnitude: { ...plus1, scaleRef: 'other', per: '5 relic Attacks/Casts this battle' },
    params: { what: 'on-attack or on-cast effects' },
  }, true]],
  'relic:fable:r80': [[0, 0, {
    verb: 'activation_modifier', target: 'holder', magnitude: plus1,
    params: { what: 'on-resurrect and on-death effects' },
  }, true]],
  'trait:master-of-amphisbaenas': [[0, 0, {
    verb: 'activation_modifier', target: 'allies', magnitude: plus1,
    params: { what: 'innate traits' },
  }, false]],
  'card:doomguard:3': [[0, 0, {
    verb: 'activation_modifier', target: 'trigger_subject', magnitude: plus1,
    params: { what: 'after-Provoke effects' },
  }, true]],
  'spell:afterlife': [[0, 0, {
    verb: 'activation_modifier', target: 'allies',
    params: { what: 'on-resurrect and on-death effects', mode: 'activate now' },
  }, false]],
  'card:phoenix:3': [[0, 0, {
    verb: 'limit_modifier', target: 'allies',
    magnitude: { amountFlat: 15 }, params: { what: 'resurrections per battle' },
  }, true]],
  'relic:thousand-needles:r60': [[0, 0, {
    verb: 'limit_modifier', target: 'holder',
    magnitude: { amountFlat: 20 }, params: { what: 'Attacks/Casts per turn', includesRelic: true },
  }, true]],
};

let migrated = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 5) continue;
    for (const [ri, ai, replacement, dropNotes] of RETAGS[ann.id] ?? []) {
      const a = ann.rules[ri].actions[ai];
      if (a.verb !== 'other') throw new Error(`${ann.id}: expected 'other' at rules[${ri}].actions[${ai}], found '${a.verb}'`);
      ann.rules[ri].actions[ai] = replacement;
      if (dropNotes) delete ann.notes;
      retagged++;
    }
    ann.schemaVersion = 6;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v6 (${retagged} actions retagged)`);
