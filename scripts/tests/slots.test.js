// Which build slots a trait may occupy.
//
// The derivation lives in build-index.js and reads two sentinels in the source
// data; this checks the result against those sentinels record by record, so a
// corpus change that alters either one fails here rather than quietly shrinking
// what the builder offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_KEYS, slotAccepts, emptyBuild, buildWarnings, placeLabel,
} from '../../web/build.js';
import { emptyQuery, runQuery } from '../../web/filter.js';
import { loadIndex, traitsOf, byId, everyRecord } from './harness.js';

const index = loadIndex();
const traits = traitsOf(index);
const lookup = byId(index);

const NOT_A_CREATURE = new Set(['Mastery Trait', 'Backer Trait', 'Zantai Material']);
const NO_MATERIAL = 'No Material Exists';

test('slot eligibility matches the source sentinels on every trait', () => {
  const r = everyRecord(traits, rec => {
    const creature = !NOT_A_CREATURE.has(rec.meta.creature);
    const material = rec.meta.material !== NO_MATERIAL;
    const want = { innate: creature, fusion: creature, artifact: material, nether: true };
    for (const [i, key] of SLOT_KEYS.entries()) {
      if (slotAccepts(rec, i) !== want[key]) {
        return `${key} should be ${want[key]} (creature "${rec.meta.creature}", material "${rec.meta.material}")`;
      }
    }
    return true;
  });
  assert.ok(r.ok, r.message);
});

test('the two exclusions never overlap, so nothing is locked out', () => {
  const r = everyRecord(traits, rec =>
    [0, 1, 2].some(s => slotAccepts(rec, s)) || 'refused by innate, fusion AND artifact');
  assert.ok(r.ok, r.message);
});

test('nether takes every trait', () => {
  const r = everyRecord(traits, rec => slotAccepts(rec, 3) || 'refused by the nether slot');
  assert.ok(r.ok, r.message);
});

test('only traits go in slots at all', () => {
  const others = index.records.filter(r => r.type !== 'traits');
  const r = everyRecord(others, rec =>
    SLOT_KEYS.every((_, s) => !slotAccepts(rec, s)) || `a ${rec.type} record was accepted by a slot`);
  assert.ok(r.ok, r.message);
});

test('a record with no slot data is accepted everywhere, a missing one nowhere', () => {
  // A deployed page can outlive the index it was built against. Refusing every
  // trait would be a far worse failure than accepting them.
  const legacy = { ...traits[0] };
  delete legacy.slots;
  assert.ok(SLOT_KEYS.every((_, s) => slotAccepts(legacy, s)), 'stale index should not empty the builder');
  assert.ok(SLOT_KEYS.every((_, s) => !slotAccepts(undefined, s)));
  assert.ok(SLOT_KEYS.every((_, s) => !slotAccepts(null, s)));
});

const mastery = () => traits.find(r => r.meta.creature === 'Mastery Trait');
const god = () => traits.find(r => r.meta.material === NO_MATERIAL);
const ordinary = () => traits.find(r => r.slots.length === 4);

test('an illegal placement from a shared link is flagged, not dropped', () => {
  const build = emptyBuild();
  build.slots[0][0] = mastery().id;  // no creature -> cannot be innate
  build.slots[1][2] = god().id;      // no material -> cannot go on an artifact
  build.slots[2][0] = ordinary().id; // fine
  const invalid = buildWarnings(build, lookup).filter(w => w.severity === 'invalid');
  assert.equal(invalid.length, 2);
  assert.match(invalid.find(w => w.id === mastery().id).note, /come from a creature/);
  assert.match(invalid.find(w => w.id === god().id).note, /material/);
  assert.ok(!invalid.some(w => w.id === ordinary().id), 'a legal placement was flagged');
});

test('warnings say where, not how many', () => {
  const build = emptyBuild();
  build.slots[3][1] = mastery().id;
  const [w] = buildWarnings(build, lookup).filter(x => x.severity === 'invalid');
  assert.equal(placeLabel(w.places[0]), 'Creature 4 · Fusion');
});

