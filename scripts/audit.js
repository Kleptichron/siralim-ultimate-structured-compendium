// Distribution + sampling report for human review sessions.
// Usage: npm run audit [-- --sample 15]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { SOURCE_DIRS } from './lib/ids.js';

const sampleN = (() => {
  const i = process.argv.indexOf('--sample');
  return i > -1 ? Number(process.argv[i + 1]) : 10;
})();

const byId = new Map();
for (const src of Object.values(SOURCE_DIRS)) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) byId.set(r.id, r);
}
const anns = [];
for (const dir of existsSync('data/annotations') ? readdirSync('data/annotations') : []) {
  for (const f of readdirSync(`data/annotations/${dir}`)) {
    if (f.endsWith('.json')) anns.push(JSON.parse(readFileSync(`data/annotations/${dir}/${f}`, 'utf8')));
  }
}
if (anns.length === 0) { console.log('no annotations yet'); process.exit(0); }

// --- enum usage ---
const hist = { trigger: {}, verb: {}, condition: {}, provenance: {} };
const bump = (h, k) => (h[k] = (h[k] ?? 0) + 1);
for (const a of anns) {
  bump(hist.provenance, a.provenance);
  for (const r of a.rules ?? []) {
    bump(hist.trigger, r.trigger?.type);
    for (const c of r.conditions ?? []) bump(hist.condition, c.type);
    for (const act of r.actions ?? []) bump(hist.verb, act.verb);
  }
}
console.log(`annotations: ${anns.length}\n`);
for (const [name, h] of Object.entries(hist)) {
  const total = Object.values(h).reduce((a, b) => a + b, 0);
  console.log(`${name} usage:`);
  for (const [k, v] of Object.entries(h).sort((a, b) => b[1] - a[1])) {
    const pct = (100 * v / total).toFixed(1);
    const alarm = k === 'other' && v / total > 0.03 ? '  <-- OVER 3% QUOTA: extend the enum' : '';
    console.log(`  ${String(v).padStart(5)}  ${pct.padStart(5)}%  ${k}${alarm}`);
  }
  console.log();
}

// --- review sample ---
const renderRule = r => {
  const cond = (r.conditions ?? []).map(c => c.type).join(',');
  const acts = (r.actions ?? []).map(a =>
    `${a.verb}${a.target ? '->' + a.target : ''}${a.statuses ? ' [' + a.statuses.join(',') + ']' : ''}${a.stats ? ' {' + a.stats.join(',') + '}' : ''}`
  ).join('; ');
  return `WHEN ${r.trigger?.type}${r.trigger?.subject ? '(' + r.trigger.subject + ')' : ''}${cond ? ' IF ' + cond : ''}${r.chance ? ` (${r.chance}%)` : ''} DO ${acts}`;
};
console.log(`--- random sample of ${sampleN} for review ---`);
const shuffled = [...anns].sort(() => Math.random() - 0.5).slice(0, sampleN);
for (const a of shuffled) {
  const rec = byId.get(a.id);
  console.log(`\n${a.id}  [${a.provenance}]`);
  console.log(`  "${rec?.text}"`);
  for (const r of a.rules ?? []) console.log(`  ${renderRule(r)}`);
  if (a.flags) console.log(`  flags: ${JSON.stringify(a.flags)}`);
}
