// The game's effect strings are semantically marked up. Where the community
// CSVs say "After this creature attacks, ... Burning", the game's own string
// says "After this creature {ACTION_attacks}, ... {CONDNAME_DEBUFF_BURNED}" —
// every status, stat, class, family and battle action is explicitly typed at the
// position it occurs. That typing is ground truth for the rule model: it tells
// us a bare word like "Poisoned" IS the debuff and not prose, and it separates
// the three CONDNAME namespaces (BUFF/DEBUFF/MINION) that the display text
// collapses into identically-spelled words.
//
// This module is the single place that knows the markup grammar. Import writes
// resolved display text plus a `refs` block; validate checks annotations against
// those refs rather than re-parsing prose.

// {FAMILY_key} — keys may contain spaces ("{RACE_Diabolic Horde}").
const TOKEN = /\{([^}]+)\}/g;
// [icons,1984] — a sprite reference by sheet index.
const ICON = /\[icons?,\d+\]\s*/g;
// [slot_spell], [slot_stat], [temporary] — inline markup that IS semantic:
// which artifact slot type, or that a spell gem is Ethereal. Most bracket tags
// are plain sprite names ([ad_mirrorball]); both kinds render as an icon, so
// neither survives into display text, but the semantic ones reach `refs`.
const BRACKET = /\[([a-z][a-z_0-9]*)\]\s*/g;
// <5> — a value the game substitutes per perk rank, so the shipped string is a
// template rather than a finished sentence. The single-match copy is kept
// separate because a /g regex carries lastIndex between .test() calls and would
// answer alternately.
const RUNTIME = /<(\d+(?:\.\d+)?)>/g;
const RUNTIME_ONE = /<\d+(?:\.\d+)?>/;
// Anything standing in for wording the game fills in at display time.
const TOKEN_OR_RUNTIME = /\{[^}]+\}|<\d+(?:\.\d+)?>/;

// Token family -> the refs bucket it feeds. A family absent here lands in
// refs.other, so a game update that invents one surfaces instead of vanishing.
const FAMILY_BUCKET = {
  CONDNAME: 'statuses',
  RACE: 'families',
  STAT: 'stats',
  CLASS: 'classes',
  ACTION: 'actions',
  SPELL: 'spells',
};

// Bracket tags that mean something to the rule model rather than just drawing an
// icon. Everything else is a sprite name; extract-game-data.js warns when a new
// tag looks like it belongs on this list.
export const SEMANTIC_BRACKETS = ['slot_spell', 'slot_stat', 'slot_trick', 'temporary'];

export const stripIcons = text => text.replace(ICON, '');
export const hasRuntimeValue = text => RUNTIME_ONE.test(text ?? '');

