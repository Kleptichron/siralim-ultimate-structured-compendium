// The invariant suite. Exit 1 on any error; warnings are informational.
// Run from repo root: npm run validate
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { loadLexicon } from './lib/lexicon.js';
import { termRegex, templateKey } from './lib/normalize.js';
import { SOURCE_DIRS } from './lib/ids.js';
import { validateAnnotation, crossCheckStatuses } from './lib/schema.js';

const lex = loadLexicon();
const errors = [];
const warnings = [];

// --- load normalized ---
const byId = new Map();
for (const src of Object.values(SOURCE_DIRS)) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) byId.set(r.id, r);
}

// --- load annotations + overrides (override replaces annotation wholesale) ---
function loadDir(base) {
  const out = new Map();
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    const full = `${base}/${dir}`;
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.json')) continue;
      try {
        const ann = JSON.parse(readFileSync(`${full}/${f}`, 'utf8'));
        if (out.has(ann.id)) errors.push(`${full}/${f}: duplicate annotation for ${ann.id}`);
        out.set(ann.id, { ann, path: `${full}/${f}` });
      } catch (e) {
        errors.push(`${full}/${f}: unparseable JSON (${e.message})`);
      }
    }
  }
  return out;
}
const annotations = loadDir('data/annotations');
const overrides = loadDir('data/overrides');

for (const [id, { ann, path }] of overrides) {
  if (ann.provenance !== 'human') errors.push(`${path}: override provenance must be "human"`);
  annotations.set(id, { ann, path });
}

// --- per-annotation checks ---
for (const [id, { ann, path }] of annotations) {
  const record = byId.get(id);
  if (!record) { errors.push(`${path}: orphan annotation — id not in normalized data`); continue; }
  errors.push(...validateAnnotation(ann, record, lex));
  errors.push(...crossCheckStatuses(ann, record, lex));
  if (ann.textHash !== record.textHash) {
    errors.push(`${id}: annotation textHash ${ann.textHash} != current ${record.textHash} (text drifted — retag)`);
  }
  // "does not stack" boilerplate must round-trip through flags.stacks
  const saysNoStack = /does not stack/i.test(record.text);
  const flagged = ann.flags?.stacks === false;
  if (saysNoStack && !flagged) errors.push(`${id}: text says "does not stack" but flags.stacks is not false`);
  if (!saysNoStack && flagged) errors.push(`${id}: flags.stacks=false but text has no "does not stack"`);
}

// --- coverage ---
const manifest = JSON.parse(readFileSync('data/manifest.json', 'utf8')).records;
const counts = {};
for (const [id, m] of Object.entries(manifest)) {
  const src = byId.get(id)?.source ?? '?';
  counts[src] ??= { todo: 0, machine: 0, tagged: 0, stale: 0, total: 0 };
  counts[src][m.status] = (counts[src][m.status] ?? 0) + 1;
  counts[src].total++;
  const hasFile = annotations.has(id);
  if ((m.status === 'machine' || m.status === 'tagged') && !hasFile) {
    errors.push(`${id}: manifest says ${m.status} but no annotation file exists`);
  }
  if (m.status === 'todo' && hasFile) {
    warnings.push(`${id}: annotation exists but manifest says todo (run extract/absorb to sync)`);
  }
}

// --- cluster consistency: same template shape => same rule skeleton ---
const signature = ann => JSON.stringify(
  (ann.rules ?? []).map(r => ({
    t: r.trigger?.type, s: r.trigger?.subject ?? null,
    c: (r.conditions ?? []).map(c => c.type).sort(),
    a: (r.actions ?? []).map(a => `${a.verb}>${a.target ?? ''}`).sort(),
  }))
);
const clusters = new Map();
for (const r of byId.values()) {
  if (r.meta?.loreOnly || !r.text) continue;
  const key = templateKey(r.text, lex);
  if (!clusters.has(key)) clusters.set(key, []);
  clusters.get(key).push(r.id);
}
for (const [key, ids] of clusters) {
  const tagged = ids.filter(id => annotations.has(id));
  if (tagged.length < 2) continue;
  const sigs = new Map();
  for (const id of tagged) {
    const sig = signature(annotations.get(id).ann);
    if (!sigs.has(sig)) sigs.set(sig, []);
    sigs.get(sig).push(id);
  }
  if (sigs.size > 1) {
    errors.push(`cluster inconsistency (${[...sigs.values()].map(g => g.join('|')).join('  vs  ')}) for shape: ${key.slice(0, 80)}`);
  }
}

// --- lexicon closure probes (warnings) ---
const known = new Set([
  ...lex.statusNames, ...Object.keys(lex.statusAliases), ...lex.stats, ...lex.classes,
  ...lex.keywords, ...lex.whitelist, 'Spell', 'Gem', 'Gems', 'Spells', 'Spell Gems', 'Health',
]);
const probeHits = {};
for (const r of byId.values()) {
  if (r.meta?.loreOnly) continue;
  for (const m of r.text.matchAll(/afflicted with (?:\d+ )?([A-Z][a-zA-Z]+)/g)) {
    const w = m[1];
    if (!known.has(w) && !lex.families.includes(w)) probeHits[w] = (probeHits[w] ?? 0) + 1;
  }
}
for (const [w, n] of Object.entries(probeHits).sort((a, b) => b[1] - a[1])) {
  warnings.push(`closure probe: "afflicted with ${w}" x${n} — unknown term (add to a lexicon or whitelist)`);
}

// --- report ---
console.log('coverage:');
for (const [src, c] of Object.entries(counts).sort()) {
  const done = (c.machine ?? 0) + (c.tagged ?? 0);
  console.log(`  ${src.padEnd(8)} ${String(done).padStart(5)}/${String(c.total).padStart(5)} done  (todo ${c.todo ?? 0}, machine ${c.machine ?? 0}, tagged ${c.tagged ?? 0}, stale ${c.stale ?? 0})`);
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 25)) console.log(`  WARN ${w}`);
  if (warnings.length > 25) console.log(`  … ${warnings.length - 25} more`);
}
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors.slice(0, 50)) console.error(`  ERR ${e}`);
  if (errors.length > 50) console.error(`  … ${errors.length - 50} more`);
  process.exit(1);
}
console.log('\nvalidate: OK');
