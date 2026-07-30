// The markup grammar, and the equivalence test that decides whether a corpus
// update invalidates an annotation.
//
// markupEquivalent is the load-bearing one: it is what lets 859 annotations
// survive the switch to the game's own text instead of being flagged stale, and
// what lets a genuinely reworded effect still be caught. Too strict and every
// re-import buries real changes under hundreds of false ones; too loose and a
// changed effect keeps a wrong annotation. Both failure modes are checked here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveMarkup, extractRefs, markupEquivalent, hasRuntimeValue, statusKindOf,
  splitToken, normPunct, SEMANTIC_BRACKETS,
} from '../lib/markup.js';
import { ROOT, loadIndex } from './harness.js';

const TOKENS = JSON.parse(readFileSync(path.join(ROOT, 'source/game/tokens.json'), 'utf8'));

test('a token resolves to the name the game displays, capitalised by position', () => {
  assert.equal(
    resolveMarkup('After this creature {ACTION_attacks}, it heals allies.', TOKENS),
    'After this creature attacks, it heals allies.',
  );
  // Same token, sentence-initial: the game capitalises, so we do.
  assert.equal(resolveMarkup('{STAT_health} is restored.', TOKENS), 'Health is restored.');
  assert.equal(resolveMarkup('It restores {STAT_health}.', TOKENS), 'It restores health.');
});

test('sprite refs and slot markup leave no trace in display text', () => {
  assert.equal(
    resolveMarkup("Your creatures' [slot_spell] Spell Slots activate.", TOKENS),
    "Your creatures' Spell Slots activate.",
  );
  assert.equal(
    resolveMarkup('This creature gains [icons,1984]Bone Spear.', TOKENS),
    'This creature gains Bone Spear.',
  );
  // No doubled space, and no space stranded before punctuation.
  assert.ok(!/ {2}| ,| \./.test(resolveMarkup('A [temporary] gem, [icons,12]now.', TOKENS)));
});

test('an unknown token is refused rather than rendered as itself', () => {
  assert.throws(() => resolveMarkup('Gains {CONDNAME_BUFF_NOTATHING}.', TOKENS), /unresolved markup token/);
});

test('refs keep the buff/debuff/minion split the display text collapses', () => {
  const refs = extractRefs(
    'Afflicts {CONDNAME_DEBUFF_BURNED} and grants {CONDNAME_BUFF_BARRIER} and a {CONDNAME_MINION_ZOMBIE}.',
    TOKENS, SEMANTIC_BRACKETS,
  );
  assert.deepEqual(refs.debuffs, ['Burning']);
  assert.deepEqual(refs.buffs, ['Barrier']);
  assert.deepEqual(refs.statuses, ['Barrier', 'Burning', 'Zombies']);
  // The minion is a status ref but not a buff or debuff, which is what stops the
  // validator demanding it be claimed as one.
  assert.ok(!refs.buffs.includes('Zombies') && !refs.debuffs.includes('Zombies'));
});

test('refs record families, classes and semantic markup, not sprite names', () => {
  const refs = extractRefs(
    'Your {RACE_Diabolic Horde} and {CLASS_Chaos} creatures gain [slot_stat] slots [ad_mirrorball].',
    TOKENS, SEMANTIC_BRACKETS,
  );
  assert.deepEqual(refs.families, ['Diabolic Horde']);
  assert.deepEqual(refs.classes, ['Chaos']);
  assert.deepEqual(refs.markup, ['slot_stat']);
});

test('statusKindOf and splitToken read the namespaces', () => {
  assert.deepEqual(splitToken('CONDNAME_DEBUFF_BURNED'), { family: 'CONDNAME', key: 'DEBUFF_BURNED' });
  assert.deepEqual(statusKindOf('DEBUFF_BURNED'), { kind: 'debuff', key: 'BURNED' });
  assert.equal(statusKindOf('NOTAKIND_X'), null);
  assert.deepEqual(splitToken('TIMELINE'), { family: 'TIMELINE', key: '' });
});

