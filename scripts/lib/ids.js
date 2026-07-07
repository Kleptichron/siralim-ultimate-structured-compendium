import { createHash } from 'node:crypto';

// U+0300..U+036F combining diacritics, built from code points so the source
// stays pure ASCII.
const COMBINING = new RegExp(
  '[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
  'g'
);

export function slug(s) {
  return s
    .normalize('NFKD')
    .replace(COMBINING, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normText(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Short content hash of the effect text; annotations store the hash they were
// tagged against so re-imports can flag drifted texts as stale.
export function textHash(s) {
  return createHash('sha1').update(normText(s)).digest('hex').slice(0, 12);
}

// id prefix -> directory under data/normalized|evidence|annotations|overrides
export const SOURCE_DIRS = {
  trait: 'traits',
  spell: 'spells',
  perk: 'perks',
  relic: 'relics',
  card: 'cards',
  buff: 'buffs',
  debuff: 'debuffs',
  minion: 'minions',
  nemesis: 'nemesis',
  realm: 'realm',
  spec: 'specs',
};

// IDs contain ':' which Windows filenames cannot; join id tail with '__'.
export function idToPath(id) {
  const [prefix, ...rest] = id.split(':');
  const dir = SOURCE_DIRS[prefix];
  if (!dir) throw new Error(`unknown id prefix in ${id}`);
  return { dir, file: rest.join('__') + '.json' };
}
