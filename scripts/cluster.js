// Template clustering: texts differing only in typed vocabulary share a key.
// Multi-member clusters must stay structurally consistent (validate.js checks).
// Run from repo root: npm run cluster
import { readFileSync, writeFileSync } from 'node:fs';
import { loadLexicon } from './lib/lexicon.js';
import { templateKey } from './lib/normalize.js';
import { SOURCE_DIRS } from './lib/ids.js';

const lex = loadLexicon();
const clusters = new Map();
for (const src of Object.values(SOURCE_DIRS)) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) {
    if (r.meta?.loreOnly || !r.text) continue;
    const key = templateKey(r.text, lex);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(r.id);
  }
}

const multi = [...clusters.entries()].filter(([, ids]) => ids.length > 1);
multi.sort((a, b) => b[1].length - a[1].length);
const out = Object.fromEntries(multi.map(([key, ids]) => [key, ids.sort()]));
writeFileSync('data/evidence/clusters.json', JSON.stringify(out, null, 2) + '\n');

const total = [...clusters.values()].reduce((n, ids) => n + ids.length, 0);
console.log(`${total} records -> ${clusters.size} template shapes (${multi.length} multi-member)`);
console.log('largest clusters:');
for (const [key, ids] of multi.slice(0, 8)) {
  console.log(`  ${String(ids.length).padStart(3)}  ${key.slice(0, 100)}`);
}
