// Migration v8 -> v9 (2026-07-28, surfaced by the new audit other-watch).
// Standing rule: recurring 'other' families become real enum members.
//
// 1. verb 'battle_action' (params.action: defend|provoke) — Defend was verb
//    'other' (16 uses) while Provoke was 'redirect_target' (15 uses); the two
//    paired battle actions were modeled two different ways. Both move here.
//    redirect_target keeps only genuine targeting redirection (6 uses).
// 2. trigger 'after_effect_activates' (params.what) — 10 uses.
// 3. triggers 'after_minion_gained' / 'after_minion_lost' — 11 uses.
// 4. Damage-threshold events retag to the EXISTING after_damaged trigger +
//    damage_threshold condition (4 uses) — no new type needed.
// 5. verb 'spawn_modifier' — overworld spawn/encounter rates (7 uses).
// Run once from repo root: node scripts/migrations/0009-battle-action-and-event-triggers.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const EFFECT_EVENT = /effects activate|effects activated|Trick Slots activate|Spell Slots activate|debuff activates|innate traits activate/i;
const GAIN_EVENT = /gains a minion|gains Zombies|gain an Infusion/i;
const LOSS_EVENT = /go away|goes away|sacrifices a Lesser Demon/i;
const SPAWN_WHAT = /spawn chance|spawn rate|inhabited by/i;
// event -> the damage_threshold condition params it becomes
const DAMAGE_THRESHOLD = {
  'would receive fatal damage': { exceeds: 'remaining Health (fatal)', timing: 'would' },
  'would take fatal damage': { exceeds: 'remaining Health (fatal)', timing: 'would' },
  'takes damage exceeding 100% of Maximum Health': { exceeds: '100% of Maximum Health' },
  'takes damage exceeding 25% of its Maximum Health': { exceeds: '25% of Maximum Health' },
};

const dropKeys = (obj, ...keys) => {
  for (const k of keys) delete obj.params?.[k];
  if (obj.params && Object.keys(obj.params).length === 0) delete obj.params;
};

let migrated = 0, actions = 0, triggers = 0, spawns = 0, thresholds = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 8) continue;

    for (const rule of ann.rules ?? []) {
      const t = rule.trigger;
      const event = t?.type === 'other' ? t.params?.event : null;
      if (event) {
        if (EFFECT_EVENT.test(event)) {
          t.type = 'after_effect_activates';
          t.params = { ...t.params, what: event };
          delete t.params.event;
          triggers++;
        } else if (GAIN_EVENT.test(event)) {
          t.type = 'after_minion_gained';
          t.params = { ...t.params, what: event };
          delete t.params.event;
          triggers++;
        } else if (LOSS_EVENT.test(event)) {
          t.type = 'after_minion_lost';
          t.params = { ...t.params, what: event };
          delete t.params.event;
          triggers++;
        } else if (DAMAGE_THRESHOLD[event]) {
          t.type = 'after_damaged';
          dropKeys(t, 'event');
          rule.conditions = [
            { type: 'damage_threshold', who: t.subject ?? 'holder', params: DAMAGE_THRESHOLD[event] },
            ...(rule.conditions ?? []),
          ];
          thresholds++;
        }
      }

      for (const a of rule.actions ?? []) {
        // Defend (verb other) and Provoke (redirect_target) -> battle_action
        if (a.verb === 'other' && typeof a.params?.action === 'string' && /defend/i.test(a.params.action)) {
          const alsoProvoke = /provoke/i.test(a.params.action);
          const note = a.params.action;
          a.verb = 'battle_action';
          a.params = { ...a.params, action: alsoProvoke ? 'defend or provoke' : 'defend', text: note };
          actions++;
        } else if (a.verb === 'redirect_target' && /provoke/i.test(a.params?.action ?? '')) {
          a.verb = 'battle_action';
          a.params = { ...a.params, action: 'provoke' };
          actions++;
        } else if (a.verb === 'other' && SPAWN_WHAT.test(a.params?.what ?? '')) {
          a.verb = 'spawn_modifier';
          spawns++;
        }
      }
    }
    ann.schemaVersion = 9;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v9`);
console.log(`  battle_action: ${actions} | event triggers: ${triggers} | damage-threshold retags: ${thresholds} | spawn_modifier: ${spawns}`);
