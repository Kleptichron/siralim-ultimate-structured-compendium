// Every clickable chip on a card must, applied on its own, keep that card in
// the results.
//
// This is the invariant that catches chip/facet drift: a chip's label is
// produced by render.js and the filter it carries has to agree with what
// build-index put in the record's facets. When those two drift apart the chip
// still looks right and silently searches for something else — the failure mode
// that first motivated this sweep, when 116 unnamed-status chips took their
// interaction from the status kind instead of the verb.
//
// cardHtml returns a string, so no DOM is needed: the chips are read back out
// of the markup the browser would have received.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyQuery, runQuery } from '../../web/filter.js';
import { initHighlight, cardHtml } from '../../web/render.js';
import { loadIndex } from './harness.js';

const index = loadIndex();
initHighlight(index.statuses);

const unescape = s => s
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The click handler in main.js, in one place so the test exercises the same
// translation from chip filters to a query that the app does.
function queryFromChip(entries) {
  const q = emptyQuery();
  for (const [kind, a, b, c] of entries) {
    if (kind === 'g') q[a].add(b);
    else if (kind === 'p') { const sel = q.pickers[a]; if (b) sel.key = b; sel.on.add(c); }
    else if (kind === 'pct') { q.pctMin = a; q.pctMax = b; }
  }
  return q;
}

function chipsOf(rec) {
  const html = cardHtml(rec, emptyQuery());
  return [...html.matchAll(/data-f="([^"]*)"/g)].map(m => JSON.parse(unescape(m[1])));
}

test('every result chip finds the record it sits on', () => {
  let chips = 0;
  let visited = 0;
  const chipless = [];
  const bad = [];
  for (const rec of index.records) {
    visited++;
    const own = chipsOf(rec);
    // A record carrying rules must offer at least one chip to click.
    if (rec.rules?.length && own.length === 0) chipless.push(rec.id);
    for (const entries of own) {
      chips++;
      // Queried against the one record rather than the corpus. runQuery is a
      // pure per-record filter with no cross-record state, so this is the same
      // predicate — and 16,000 full-corpus scans cost two minutes to prove
      // nothing extra. The sweeps exercise runQuery over the whole array.
      if (runQuery([rec], queryFromChip(entries)).length !== 1) {
        bad.push(`${rec.id} ${JSON.stringify(entries)}`);
      }
    }
  }
  // Guards that the loop really covered the corpus, without pinning a magic
  // number: the old `chips > 15000` was really a proxy for "did this run at all",
  // and it broke the first time annotation coverage legitimately changed rather
  // than because anything was wrong.
  assert.equal(visited, index.records.length, 'did not visit every record');
  assert.deepEqual(chipless.slice(0, 5), [], `${chipless.length} records with rules offered no chip`);
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${chips} chips lost their own record`);
});

test('a chip narrows the corpus rather than matching everything', () => {
  // The per-record check above cannot see a filter so broad it is useless —
  // one that would return the whole index. Sampled, since this is the
  // expensive direction.
  const sample = index.records.filter((_, i) => i % 97 === 0);
  for (const rec of sample) {
    for (const entries of chipsOf(rec)) {
      const hits = runQuery(index.records, queryFromChip(entries)).length;
      assert.ok(hits >= 1, `${rec.id}: chip ${JSON.stringify(entries)} matched nothing`);
      assert.ok(hits < index.records.length,
        `${rec.id}: chip ${JSON.stringify(entries)} matched every record`);
    }
  }
});

test('a chip carries no filter it cannot act on', () => {
  const groups = new Set(['triggers', 'verbs', 'actors', 'targets', 'conditions', 'flows',
    'tiers', 'qualifiers', 'scaleRefs', 'markers', 'families', 'types']);
  const pickers = new Set(['status', 'stat', 'class', 'race']);
  const bad = [];
  for (const rec of index.records) {
    for (const entries of chipsOf(rec)) {
      for (const [kind, a, b] of entries) {
        if (kind === 'g' && !groups.has(a)) bad.push(`${rec.id}: unknown facet group "${a}"`);
        if (kind === 'p' && !pickers.has(a)) bad.push(`${rec.id}: unknown picker "${a}"`);
        if (kind === 'pct' && !Number.isFinite(a)) bad.push(`${rec.id}: non-numeric percent ${a}`);
        if (kind === 'g' && (b === undefined || b === '')) bad.push(`${rec.id}: empty value in ${a}`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} malformed chip filters`);
});
