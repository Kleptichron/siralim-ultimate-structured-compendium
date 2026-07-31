// Migration v13 -> v14 (2026-07-30, prompted by the Hierarchy card).
//
// scaleRef 'timeline_position' — 9 actions scale off where creatures sit on
// the Timeline and the corpus could not say so in one search: five said
// scaleRef 'other', Asskicker r80 said nothing, and three spells carried the
// whole rider in display-only params that no facet reads. Timeline
// manipulation is a build archetype, so "scales with timeline position"
// should be one query. magnitude.per keeps each rider's exact anchor
// (below it / above them / between the two).
//
// The pattern pass flips any magnitude whose per names the Timeline. Three
// spells need their rider restructured by hand first:
//   hierarchy  — "Each creature deals 25% more damage …" is its own sentence
//                about the attackers, so it becomes a damage_modifier action
//                (the Ancient Buffoonery shape), not a rider on the attack.
//   mind-flay, waterfall — "plus N% more for each …" boosts the spell's OWN
//                damage, so the rider joins the deal_damage magnitude beside
//                its tier. First tier+amountPct combo in the corpus; a
//                separate damage_modifier here would claim the target takes
//                more damage from everything, which the text does not say.
// Run once from repo root: node scripts/migrations/0016-timeline-position-scaleref.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const RETAGS = {
  'spell:hierarchy': ann => {
    const action = ann.rules[0].actions[0];
    delete action.params.bonusPct;
    delete action.params.per;
    ann.rules[0].actions.push({
      verb: 'damage_modifier',
      target: 'any',
      flow: 'dealt',
      magnitude: {
        amountPct: 25,
        direction: 'up',
        scaleRef: 'timeline_position',
        per: 'creature below it on the Timeline',
      },
    });
  },
  'spell:mind-flay': ann => moveRider(ann, 'creature between it and the caster on the Timeline'),
  'spell:waterfall': ann => moveRider(ann, 'creature above them on the Timeline'),
};

function moveRider(ann, per) {
  const action = ann.rules[0].actions[0];
  action.magnitude = {
    ...action.magnitude,
    amountPct: action.params.bonusPct,
    direction: 'up',
    scaleRef: 'timeline_position',
    per,
  };
  delete action.params.bonusPct;
  delete action.params.per;
  if (!Object.keys(action.params).length) delete action.params;
}

let migrated = 0, flipped = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 13) continue;

    if (RETAGS[ann.id]) { RETAGS[ann.id](ann); retagged++; }
    for (const rule of ann.rules ?? []) {
      for (const a of rule.actions ?? []) {
        const m = a.magnitude;
        if (!m?.per || !/timeline/i.test(m.per)) continue;
        if (m.scaleRef === undefined || m.scaleRef === 'other') { m.scaleRef = 'timeline_position'; flipped++; }
      }
    }
    ann.schemaVersion = 14;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v14`);
console.log(`  retagged spells: ${retagged}`);
console.log(`  scaleRef -> timeline_position: ${flipped}`);
