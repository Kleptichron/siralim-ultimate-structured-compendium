// Taking things out of the site: a build you want to post, or a result set you
// want to work on somewhere else.
//
// The serializers are pure string functions with no DOM in them, so they can be
// checked against the real index in Node rather than only by eye in a browser.

// --- shared -----------------------------------------------------------------

const words = v => (v ?? '').replace(/_/g, ' ');
const list = (a, sep = '; ') => (a ?? []).map(words).join(sep);

// "Bomb|inflicts" -> "Bomb (inflicts)". The wildcard key means an unnamed
// status ("a random debuff"), which has no name worth printing.
const pairs = a => (a ?? [])
  .map(p => { const [k, i] = p.split('|'); return k === '*' ? words(i) : `${k} (${words(i)})`; })
  .join('; ');

// The meta line each type shows on its card, minus the fields that already have
// their own column — so nothing is silently dropped from the export.
const OWN_COLUMN = new Set(['class', 'family', 'creature']);
const details = rec => Object.entries(rec.meta ?? {})
  .filter(([k, v]) => !OWN_COLUMN.has(k) && v !== '' && v !== false && v != null)
  .map(([k, v]) => (v === true ? k : `${k}: ${v}`))
  .join('; ');

function recordNotes(rec) {
  const bits = [];
  if (rec.flags?.stacks === false) bits.push('does not stack');
  if (rec.amplifies?.length) bits.push(`amplifies: ${rec.amplifies.join(', ')}`);
  if (rec.notes) bits.push(rec.notes);
  return bits.join('; ');
}

export const permalink = (origin, id) => `${origin}/#id=${encodeURIComponent(id)}`;

// --- results: CSV -----------------------------------------------------------

// Columns follow the card: what it is, then what the rule model says about it.
// Multi-valued facets collapse to "; " lists — one row per record keeps the
// file usable as a table, which is the whole reason to pick CSV.
const COLUMNS = [
  ['id', r => r.id],
  ['name', r => r.name],
  ['type', r => r.type],
  ['class', r => r.meta?.class ?? ''],
  ['family', r => r.meta?.family ?? ''],
  ['creature', r => r.meta?.creature ?? ''],
  ['details', details],
  ['effect', r => r.text],
  ['triggers', r => list(r.facets?.triggers)],
  ['conditions', r => list(r.facets?.conditions)],
  ['actions', r => list(r.facets?.verbs)],
  ['actors', r => list(r.facets?.actors)],
  ['targets', r => list(r.facets?.targets)],
  ['statuses', r => pairs(r.facets?.statusInteractions)],
  ['stats', r => pairs(r.facets?.statInteractions)],
  ['classes', r => pairs(r.facets?.classInteractions)],
  ['races', r => pairs(r.facets?.raceInteractions)],
  ['flow', r => list(r.facets?.flows)],
  ['magnitude', r => list(r.facets?.tiers)],
  ['percents', r => (r.facets?.pcts ?? []).map(p => {
    const bar = p.lastIndexOf('|');
    return `${words(p.slice(0, bar))}: ${p.slice(bar + 1)}%`;
  }).join('; ')],
  ['qualifiers', r => list(r.facets?.qualifiers)],
  ['scales with', r => [...(r.facets?.scaleRefs ?? []), ...(r.facets?.scaleStats ?? [])].map(words).join('; ')],
  ['properties', r => list(r.facets?.markers)],
  ['notes', r => recordNotes(r)],
];

