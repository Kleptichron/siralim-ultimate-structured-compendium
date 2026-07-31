// The record counts written into shareable copy, asserted against the built
// index. The meta description and the og card are what Discord and Google
// show before anyone loads the app — after a game-data refresh they would
// silently keep saying 4,164 forever, because nothing else reads them.
//
// og.png itself cannot be asserted (it is pixels), but its source can: a
// failure here is the reminder to regenerate it after fixing the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadIndex } from './harness.js';

const count = loadIndex().records.length.toLocaleString('en-US');

// Every "4,164"-shaped number in the file must be the real count. Scoped to
// the thousands shape so honest other numbers (percentages, years) never trip
// it — record count is the only number of that shape in this copy. "4,000+"
// is exempt: a stated approximation (the About panel's no-JS fallback) is not
// a claim that can go stale.
function staleCounts(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(/\b\d,\d{3}\b(?!\+)/g)].map(m => m[0]).filter(n => n !== count);
}

test('index.html meta copy carries the real record count', () => {
  assert.deepEqual(staleCounts('web/index.html'), [],
    `web/index.html claims a record count that is not ${count}`);
});

test('the og card source carries the real record count', () => {
  assert.deepEqual(staleCounts('scripts/og-card.html'), [],
    `scripts/og-card.html claims a record count that is not ${count} — fix it, then regenerate web/public/og.png`);
});