test('equivalence accepts a transcription that only flattened the typing', () => {
  const markup = 'After this creature {ACTION_attacks}, it afflicts the target with {CONDNAME_DEBUFF_BURNED}.';
  assert.ok(markupEquivalent(markup, 'After this creature attacks, it afflicts the target with Burning.'));
  // Case and typographic punctuation are transcription noise, never meaning.
  assert.ok(markupEquivalent(markup, 'After this creature Attacks, it afflicts the target with burning.'));
  assert.ok(markupEquivalent(
    "This creature's turn ends.".replace("'", '’'),
    "This creature's turn ends.",
  ));
});

test('equivalence rejects a reworded effect, which is the whole point', () => {
  const markup = 'Your creatures gain 10% more {STAT_health}.';
  assert.ok(!markupEquivalent(markup, 'Your creatures gain 20% more health.'));
  assert.ok(!markupEquivalent(markup, 'Your enemies gain 10% more health.'));
  // The real inversion this caught in the corpus.
  const bonding = 'They have a 7% chance to be resurrected for each creature that belongs to a different class.';
  assert.ok(!markupEquivalent(bonding,
    'They have a 7% chance to be resurrected for each creature that belongs to the same class.'));
  // A token wildcard is confined to one sentence, so an appended sentence — the
  // way the corpus's real omissions look — cannot be absorbed.
  assert.ok(!markupEquivalent('Gains {CONDNAME_BUFF_BARRIER}.', 'Gains Barrier. It also dies.'));
  assert.ok(!markupEquivalent('Gains {CONDNAME_BUFF_BARRIER}. It ends.', 'Gains Barrier.'));
  // Known limit: a token immediately before the closing period has nothing after
  // it to anchor against, so extra words appended INSIDE that last sentence still
  // match. crossCheckRefs is the backstop — an annotation that claims something
  // the game's markup does not type is reported there.
  assert.ok(markupEquivalent('Gains {CONDNAME_BUFF_BARRIER}.', 'Gains Barrier and also dies.'));
});

test('a per-rank template matches the transcription that spells it out', () => {
  const markup = "<5>% of your creatures' chance to dodge attacks is applied to spells as well.";
  assert.ok(hasRuntimeValue(markup));
  // hasRuntimeValue must not alternate between calls (a /g regex would).
  assert.ok(hasRuntimeValue(markup));
  assert.ok(!hasRuntimeValue('No placeholder here.'));
  assert.ok(markupEquivalent(markup,
    "5% of your creatures' chance to Dodge attacks per rank is applied to spells as well."
    + ' Maximum Bonus: 100% of dodge chance applied'));
  // Without a template, that boilerplate is not licensed to differ.
  assert.ok(!markupEquivalent("Your creatures' chance to dodge attacks is applied to spells as well.",
    "Your creatures' chance to dodge attacks per rank is applied to spells as well."));
});

test("the game's (s) pluralisation matches either form", () => {
  assert.ok(markupEquivalent('Fatigue starts <1> turn(s) sooner.', 'Fatigue starts 1 turn sooner.'));
  assert.ok(markupEquivalent('Fatigue starts <2> turn(s) sooner.', 'Fatigue starts 2 turns sooner.'));
});

test('normPunct folds only the differences that carry no meaning', () => {
  assert.equal(normPunct('a’s “b” — c…'), 'a\'s "b" - c...');
  assert.equal(normPunct('two  spaces\\nand a break'), 'two spaces and a break');
});

test('every record the corpus resolved is free of unresolved markup', () => {
  const bad = [];
  for (const r of loadIndex().records) {
    if (r.refs?.unresolved?.length) bad.push(`${r.id}: {${r.refs.unresolved.join('} {')}}`);
    // Nothing may reach display text still wearing markup.
    if (/\{[A-Z]+_|\[icons?,|<\d+>/.test(r.text ?? '')) bad.push(`${r.id}: unrendered markup in text`);
  }
  assert.deepEqual(bad, []);
});
