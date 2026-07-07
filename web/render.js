// DOM rendering: result cards with rule chips, status-term highlighting,
// and hit-marking of chips that satisfy the active query.

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let statusRe = null;
let statusKind = {};
export function initHighlight(statuses) {
  statusKind = Object.fromEntries(statuses.map(s => [s.name, s.kind]));
  const names = statuses.map(s => s.name).sort((a, b) => b.length - a.length).join('|');
  statusRe = new RegExp(`(?<![A-Za-z])(${names})s?(?![a-z])`, 'g');
}

function hl(text) {
  return esc(text).replace(statusRe, (m, name) => `<mark class="${statusKind[name] ?? ''}">${m}</mark>`);
}

const META_LINES = {
  traits: m => `${m.creature} · ${m.family} · ${m.class}${m.material ? ' · ' + m.material : ''}`,
  spells: m => `${m.class}${m.charges ? ' · ' + m.charges + ' charges' : ''}`,
  perks: m => `${m.specialization} · ${m.ranks} rank${m.ranks > 1 ? 's' : ''}${m.anointment ? ' · anointment' : ''}`,
  relics: m => `${m.relic} · rank ${m.rank} · ${m.statBonus}`,
  cards: m => `${m.family} · ${m.tierRequired} cards`,
  buffs: m => `buff${m.defaultDuration ? ' · ' + m.defaultDuration : ''}`,
  debuffs: m => `debuff${m.defaultDuration ? ' · ' + m.defaultDuration : ''}`,
  minions: m => `minion · leaves: ${m.chanceToLeave}`,
  realm: m => `${m.target}${m.hidden ? ' · hidden' : ''}`,
  nemesis: () => 'nemesis modifier',
  specs: m => `specialization · ${m.abbreviation}`,
};

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

const chip = (label, cls = '') => `<span class="chip ${cls}">${esc(label)}</span>`;

function ruleHtml(rule, query) {
  const ps = query.pickers.status;
  const pst = query.pickers.stat;
  const pcl = query.pickers.class;
  const prc = query.pickers.race;
  const parts = ['<span class="rk">when</span>'];
  const t = rule.trigger ?? {};
  parts.push(chip(t.type + (t.subject ? `: ${t.subject}` : ''), query.triggers.has(t.type) ? 'hit' : ''));
  for (const c of rule.conditions ?? []) {
    parts.push('<span class="rk">if</span>');
    const st = c.params?.status ?? (c.params?.statuses ?? []).join('/');
    const kr = c.params?.class ?? c.params?.race;
    const hit =
      (ps.on.has('conditions_on') && st && (!ps.key || st.includes(ps.key)))
      || (pcl.on.has('conditions_on') && c.params?.class && (!pcl.key || c.params.class === pcl.key))
      || (prc.on.has('conditions_on') && c.params?.race && (!prc.key || c.params.race === prc.key));
    parts.push(chip(`${c.type}${c.who ? `[${c.who}]` : ''}${st ? ': ' + st : ''}${kr ? ': ' + kr : ''}`, hit ? 'hit' : ''));
  }
  if (rule.chance) parts.push(chip(`${rule.chance}% chance`));
  parts.push('<span class="rk">do</span>');
  for (const a of rule.actions ?? []) {
    const hit = query.verbs.has(a.verb) ? 'hit' : '';
    let label = a.verb;
    if (a.actor) label += ` @${a.actor}`;
    if (a.target) label += ` → ${a.target}`;
    parts.push(chip(label, hit));
    for (const s of a.statuses ?? []) {
      const sHit = ps.on.size && (!ps.key || ps.key === s) ? 'hit' : `st-${statusKind[s] ?? ''}`;
      parts.push(chip(s, sHit));
    }
    if (a.statusKind) parts.push(chip(`${a.qualifiers?.includes('random') ? 'random ' : ''}${a.statusKind}s`));
    if (a.stats?.length) {
      const stHit = pst.on.size && (!pst.key || a.stats.includes(pst.key)) ? 'hit' : '';
      parts.push(chip(a.stats.join(', '), stHit));
    }
    if (a.flow) parts.push(chip(`dmg ${a.flow}`));
    for (const q of a.qualifiers ?? []) if (q !== 'random' || !a.statusKind) parts.push(chip(q));
    const mg = magText(a.magnitude);
    if (mg) parts.push(chip(mg, pst.on.has('scales_with') && a.magnitude?.scaleStat && (!pst.key || a.magnitude.scaleStat === pst.key) ? 'hit' : ''));
  }
  return `<div class="rule">${parts.join('')}</div>`;
}

export function cardHtml(rec, query) {
  const metaFn = META_LINES[rec.type];
  const badges = [`<span class="badge type">${rec.type}</span>`];
  if (!rec.rules) badges.push('<span class="badge untagged">untagged</span>');
  else if (rec.provenance === 'machine') badges.push('<span class="badge machine">machine</span>');
  const rules = (rec.rules ?? []).map(r => ruleHtml(r, query)).join('');
  const flags = [];
  if (rec.flags?.stacks === false) flags.push('does not stack');
  if (rec.notes) flags.push(esc(rec.notes));
  return `<div class="card">
    <div class="head"><span class="name">${esc(rec.name)}</span>${badges.join('')}</div>
    ${metaFn ? `<div class="meta">${esc(metaFn(rec.meta ?? {}))}</div>` : ''}
    <div class="text">${hl(rec.text)}</div>
    ${rules}
    ${flags.length ? `<div class="flags">${flags.join(' · ')}</div>` : ''}
  </div>`;
}
