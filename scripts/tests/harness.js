// Shared fixtures for the suites.
//
// The suites import web/*.js directly — those modules use relative specifiers,
// so the same file the browser loads is the file under test. Nothing is copied,
// rewritten or re-implemented here; a test that passes against a transformed
// copy proves less than it looks like it does.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = path.join(ROOT, 'web/public/index.json.gz');

let cached = null;

// The built index, not the annotations: these suites check what the APP sees,
// which is the derived artefact. `npm test` rebuilds it first so a green run
// can never be reporting on a stale one.
export function loadIndex() {
  if (cached) return cached;
  if (!existsSync(INDEX)) {
    throw new Error(`${path.relative(ROOT, INDEX)} is missing — run \`npm run build-index\` first`);
  }
  cached = JSON.parse(gunzipSync(readFileSync(INDEX)).toString('utf8'));
  return cached;
}

export const traitsOf = index => index.records.filter(r => r.type === 'traits');
export const byId = index => new Map(index.records.map(r => [r.id, r]));

// Reports "3 of 4,068 records failed: <first one>" instead of dumping every
// failure or, worse, only saying `false !== true`. A whole-corpus sweep is only
// useful if a failure tells you which record to go and look at.
export function everyRecord(records, predicate) {
  const bad = [];
  for (const rec of records) {
    let ok = false;
    let detail = '';
    try {
      const r = predicate(rec);
      ok = r === true || r === undefined;
      if (!ok && typeof r === 'string') detail = r;
    } catch (err) {
      detail = err.message;
    }
    if (!ok) bad.push(`${rec.id}${detail ? ': ' + detail : ''}`);
  }
  return {
    ok: bad.length === 0,
    count: bad.length,
    message: bad.length
      ? `${bad.length} of ${records.length} records failed — first ${Math.min(3, bad.length)}:\n  ${bad.slice(0, 3).join('\n  ')}`
      : '',
  };
}
