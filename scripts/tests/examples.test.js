// The start view's example searches, run against the built index.
//
// These hashes are the first thing a cold visitor clicks. An enum rename, a
// re-tag that empties one, or a typo'd param name would all ship a start page
// whose showcase search returns nothing — this is the only place that fails
// before it deploys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashToQuery, runQuery, activeFilterCount } from '../../web/filter.js';
import { EXAMPLES } from '../../web/examples.js';
import { loadIndex } from './harness.js';

const index = loadIndex();

test('every example search parses to real filters and returns results', () => {
  for (const ex of EXAMPLES) {
    const q = hashToQuery(ex.hash);
    // A misspelled param name parses to an empty query, which matches the whole
    // corpus — that would look "green" by count alone, so check the filters took.
    assert.ok(activeFilterCount(q) > 0, `"${ex.label}" (${ex.hash}) parsed to no filters`);
    const n = runQuery(index.records, q).length;
    assert.ok(n > 0, `"${ex.label}" (${ex.hash}) matches nothing`);
    assert.ok(n < index.records.length, `"${ex.label}" (${ex.hash}) matches the whole corpus`);
  }
});
