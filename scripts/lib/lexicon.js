import { readFileSync } from 'node:fs';

// Loads the closed vocabularies. statuses.json and families.json are generated
// by scripts/import.js from the game CSVs; the rest are curated by hand.
// All paths are relative to the repo root (scripts run via npm from root).
export function loadLexicon() {
  const read = f => JSON.parse(readFileSync(`data/lexicon/${f}`, 'utf8'));
  const statuses = read('statuses.json');
  const aliases = read('status-aliases.json'); // alias -> canonical name
  const formsOf = {};
  for (const s of statuses) formsOf[s.name] = [s.name];
  for (const [alias, canon] of Object.entries(aliases)) formsOf[canon]?.push(alias);
  return {
    statuses,
    statusNames: statuses.map(s => s.name),
    buffNames: statuses.filter(s => s.kind === 'buff').map(s => s.name),
    debuffNames: statuses.filter(s => s.kind === 'debuff').map(s => s.name),
    statusAliases: aliases,
    statusForms: formsOf, // canonical -> [canonical, ...aliases] for text matching
    statusMatchNames: [...statuses.map(s => s.name), ...Object.keys(aliases)],
    stats: read('stats.json'),
    classes: read('classes.json'),
    families: read('families.json'),
    keywords: read('keywords.json'),
    whitelist: read('whitelist.json'),
  };
}
