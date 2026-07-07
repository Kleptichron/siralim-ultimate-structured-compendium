// Absorb tagging batches: data/batches/*.json -> per-record annotation files
// + manifest update. All-or-nothing per run: any invalid annotation aborts
// before anything is written. Run from repo root: npm run absorb
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { loadLexicon } from './lib/lexicon.js';
import { idToPath, SOURCE_DIRS } from './lib/ids.js';
import { SCHEMA_VERSION, validateAnnotation, crossCheckStatuses } from './lib/schema.js';

const lex = loadLexicon();
const byId = new Map();
for (const src of Object.values(SOURCE_DIRS)) {
  for (const r of JSON.parse(readFileSync(`data/normalized/${src}.json`, 'utf8'))) byId.set(r.id, r);
}

const batchFiles = existsSync('data/batches')
  ? readdirSync('data/batches').filter(f => f.endsWith('.json'))
  : [];
if (batchFiles.length === 0) {
  console.log('no batch files in data/batches — nothing to absorb');
  process.exit(0);
}

const errors = [];
const toWrite = []; // {path, ann, batch}

for (const f of batchFiles) {
  let batch;
  try {
    batch = JSON.parse(readFileSync(`data/batches/${f}`, 'utf8'));
  } catch (e) {
    errors.push(`${f}: unparseable JSON (${e.message})`);
    continue;
  }
  const anns = Array.isArray(batch) ? batch : batch.annotations;
  if (!Array.isArray(anns)) { errors.push(`${f}: expected an array (or {annotations: []})`); continue; }
  for (const raw of anns) {
    const record = byId.get(raw.id);
    if (!record) { errors.push(`${f}: unknown id ${raw.id}`); continue; }
    const ann = {
      schemaVersion: SCHEMA_VERSION,
      provenance: 'claude',
      ...raw,
      textHash: record.textHash, // stamped at absorb time
    };
    const errs = [...validateAnnotation(ann, record, lex), ...crossCheckStatuses(ann, record, lex)];
    if (errs.length) { errors.push(...errs.map(e => `${f}: ${e}`)); continue; }
    const { dir, file } = idToPath(ann.id);
    const path = `data/annotations/${dir}/${file}`;
    if (existsSync(path)) {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (existing.provenance === 'human' && ann.provenance !== 'human') {
        errors.push(`${f}: ${ann.id} has a human annotation — refuse to overwrite (use data/overrides or provenance human)`);
        continue;
      }
    }
    toWrite.push({ path, ann, batch: f });
  }
}

if (errors.length) {
  console.error(`${errors.length} error(s) — nothing written:`);
  for (const e of errors.slice(0, 50)) console.error(`  ERR ${e}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync('data/manifest.json', 'utf8'));
for (const { path, ann } of toWrite) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, JSON.stringify(ann, null, 2) + '\n');
  manifest.records[ann.id] = { hash: ann.textHash, status: 'tagged', provenance: ann.provenance };
}
writeFileSync('data/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
for (const f of batchFiles) unlinkSync(`data/batches/${f}`);
console.log(`absorbed ${toWrite.length} annotations from ${batchFiles.length} batch file(s)`);
