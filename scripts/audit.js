// Distribution + sampling report for human review sessions.
// Usage: npm run audit [-- --sample 15] [-- --ids trait:quell,spell:boulder]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { SOURCE_DIRS } from './lib/ids.js';

const sampleN = (() => {
  const i = process.argv.indexOf('--sample');
  return i > -1 ? Number(process.argv[i + 1]) : 10;
})();
const onlyIds = (() => {
  const i = process.argv.indexOf('--ids');
  return i > -1 ? new Set(process.argv[i + 1].split(',')) : null;
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

// --- review sample: every searchable field must be visible ---
const renderCond = c => {
  const p = c.params ?? {};
  const detail = p.status ?? p.statuses?.join('|') ?? p.class ?? p.race
    ?? (c.type === 'team_composition' ? `${p.race ?? p.class ?? '?'}:${p.scope ?? p.inParty ?? ''}` : null)
    ?? (Object.keys(p).length ? JSON.stringify(p) : null);
  return `${c.type}${c.who ? `[${c.who}]` : ''}${detail ? `(${detail})` : ''}`;
};
const renderMag = m => {
  if (!m) return '';
  const bits = [];
  if (m.tier) bits.push(`~${m.tier}~`);
  if (m.amountPct !== undefined) bits.push(`${m.amountPct}%`);
  if (m.amountFlat !== undefined) bits.push(String(m.amountFlat));
  if (m.direction) bits.push(m.direction === 'up' ? 'UP' : 'DOWN');
  if (m.scaleStat) bits.push(`=${m.scalePct ?? '?'}% of ${m.scaleStat}`);
  if (m.scaleRef) bits.push(`=${m.scalePct ?? '?'}% of <${m.scaleRef}>`);
  if (m.per) bits.push(`per ${m.per}`);
  if (m.perRank) bits.push(`per-rank ${m.perRank.per ?? '?'} (max ${m.perRank.maxTotal ?? '?'})`);
  if (m.cap !== undefined) bits.push(`cap ${m.cap}`);
  return bits.length ? ' ' + bits.join(' ') : '';
};
const renderAction = a => {
  const head = `${a.verb}${a.actor ? `@${a.actor}` : ''}${a.target ? '->' + a.target : ''}`;
  const tags = [
    a.statuses?.length ? `[${a.statuses.join(',')}]` : '',
    a.statusKind ? `[${a.statusKind}s]` : '',
    a.stats?.length ? `{${a.stats.join(',')}}` : '',
    a.flow ? `flow:${a.flow}` : '',
    a.qualifiers?.length ? `<${a.qualifiers.join(',')}>` : '',
  ].filter(Boolean).join(' ');
  const extra = a.params && Object.keys(a.params).length ? `  …${JSON.stringify(a.params)}` : '';
  return `${head}${tags ? ' ' + tags : ''}${renderMag(a.magnitude)}${extra}`;
};
const renderRule = r => {
  const cond = (r.conditions ?? []).map(renderCond).join(' & ');
  const trigP = r.trigger?.params && Object.keys(r.trigger.params).length
    ? ` …${JSON.stringify(r.trigger.params)}` : '';
  const head = `WHEN ${r.trigger?.type}${r.trigger?.subject ? `(${r.trigger.subject})` : ''}${trigP}`
    + `${cond ? `  IF ${cond}` : ''}${r.chance ? `  CHANCE ${r.chance}%` : ''}${r.modifiesDefault ? '  [replaces default]' : ''}`;
  const acts = (r.actions ?? []).map(a => `    DO ${renderAction(a)}`);
  return [head, ...acts].join('\n  ');
};
const pool = onlyIds ? anns.filter(a => onlyIds.has(a.id)) : [...anns].sort(() => Math.random() - 0.5).slice(0, sampleN);
console.log(onlyIds ? `--- ${pool.length} requested record(s) ---` : `--- random sample of ${sampleN} for review ---`);
for (const a of pool) {
  const rec = byId.get(a.id);
  console.log(`\n${a.id}  [${a.provenance}]`);
  console.log(`  "${rec?.text}"`);
  for (const r of a.rules ?? []) console.log(`  ${renderRule(r)}`);
  if (a.flags) console.log(`  flags: ${JSON.stringify(a.flags)}`);
  if (a.amplifies) console.log(`  amplifies: ${a.amplifies.join(', ')} (facets inherited)`);
  if (a.notes) console.log(`  notes: ${a.notes}`);
}