test('the hidden fourth slot is neither validated nor counted', () => {
  const build = emptyBuild();
  build.slots[0][3] = mastery().id;
  build.nether = true;
  assert.equal(buildWarnings(build, lookup).filter(w => w.severity === 'invalid').length, 0,
    'the nether slot should accept anything');
  build.nether = false;
  assert.equal(buildWarnings(build, lookup).length, 0,
    'a slot that is not shown should not be validated');
});

// --- the sidebar facet derived from the same rule ---------------------------

const withEquip = value => {
  const q = emptyQuery();
  q.equip.add(value);
  return runQuery(index.records, q);
};

test('the equip facet says the same thing as slotAccepts', () => {
  const r = everyRecord(traits, rec => {
    const equip = rec.facets?.equip ?? [];
    if (equip.includes('creature') !== slotAccepts(rec, 0)) return 'creature value disagrees with the innate slot';
    if (equip.includes('artifact') !== slotAccepts(rec, 2)) return 'artifact value disagrees with the artifact slot';
    return true;
  });
  assert.ok(r.ok, r.message);
});

test('the facet offers no value that cannot narrow anything', () => {
  // Fusion would duplicate innate exactly and nether would match every trait —
  // either would be a control that looks like a filter and is not.
  const values = new Set(traits.flatMap(r => r.facets?.equip ?? []));
  assert.deepEqual([...values].sort(), ['artifact', 'creature']);
  for (const v of values) {
    const n = withEquip(v).length;
    assert.ok(n > 0 && n < traits.length, `"${v}" matches ${n} of ${traits.length} traits`);
  }
});

test('selecting a slot value returns only traits', () => {
  const r = everyRecord(index.records.filter(rec => rec.type !== 'traits'),
    rec => !(rec.facets?.equip) || `a ${rec.type} record carries an equip facet`);
  assert.ok(r.ok, r.message);
  for (const v of ['creature', 'artifact']) {
    assert.ok(withEquip(v).every(rec => rec.type === 'traits'), `"${v}" let a non-trait through`);
  }
});

test('equip is record-level, so it never joins action scoping', () => {
  // If it leaked into a match bag, "Artifact + deals damage" under action
  // scoping would start demanding both of one action and quietly return zero.
  const r = everyRecord(traits, rec =>
    (rec.matchBags ?? []).every(b => b.equip === undefined) || 'equip leaked into a match bag');
  assert.ok(r.ok, r.message);

  const strict = emptyQuery();
  strict.sameRule = true;
  strict.equip.add('artifact');
  strict.verbs.add('deal_damage');
  const loose = { ...emptyQuery(), sameRule: false, equip: strict.equip, verbs: strict.verbs };
  assert.equal(runQuery(index.records, strict).length, runQuery(index.records, loose).length,
    'the match mode changed a record-level filter');
});

test('excluding a slot value keeps records that never had one', () => {
  // Consistent with every other group: exclusion removes records that HAVE the
  // value, it does not imply "must be a trait". Composing with the Source facet
  // is what narrows it to the traits actually ruled out.
  const q = emptyQuery();
  q.excluded.equip.add('artifact');
  const all = runQuery(index.records, q);
  assert.ok(all.some(rec => rec.type !== 'traits'), 'non-traits should survive the exclusion');

  q.types.add('traits');
  const onlyTraits = runQuery(index.records, q);
  assert.ok(onlyTraits.every(rec => rec.meta.material === NO_MATERIAL));
  assert.equal(onlyTraits.length, traits.filter(r => !slotAccepts(r, 2)).length);
});

test('duplicate detection still works alongside slot validation', () => {
  const build = emptyBuild();
  build.slots[0][0] = ordinary().id;
  build.slots[1][0] = ordinary().id;
  const dupes = buildWarnings(build, lookup).filter(w => w.severity !== 'invalid');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].places.length, 2);
});