// Typographic vs ASCII punctuation is the single most common difference between
// the game's strings and hand transcriptions of them, and never a semantic one.
export const normPunct = s => (s ?? '')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/…/g, '...')
  // Some strings carry \n escapes rather than real breaks (perk text that the
  // game renders as two paragraphs); they are one sentence run here.
  .replace(/(?:\\r)?\\n/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// A handful of shipped strings end in a stray quote the game's own text editor
// left behind (L_RELIC_LISTER4). Faithfully carrying a typo into display text
// just reads as a bug in this tool, so an unbalanced trailing quote is dropped.
const dropUnbalancedQuote = s =>
  s.endsWith('"') && (s.match(/"/g) ?? []).length % 2 === 1 ? s.slice(0, -1).trimEnd() : s;

// "CONDNAME_DEBUFF_BURNED" -> family CONDNAME, key DEBUFF_BURNED. Bare tokens
// such as {TIMELINE} have no key.
export function splitToken(token) {
  const us = token.indexOf('_');
  return us < 0 ? { family: token, key: '' } : { family: token.slice(0, us), key: token.slice(us + 1) };
}

// CONDNAME keys carry their own namespace: DEBUFF_BURNED -> debuff / BURNED.
export function statusKindOf(key) {
  const m = /^(BUFF|DEBUFF|MINION)_(.+)$/.exec(key);
  return m ? { kind: m[1].toLowerCase(), key: m[2] } : null;
}

export function tokensIn(text) {
  return [...text.matchAll(TOKEN)].map(m => ({ token: m[1], ...splitToken(m[1]) }));
}

export const bracketsIn = text => [...text.matchAll(BRACKET)].map(m => m[1]);

// The structured references the game itself asserts for this string. Values are
// display names, resolved through `map`, so they line up with the lexicons the
// annotations are written against. Anything `map` cannot resolve is reported in
// refs.unresolved rather than silently becoming a bogus facet value.
export function extractRefs(text, map, semanticBrackets) {
  const refs = {};
  const add = (bucket, value) => {
    refs[bucket] ??= [];
    if (!refs[bucket].includes(value)) refs[bucket].push(value);
  };
  for (const { token, family, key } of tokensIn(text)) {
    const display = map[token];
    if (display === undefined) { add('unresolved', token); continue; }
    if (family === 'CONDNAME') {
      const st = statusKindOf(key);
      add('statuses', display);
      // A status ref keeps its kind — the whole point of the CONDNAME split.
      if (st) add(`${st.kind}s`, display);
    } else if (family === 'TIMELINE') {
      add('keywords', 'Timeline');
    } else {
      add(FAMILY_BUCKET[family] ?? 'other', display);
    }
  }
  for (const b of bracketsIn(text)) {
    if (!semanticBrackets || semanticBrackets.includes(b)) add('markup', b);
  }
  for (const k of Object.keys(refs)) refs[k].sort();
  return refs;
}

// Resolve markup to the English the game displays. Stat and battle-action tokens
// are lowercase lemmas ("health", "attacks") that the game capitalises at a
// sentence start, so we do the same.
export function resolveMarkup(text, map) {
  // Bracket tags are icons and carry no words; drop them and let extractRefs
  // keep the semantic ones. <5> becomes 5 — the per-rank value the game would
  // substitute at that position.
  const plain = stripIcons(text).replace(BRACKET, ' ').replace(RUNTIME, '$1');
  let out = '', last = 0;
  for (const m of plain.matchAll(TOKEN)) {
    const value = map[m[1]];
    if (value === undefined) throw new Error(`unresolved markup token {${m[1]}}`);
    out += plain.slice(last, m.index);
    const sentenceStart = out === '' || /[.!?:]\s+$|\n\s*$/.test(out);
    out += sentenceStart ? value.charAt(0).toUpperCase() + value.slice(1) : value;
    last = m.index + m[0].length;
  }
  // Dropping a bracket can leave a doubled space or a space before punctuation.
  return dropUnbalancedQuote(normPunct(out + plain.slice(last)).replace(/\s+([,.;:!?])/g, '$1'));
}

// Escape for literal matching, then let the game's own "(s)" pluralisation
// notation ("<1> turn(s) sooner") match a transcription that just wrote "turn".
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\(s\\\)/g, 's?');

// A transcription of a template string spells out what the game computes at
// display time: it appends the per-rank wording and the rank cap ("... 2% per
// rank. Maximum Bonus: 100% damage increase"), neither of which is in the
// shipped string. Removing that boilerplate is what lets the two be compared.
const stripRankBoilerplate = s => s
  .replace(/\s*Maximum Bonus:.*$/i, '')
  .replace(/\s+per rank\b/gi, '')
  .trim();

// Is `plain` the same sentence as `markup`, once each placeholder is allowed to
// stand for the wording it was filled with? This decides whether an existing hand
// transcription is merely the game's string with the typing flattened out — in
// which case it is kept and its annotation stays valid — or genuinely says
// something different, in which case the game's text wins and the manifest flags
// the annotation for re-review.
export function markupEquivalent(markup, plain) {
  const bare = normPunct(stripIcons(markup ?? '').replace(BRACKET, ' '));
  // Each {TOKEN} and <5> becomes one wildcard; the literal text between them has
  // to match exactly, which is what stops this matching unrelated sentences.
  // A token stands for a NAME — a status, stat, family, class or number — never a
  // clause, so its wildcard may not span a sentence boundary. Without that, a
  // token sitting before the final period lets the wildcard swallow whatever the
  // transcription added ("Gains Barrier." vs "Gains Barrier and also dies.") and
  // a reworded effect would keep its annotation.
  const pattern = '^' + bare.split(TOKEN_OR_RUNTIME).map(esc).join('([^.]*?)') + '$';
  // Case-insensitive: the game capitalises status and stat words that the
  // transcriptions left lowercase (and vice versa) all over the corpus, and a
  // pure case difference never changes what an effect does. Keeping it strict
  // would mark hundreds of annotations stale over "Sealed" vs "sealed".
  const re = new RegExp(pattern, 'i');
  const text = normPunct(plain);
  if (re.test(text)) return true;
  return hasRuntimeValue(markup) && re.test(stripRankBoilerplate(text));
}
