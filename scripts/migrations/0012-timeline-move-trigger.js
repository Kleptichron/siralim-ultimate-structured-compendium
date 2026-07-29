// Migration v11 -> v12 (2026-07-28, the 100% audit gate).
//
// trigger 'after_timeline_move' — 7 uses sat in the other-watch {event} family:
// "after this creature is moved to the top of the Timeline" (Vlora trio),
// "is sent to the bottom", "is forcibly moved on the Timeline", "creatures of
// your most common race move to the top". This is the same asymmetry v9 fixed
// for Defend/Provoke: the timeline_move VERB has 69 uses, so the corpus could
// answer "what moves the Timeline?" but not "what fires when I'm moved?".
// params.to (top|bottom|unspecified) and params.forced carry the nuance.
// Run once from repo root: node scripts/migrations/0012-timeline-move-trigger.js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const TIMELINE_EVENT = /Timeline/i;

let migrated = 0, retagged = 0;
for (const dir of readdirSync('data/annotations')) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (!f.endsWith('.json')) continue;
    const path = `data/annotations/${dir}/${f}`;
    const ann = JSON.parse(readFileSync(path, 'utf8'));
    if (ann.schemaVersion !== 11) continue;

    for (const rule of ann.rules ?? []) {
      const t = rule.trigger;
      if (t?.type !== 'other') continue;
      const event = t.params?.event;
      if (!event || !TIMELINE_EVENT.test(event)) continue;

      const to = /top/i.test(event) ? 'top' : /bottom/i.test(event) ? 'bottom' : undefined;
      t.type = 'after_timeline_move';
      t.params = { ...t.params, ...(to ? { to } : {}), ...(/forcibly|sent/i.test(event) ? { forced: true } : {}) };
      retagged++;
    }
    ann.schemaVersion = 12;
    writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
    migrated++;
  }
}
console.log(`migrated ${migrated} annotations to schema v12`);
console.log(`  after_timeline_move: ${retagged}`);
