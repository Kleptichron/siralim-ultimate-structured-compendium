// DOM rendering: result cards with rule chips, status-term highlighting,
// and hit-marking of chips that satisfy the active query.
import { matchingRules, anyRuleScopedFilter, chipApplied, chipAnyApplied } from './filter.js';
import { stateAttrs } from './a11y.js';

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let statusRe = null;
let statusKind = {};
export function initHighlight(statuses) {
  statusKind = Object.fromEntries(statuses.map(s => [s.name, s.kind]));
  const names = statuses.map(s => s.name).sort((a, b) => b.length - a.length).join('|');
  statusRe = new RegExp(`(?<![A-Za-z])(${names})s?(?![a-z])`, 'g');
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Statuses and search terms are collected as INTERVALS over the raw text, then
// merged and escaped in one pass. Highlighting in two passes would let the
// second one match inside the markup the first emitted — searching "mark" or
// "de" would corrupt a <mark class="debuff"> tag.
function hl(text, q = '', withStatuses = true) {
  const spans = [];
  if (statusRe && withStatuses) {
    statusRe.lastIndex = 0;
    for (let m; (m = statusRe.exec(text));) {
      spans.push({ s: m.index, e: m.index + m[0].length, cls: statusKind[m[1]] ?? '', status: true });
    }
  }
  // Substring, case-insensitive — exactly what the text filter matches on, so
  // the highlight always explains why a record is in the results.
  for (const t of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const re = new RegExp(escRe(t), 'gi');
    for (let m; (m = re.exec(text));) {
      spans.push({ s: m.index, e: m.index + m[0].length, cls: 'q', status: false });
      if (m.index === re.lastIndex) re.lastIndex++; // guard against a zero-width match
    }
  }
  if (!spans.length) return esc(text);
  // Longest first at a given start, statuses winning ties, then drop overlaps.
  spans.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s) || (b.status ? 1 : -1));
  let out = '', at = 0;
  for (const sp of spans) {
    if (sp.s < at) continue;
    out += esc(text.slice(at, sp.s)) + `<mark class="${sp.cls}">${esc(text.slice(sp.s, sp.e))}</mark>`;
    at = sp.e;
  }
  return out + esc(text.slice(at));
}

// The meta line as [label, value] pairs rather than one string: only the VALUES
// are searchable (the haystack is meta values), so only they may be
// highlighted — otherwise typing "class" would light up a label on every card
// without that being why the card matched. A null label prints the value on its
// own, for the entries that state what a record is rather than name a field.
// Empty, null and false values drop out, so nothing renders a bare "Rank:".
const META_FIELDS = {
  traits: m => [['Creature', m.creature], ['Family', m.family], ['Class', m.class],
    ['Material', m.material]],
  'enemy-traits': m => [[null, 'enemy-only trait'], ['Variant', m.variant]],
  spells: m => [['Class', m.class], ['Charges', m.charges]],
  // "ascension" must be visible: an ascension perk is absent from the spec's
  // perk list until the spec is ascended, so a reader comparing the card against
  // their own perk screen will conclude the data is wrong — that exact confusion
  // is how this line got here.
  perks: m => [['Specialization', m.specialization ?? 'unknown'], ['Ranks', m.ranks],
    [null, m.anointment && 'anointment'], [null, m.ascension && 'ascension'],
    [null, m.perRankValues && 'value shown is per rank']],
  relics: m => [['Relic', m.relic], ['God', m.god], ['Rank', m.rank], ['Stat bonus', m.statBonus]],
  cards: m => [['Family', m.family], ['Cards needed', m.tierRequired]],
  buffs: m => [[null, 'buff'], ['Duration', m.defaultDuration]],
  debuffs: m => [[null, 'debuff'], ['Duration', m.defaultDuration]],
  minions: m => [[null, 'minion'], ['Chance to leave', m.chanceToLeave]],
  realm: m => [['Applies to', m.target], [null, m.hidden && 'hidden']],
  nemesis: () => [[null, 'nemesis modifier']],
  specs: m => [[null, 'specialization'], ['Abbreviation', m.abbreviation]],
  'artifact-mods': () => [[null, 'artifact property']],
  'spell-gem-props': () => [[null, 'spell gem property']],
  blessings: m => [[null, 'blessing'], ['Patron', m.patron], ['Tier', m.tier]],
};

function metaHtml(rec, q) {
  const fields = META_FIELDS[rec.type]?.(rec.meta ?? {}) ?? [];
  const parts = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    .map(([label, v]) => (label
      ? `<span class="mk">${label}:</span> ${hl(String(v), q, false)}`
      : hl(String(v), q, false)));
  return parts.join(' · ');
}