// A leading =, +, - or @ makes a spreadsheet treat the cell as a formula. Every
// column here is text, so prefixing is safe and stops a pasted effect text from
// executing in Excel.
const RISKY = /^[=+\-@\t\r]/;
function csvCell(v) {
  let s = String(v ?? '').replace(/\r?\n/g, ' ');
  if (RISKY.test(s)) s = `'${s}`;
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsToCsv(records, origin = '') {
  const cols = origin ? [...COLUMNS, ['link', r => permalink(origin, r.id)]] : COLUMNS;
  const rows = [cols.map(c => c[0]).join(',')];
  for (const r of records) rows.push(cols.map(([, get]) => csvCell(get(r))).join(','));
  return rows.join('\r\n') + '\r\n'; // CRLF: what RFC 4180 says and what Excel wants
}

// --- results: Markdown ------------------------------------------------------

const mdCell = s => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

// Deliberately narrow: a 25-column table is unreadable in a post, and anyone
// who wants every field wants the CSV. Name, what it is, where it comes from,
// what it does.
export function resultsToMarkdown(records, origin = '', title = '') {
  const head = title ? `## ${title}\n\n` : '';
  const rows = [
    '| Name | Type | Source | Effect |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of records) {
    const src = [r.meta?.creature, r.meta?.family, r.meta?.class, details(r)].filter(Boolean).join(' · ');
    const name = origin ? `[${mdCell(r.name)}](${permalink(origin, r.id)})` : mdCell(r.name);
    rows.push(`| ${name} | ${r.type} | ${mdCell(src)} | ${mdCell(r.text)} |`);
  }
  return head + rows.join('\n') + '\n';
}

// --- results: JSON ----------------------------------------------------------

// `_hay` is a lazily cached search string filter.js hangs off the record — an
// implementation detail that must not leak into an export.
export function resultsToJson(records, meta = {}) {
  return `${JSON.stringify({
    ...meta,
    count: records.length,
    records: records.map(({ _hay, ...rest }) => rest),
  }, null, 2)}\n`;
}

// --- build ------------------------------------------------------------------

// Markdown because the destination is a post or a chat message. Kept flat —
// headings and one bullet per trait — so it renders the same on Reddit, Discord
// and GitHub rather than relying on nested lists that only some of them handle.
export function buildToMarkdown(build, byId, {
  url = '', slotLabels, netherSlots = 4, summary, warnings = [], placeLabel = p => `slot ${p.slot + 1}`,
} = {}) {
  const out = ['# Siralim team'];
  if (url) out.push('', url);

  const limit = build.nether ? netherSlots : 3;
  let creatureNo = 0;
  for (const row of build.slots) {
    const slots = row.slice(0, limit);
    if (slots.every(id => !id)) continue; // an empty creature is not worth a heading
    creatureNo++;
    const lead = byId.get(slots.find(Boolean));
    const label = lead?.meta?.creature ? ` — ${lead.meta.creature}` : '';
    out.push('', `### Creature ${creatureNo}${label}`, '');
    slots.forEach((id, s) => {
      if (!id) return;
      const rec = byId.get(id);
      if (!rec) { out.push(`- ${slotLabels[s]}: *unknown trait (${id})*`); return; }
      // The trait's own creature is worth printing even when it repeats the
      // heading: fused and artifact traits routinely come from elsewhere.
      const from = [rec.meta?.creature, rec.meta?.class].filter(Boolean).join(' · ');
      out.push(`- **${slotLabels[s]}:** ${rec.name}${from ? ` *(${from})*` : ''} — ${rec.text}`);
    });
  }

  if (!creatureNo) out.push('', '*No traits chosen yet.*');

  if (warnings.length) {
    out.push('', '### Warnings', '');
    for (const w of warnings) out.push(`- **${w.name}** ${w.note} — ${w.places.map(placeLabel).join(', ')}`);
  }

  if (summary?.count) {
    out.push('', '### Team summary', '');
    out.push(`- ${summary.count} trait${summary.count === 1 ? '' : 's'} chosen`);
    const tally = a => a.map(([n, c]) => `${words(n)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
    if (summary.statuses.length) out.push(`- Applies: ${tally(summary.statuses)}`);
    if (summary.triggers.length) out.push(`- Fires on: ${tally(summary.triggers)}`);
  }
  return out.join('\n') + '\n';
}

// --- getting it out of the page ---------------------------------------------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Denied permission, or an insecure origin. A selected textarea still works
    // in every browser that ships execCommand, which is all of them.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function downloadFile(filename, text, mime) {
  // The BOM is for Excel, which otherwise reads a UTF-8 CSV as the local
  // codepage and mangles every non-ASCII name. Only on the download: a BOM in
  // the clipboard would paste as a stray character.
  const bom = mime.startsWith('text/csv') ? '﻿' : '';
  const url = URL.createObjectURL(new Blob([bom + text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
