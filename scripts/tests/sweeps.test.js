// Exhaustive two-facet sweeps: every (trigger, action) and every (action,
// target) pair, in both match modes, compared against truth computed straight
// off the match bags rather than against runQuery's own logic.
//
// This is what proves rule and action scoping. The bug it exists to catch was
// real and silent: before per-action bags, "deal_damage → caster" returned 21
// records of which 18 were wrong, because the verb came from one action and the
// target from another in the same record.
//
//   same-action  -> some ONE bag must carry both values
//   cross-rule   -> the record's bags must carry each somewhere
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyQuery, runQuery } from '../../web/filter.js';
import { loadIndex } from './harness.js';

const index = loadIndex();
const recs = index.records;

const valuesOf = group =>
  [...new Set(recs.flatMap(r => (r.matchBags ?? []).flatMap(b => b[group] ?? [])))].sort();

// Both modes are computed per pair in one pass. Running them separately meant
// two more full sweeps just to compare the two result sets, which was a third
// of the suite's runtime for no extra coverage.
function sweep(groupA, groupB) {
  const wrong = [];
  let pairs = 0;
  let narrowed = 0;
  for (const a of valuesOf(groupA)) {
    for (const b of valuesOf(groupB)) {
      pairs++;
      const run = sameRule => {
        const q = emptyQuery();
        q.sameRule = sameRule;
        q[groupA].add(a);
        q[groupB].add(b);
        return new Set(runQuery(recs, q).map(r => r.id));
      };
      const strict = run(true);
      const loose = run(false);
      for (const rec of recs) {
        const bags = rec.matchBags ?? [];
        const inOne = bags.some(x => (x[groupA] ?? []).includes(a) && (x[groupB] ?? []).includes(b));
        const inAny = bags.some(x => (x[groupA] ?? []).includes(a))
          && bags.some(x => (x[groupB] ?? []).includes(b));
        const say = (mode, want) =>
          `${a} x ${b} (${mode}): ${rec.id} ${want ? 'missing (false negative)' : 'included (false positive)'}`;
        if (strict.has(rec.id) !== inOne) wrong.push(say('same-action', inOne));
        if (loose.has(rec.id) !== inAny) wrong.push(say('cross-rule', inAny));
        // Action scoping may only ever remove records, never add them.
        if (strict.has(rec.id) && !loose.has(rec.id)) {
          wrong.push(`${a} x ${b}: ${rec.id} matched under action scoping but not record scoping`);
        }
      }
      if (strict.size < loose.size) narrowed++;
    }
  }
  return { pairs, wrong, narrowed };
}

for (const [groupA, groupB] of [['triggers', 'verbs'], ['verbs', 'targets']]) {
  test(`${groupA} x ${groupB}, both match modes`, () => {
    const { pairs, wrong, narrowed } = sweep(groupA, groupB);
    assert.ok(pairs > 100, `only ${pairs} pairs swept — the facet values look empty`);
    assert.deepEqual(wrong.slice(0, 5), [],
      `${wrong.length} wrong results across ${pairs} pairs x 2 modes`);
    // If the two modes agreed on every pair the checkbox would be decorative,
    // and a sweep that passes trivially is worse than no sweep.
    assert.ok(narrowed > 0, 'no pair narrowed under action scoping — the mode does nothing');
  });
}