function magText(m) {
  if (!m) return '';
  const bits = [];
  if (m.tier) bits.push(m.tier);
  if (m.amountPct !== undefined) bits.push(`${m.amountPct}%`);
  if (m.amountFlat !== undefined) bits.push(String(m.amountFlat));
  if (m.direction) bits.push(m.direction === 'up' ? '▲' : '▼');
  if (m.scaleStat) bits.push(`${m.scalePct ?? ''}% of ${m.scaleStat}`);
  if (m.scaleRef) bits.push(`${m.scalePct ?? ''}% of ${m.scaleRef.replace(/_/g, ' ')}`);
  if (m.per) bits.push(`per ${m.per}`);
  if (m.perRank) bits.push(`${m.perRank.per ?? ''}/rank max ${m.perRank.maxTotal ?? '?'}`);
  if (m.cap !== undefined) bits.push(`cap ${m.cap}`);
  return bits.join(' ');
}

// A chip carries the filters it stands for, so clicking it narrows the search
// to that term. Entries are ['g', group, value] or ['p', picker, key, interaction]
// or ['pct', min, max]; a chip with none is inert and must not look clickable.
const baseChip = (label, cls = '', filters = [], applied = false) => {
  if (!filters.length) return `<span class="chip ${cls}">${esc(label)}</span>`;
  const verb = applied ? 'Remove this from the search' : 'Add this to the search';
  return `<span class="chip ${cls} clickable" data-f="${esc(JSON.stringify(filters))}"
    title="${verb}" ${stateAttrs(esc(label), applied ? 'on' : '')}>${esc(label)}</span>`;
};

// Mirrors build-index's VERB_INTERACTION: clicking "Burning" on an apply_status
// action has to add status=Burning + inflicts, not just the key — the key alone
// would widen 37 results to 662.
const VERB_INTERACTION = {
  apply_status: s => (statusKind[s] === 'buff' ? 'grants' : 'inflicts'),
  remove_status: () => 'removes',
  steal_status: () => 'steals',
  prevent_status: () => 'prevents',
  status_modifier: () => 'modifies',
  detonate: () => 'detonates',
};

function ruleHtml(rule, query, mark) {
  const ps = query.pickers.status;
  const pst = query.pickers.stat;
  const pcl = query.pickers.class;
  const prc = query.pickers.race;
  // Highlight and toggle state both come from the chip's own filters, so a chip
  // lights up exactly when it is in the query — no per-kind bookkeeping to
  // forget. `idleCls` only applies when the chip is not highlighted (the
  // buff/debuff colouring on status chips).
  const chip = (label, idleCls = '', filters = []) => {
    const f = filters.filter(Boolean);
    const applied = chipApplied(query, f);
    const lit = applied || chipAnyApplied(query, f);
    const cls = [lit ? 'hit' : idleCls, applied ? 'applied' : ''].filter(Boolean).join(' ');
    return baseChip(label, cls, f, applied);
  };
  const parts = ['<span class="rk">when</span>'];
  const t = rule.trigger ?? {};
  parts.push(chip(t.type + (t.subject ? `: ${t.subject}` : ''), '', [['g', 'triggers', t.type]]));
  for (const c of rule.conditions ?? []) {
    parts.push('<span class="rk">if</span>');
    const st = c.params?.status ?? (c.params?.statuses ?? []).join('/');
    // Plural forms name several at once ("your Imlers and Imlings").
    const classes = c.params?.class ? [c.params.class] : (c.params?.classes ?? []);
    const races = c.params?.race ? [c.params.race] : (c.params?.races ?? []);
    const kr = [...classes, ...races].join('/');
    // A picker holds one key, so only pin it when the condition names exactly
    // one — otherwise just the interaction, which is still true and not a guess.
    const statuses = c.params?.status ? [c.params.status] : (c.params?.statuses ?? []);
    parts.push(chip(`${c.type}${c.who ? `[${c.who}]` : ''}${st ? ': ' + st : ''}${kr ? ': ' + kr : ''}`, '', [
      ['g', 'conditions', c.type],
      statuses.length === 1 && ['p', 'status', statuses[0], 'conditions_on'],
      classes.length === 1 && ['p', 'class', classes[0], 'conditions_on'],
      races.length === 1 && ['p', 'race', races[0], 'conditions_on'],
    ]));
  }
  if (rule.chance) parts.push(chip(`${rule.chance}% chance`, '', [['g', 'markers', 'chanceBased']]));
  parts.push('<span class="rk">do</span>');
  const resolve = v => (v === 'trigger_subject' ? (t.subject ?? v) : v);
  for (const a of rule.actions ?? []) {
    let label = a.verb;
    if (a.actor) label += ` @${a.actor}`;
    if (a.target) label += ` → ${a.target}`;
    // One click applies all three: the facets store the RESOLVED scope, so
    // trigger_subject has to be resolved here or the filter would miss.
    parts.push(chip(label, '', [
      ['g', 'verbs', a.verb],
      a.actor && ['g', 'actors', resolve(a.actor)],
      a.target && ['g', 'targets', resolve(a.target)],
    ]));
    const inter = VERB_INTERACTION[a.verb];
    for (const s of a.statuses ?? []) {
      parts.push(chip(s, `st-${statusKind[s] ?? ''}`, [['p', 'status', s, inter ? inter(s) : 'interacts']]));
    }
    if (a.statusKind) {
      // Unnamed statuses ("a random debuff") facet under a wildcard key. The
      // interaction comes from the VERB, not the kind — prevent_status on a
      // debuff is "*|prevents", not "*|inflicts" — and build-index emits no
      // wildcard at all when the action also names statuses, or when the verb
      // has no status interaction, so those stay inert.
      const named = (a.statuses ?? []).length > 0;
      const wild = named || !inter ? null
        : a.verb === 'apply_status' ? (a.statusKind === 'buff' ? 'grants' : 'inflicts')
        : inter('');
      parts.push(chip(`${a.qualifiers?.includes('random') ? 'random ' : ''}${a.statusKind}s`, '',
        wild ? [['p', 'status', '', wild]] : []));
    }
    if (a.stats?.length) {
      // Only stat_change and stat_rule produce stat interactions; stats listed
      // under equipment_modifier or status_modifier have nothing to filter on.
      const statInter = a.verb === 'stat_rule' ? 'modifies'
        : a.verb === 'stat_change' ? (a.magnitude?.direction === 'down' ? 'decreases' : 'increases')
        : null;
      parts.push(chip(a.stats.join(', '), '', statInter
        ? [['p', 'stat', a.stats.length === 1 ? a.stats[0] : '', statInter]]
        : []));
    }
    if (a.flow) {
      parts.push(chip(`${a.verb.startsWith('healing') || a.verb === 'heal' ? 'healing' : 'dmg'} ${a.flow}`, '',
        [['g', 'flows', a.flow]]));
    }
    for (const q of a.qualifiers ?? []) {
      if (q !== 'random' || !a.statusKind) parts.push(chip(q, '', [['g', 'qualifiers', q]]));
    }
    const mg = magText(a.magnitude);
    if (mg) {
      const m = a.magnitude;
      // A magnitude with only a flat amount or a `per` clause has no facet to
      // point at — those stay inert rather than pretending to be clickable.
      parts.push(chip(mg, '', [
        m.tier && ['g', 'tiers', m.tier],
        m.scaleRef && ['g', 'scaleRefs', m.scaleRef],
        m.scaleStat && ['p', 'stat', m.scaleStat, 'scales_with'],
        typeof m.amountPct === 'number' && ['pct', m.amountPct, m.amountPct],
      ]));
    }
  }
  return `<div class="rule ${mark ?? ''}">${parts.join('')}</div>`;
}

