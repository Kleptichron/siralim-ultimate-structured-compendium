import { normText } from './ids.js';

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-ish boundary matcher for game vocabulary. Case-sensitive: game terms are
// always capitalized in effect text ("Attack" the stat vs "attacks" the verb).
// Allows plural 's' ("Bombs"). The Immune buff must not swallow "immune to X"
// immunity phrasing (lowercase anyway) nor "Immune to" at sentence start.
export function termRegex(name, flags = 'g') {
  const guard = name === 'Immune' ? '(?! to)' : '';
  return new RegExp(`(?<![A-Za-z])${escapeRe(name)}s?${guard}(?![a-z])`, flags);
}

function replaceNames(t, names, ph) {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const n of sorted) t = t.replace(termRegex(n), ph);
  return t;
}

// Typed-placeholder normalization: texts that differ only in numbers, statuses,
// families, stats, classes, or damage-tier words share a template key. Used for
// cluster-consistency validation and dedup, not workload compression (~13%).
export function templateKey(text, lex) {
  let t = normText(text);
  t = replaceNames(t, lex.statusMatchNames, '@S');
  t = replaceNames(t, lex.families, '@F');
  t = replaceNames(t, lex.stats, '@T');
  t = replaceNames(t, lex.classes, '@C');
  t = t.replace(/\b(small|moderate|large|massive|devastating)\b/g, '@M');
  t = t.replace(/\d+(\.\d+)?%?/g, '@N');
  return t;
}
