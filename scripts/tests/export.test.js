// The export serializers, over the whole corpus.
//
// The CSV check parses the output back with an independent RFC 4180 reader
// rather than the writer's own rules — a test that agrees with the code it
// tests would pass on a file no spreadsheet could open.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resultsToCsv, resultsToMarkdown, resultsToJson, buildToMarkdown, permalink,
} from '../../web/export.js';
import { SLOT_LABELS, emptyBuild, buildWarnings, buildSummary, placeLabel } from '../../web/build.js';
import { loadIndex, traitsOf, byId } from './harness.js';

const index = loadIndex();
const recs = index.records;
const lookup = byId(index);
const ORIGIN = 'https://example.test';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// The formula guard prefixes a quote; strip it to compare against the source.
const unguard = s => (s.startsWith("'") && /^[=+\-@\t\r]/.test(s.slice(1)) ? s.slice(1) : s);

test('CSV round trips through an independent reader', () => {
  const rows = parseCsv(resultsToCsv(recs, ORIGIN));
  assert.equal(rows.length, recs.length + 1, 'one header plus one row per record');

  const width = rows[0].length;
  const ragged = rows.findIndex(r => r.length !== width);
  assert.equal(ragged, -1, `row ${ragged} has ${rows[ragged]?.length} fields, header has ${width}`);

  const col = name => rows[0].indexOf(name);
  const [id, name, effect, link] = ['id', 'name', 'effect', 'link'].map(col);
  assert.ok([id, name, effect, link].every(i => i >= 0), 'expected columns are present');

  const bad = [];
  for (const [i, rec] of recs.entries()) {
    const row = rows[i + 1];
    if (unguard(row[id]) !== rec.id) bad.push(`${rec.id}: id`);
    if (unguard(row[name]) !== rec.name) bad.push(`${rec.id}: name`);
    if (unguard(row[effect]) !== rec.text.replace(/\r?\n/g, ' ')) bad.push(`${rec.id}: effect`);
    if (row[link] !== permalink(ORIGIN, rec.id)) bad.push(`${rec.id}: link`);
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} fields did not survive the round trip`);
});

test('CSV neutralises cells a spreadsheet would read as a formula', () => {
  const rigged = [{
    id: 'x', type: 'traits', name: '=cmd|calc', text: '+1 damage', meta: {}, facets: {},
  }];
  const rows = parseCsv(resultsToCsv(rigged));
  assert.ok(rows[1][rows[0].indexOf('name')].startsWith("'"));
  assert.ok(rows[1][rows[0].indexOf('effect')].startsWith("'"));
});

test('CSV uses CRLF, so Excel and the RFC agree', () => {
  const csv = resultsToCsv(recs.slice(0, 3));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.split('\r\n').filter(Boolean).length, 4);
});

test('Markdown keeps one row per record and escapes pipes', () => {
  const md = resultsToMarkdown(recs, ORIGIN, 'All effects');
  const lines = md.trim().split('\n');
  assert.equal(lines.length, recs.length + 4, 'title, blank, header, separator, then rows');

  const ragged = lines.slice(3).filter(l => l.split(/(?<!\\)\|/).length !== 6);
  assert.deepEqual(ragged.slice(0, 2), [], `${ragged.length} rows do not have four columns`);

  const withPipe = recs.filter(r => r.text.includes('|'));
  for (const rec of withPipe) {
    assert.ok(md.includes(rec.text.replace(/\|/g, '\\|')), `${rec.id}: pipe not escaped`);
  }
});

test('JSON is the records as the index holds them, minus the search cache', () => {
  const tagged = { ...recs[0], _hay: 'lazily cached by filter.js' };
  const out = JSON.parse(resultsToJson([tagged, recs[1]], { generated: index.generated }));
  assert.equal(out.count, 2);
  assert.equal(out.generated, index.generated);
  assert.ok(!('_hay' in out.records[0]), '_hay is an implementation detail and must not leak');
  assert.equal(JSON.stringify(out.records[1]), JSON.stringify(recs[1]));
});

// --- build sheet ------------------------------------------------------------

const traits = traitsOf(index);
const mdOptions = (build, extra = {}) => ({
  slotLabels: SLOT_LABELS,
  netherSlots: 4,
  placeLabel,
  summary: buildSummary(build, lookup),
  warnings: buildWarnings(build, lookup),
  ...extra,
});

test('build Markdown names every chosen trait, with its creature and heading', () => {
  const build = emptyBuild();
  build.nether = true;
  const picked = [];
  for (let c = 0; c < 6; c++) {
    for (let s = 0; s < 4; s++) {
      build.slots[c][s] = traits[c * 4 + s].id;
      picked.push(traits[c * 4 + s]);
    }
  }
  const md = buildToMarkdown(build, lookup, mdOptions(build, { url: `${ORIGIN}/#build=x` }));
  for (const rec of picked) assert.ok(md.includes(rec.name), `${rec.id} missing from the export`);
  assert.equal((md.match(/^### Creature /gm) ?? []).length, 6);
  assert.ok(md.includes(`${ORIGIN}/#build=x`), 'the permalink is the way back to the live build');
  assert.ok(md.includes('### Team summary'));
});

test('build Markdown hides the fourth slot unless nether is on', () => {
  const build = emptyBuild();
  build.slots[0][0] = traits[0].id;
  build.slots[0][3] = traits[1].id;
  const md = buildToMarkdown(build, lookup, mdOptions(build));
  assert.ok(md.includes(traits[0].name));
  assert.ok(!md.includes(traits[1].name), 'a slot the sheet does not show must not be exported');
});

test('build Markdown reports warnings with their location', () => {
  const build = emptyBuild();
  build.slots[2][1] = traits.find(r => r.meta.creature === 'Mastery Trait').id;
  const md = buildToMarkdown(build, lookup, mdOptions(build));
  assert.ok(md.includes('### Warnings'));
  assert.ok(md.includes('Creature 3 · Fusion'));
});

test('an empty build says so rather than exporting a skeleton', () => {
  const build = emptyBuild();
  const md = buildToMarkdown(build, lookup, mdOptions(build));
  assert.ok(md.includes('No traits chosen yet'));
  assert.ok(!md.includes('### Creature'));
});

test('a trait id that is no longer in the index is reported, not crashed on', () => {
  const build = emptyBuild();
  build.slots[0][0] = 'trait:does-not-exist';
  const md = buildToMarkdown(build, lookup, mdOptions(build));
  assert.ok(md.includes('unknown trait'));
});