export function cardHtml(rec, query) {
  const meta = metaHtml(rec, query.q);
  const badges = [`<span class="badge type">${rec.type}</span>`];
  // Two different reasons a card can carry no rules, and they are not the same
  // promise to the reader. `stale` means it HAD an annotation and the source text
  // changed underneath it, so the old rules were withheld rather than shown
  // contradicting the text; the effect text on the card is still current.
  if (rec.status === 'stale') {
    badges.push('<span class="badge untagged" title="The game\'s text for this effect changed;'
      + ' its old rules were withheld pending re-review. The text shown is current.">text changed</span>');
  } else if (!rec.rules) badges.push('<span class="badge untagged">untagged</span>');
  else if (rec.provenance === 'machine') badges.push('<span class="badge machine">machine</span>');
  // With 2+ rules it's not obvious WHICH one answered the query — say so.
  const multi = (rec.rules ?? []).length > 1;
  const scoped = query.sameRule && multi && anyRuleScopedFilter(query);
  const matched = scoped ? new Set(matchingRules(rec, query)) : null;
  const rules = (rec.rules ?? [])
    .map((r, i) => ruleHtml(r, query, scoped ? (matched.has(i) ? 'matched' : 'unmatched') : ''))
    .join('');
  const flags = [];
  if (rec.flags?.stacks === false) flags.push('does not stack');
  if (rec.amplifies) flags.push(`amplifies: ${rec.amplifies.map(esc).join(', ')}`);
  if (rec.notes) flags.push(esc(rec.notes));
  // A real anchor, not a click handler: copy-link, middle-click and open-in-new
  // -tab all work for free, and the hashchange listener picks up the navigation.
  const link = `#id=${encodeURIComponent(rec.id)}`;
  // Only traits go into a build — a spell or relic has no slot to occupy.
  const addBtn = rec.type === 'traits'
    ? `<button class="addtrait" data-rove data-id="${esc(rec.id)}"
        title="Add to a creature in your build" aria-label="Add ${esc(rec.name)} to build">+</button>`
    : '';
  // Name and meta get search highlighting too: with creature names searchable,
  // the match is often in the meta line and nowhere in the effect text, which
  // otherwise looks like an unexplained result.
  // One tab stop per card, arrows move through its link, + button and chips.
  // Per-rule groups would be tidier but 250 cards x 2-4 rules is back to a tab
  // order nobody can get past.
  return `<div class="card" data-roving role="group" aria-label="${esc(rec.name)}">
    <div class="head"><a class="name" data-rove href="${link}" title="${esc(rec.id)}">${hl(rec.name, query.q, false)}</a>${badges.join('')}${addBtn}</div>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    <div class="text">${hl(rec.text, query.q)}</div>
    ${rules}
    ${flags.length ? `<div class="flags">${flags.join(' · ')}</div>` : ''}
  </div>`;
}
