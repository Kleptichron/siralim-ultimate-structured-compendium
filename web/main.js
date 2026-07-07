import { emptyQuery, runQuery, facetCounts } from '/filter.js';
import { initHighlight, cardHtml } from '/render.js';

const MAX_CARDS = 250;
const INTERACTIONS = [
  'inflicts', 'grants', 'removes', 'prevents', 'modifies', 'steals',
  'detonates', 'triggers_off', 'conditions_on',
];

let index = null;
let query = emptyQuery();

const $ = sel => document.querySelector(sel);

async function boot() {
  index = await (await fetch('/index.json')).json();
  initHighlight(index.statuses);
  $('#coverage').textContent =
    `${index.counts.tagged}/${index.counts.total} tagged · schema v${index.schemaVersion}`;
  $('#search').addEventListener('input', e => { query.q = e.target.value; render(); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#search')) {
      e.preventDefault();
      $('#search').focus();
    }
  });
  render();
}

function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

function facetGroupHtml(title, group, selected, counts, labelFn = x => x) {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const v of selected) if (!counts.has(v)) entries.push([v, 0]);
  const rows = entries.map(([v, n]) =>
    `<div class="fv ${selected.has(v) ? 'on' : ''} ${n === 0 ? 'zero' : ''}" data-g="${group}" data-v="${v}">
       <span>${labelFn(v)}</span><span class="n">${n}</span>
     </div>`).join('');
  return `<div class="facet-group"><h3>${title}</h3>${rows}</div>`;
}

function statusFacetHtml() {
  const counts = facetCounts(index.records, query, 'statusInteractions');
  const perStatus = new Map();
  for (const [si, n] of counts) {
    const [s] = si.split('|');
    perStatus.set(s, (perStatus.get(s) ?? 0) + n);
  }
  const options = ['<option value="">— status —</option>',
    ...[...perStatus.entries()].sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `<option value="${s}" ${query.status === s ? 'selected' : ''}>${s} (${n})</option>`)];
  const chips = INTERACTIONS.map(i => {
    const n = query.status ? (counts.get(`${query.status}|${i}`) ?? 0) : 0;
    const on = query.interactions.has(i);
    return `<span class="ichip ${on ? 'on' : ''}" data-i="${i}">${i.replace('_', ' ')}${query.status ? ` ${n}` : ''}</span>`;
  }).join('');
  return `<div class="facet-group"><h3>Status × interaction</h3>
    <select id="status-sel">${options.join('')}</select>
    <div class="ichips">${chips}</div></div>`;
}

function renderFacets() {
  const el = $('#facets');
  el.innerHTML = `
    <button class="clear">Clear all filters</button>
    ${statusFacetHtml()}
    ${facetGroupHtml('Source', 'types', query.types, facetCounts(index.records, query, 'types'))}
    ${facetGroupHtml('Trigger', 'triggers', query.triggers, facetCounts(index.records, query, 'triggers'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Action', 'verbs', query.verbs, facetCounts(index.records, query, 'verbs'), v => v.replace(/_/g, ' '))}
  `;
  el.querySelector('.clear').onclick = () => {
    const q = query.q;
    query = emptyQuery();
    query.q = q;
    render();
  };
  el.querySelectorAll('.fv').forEach(fv => {
    fv.onclick = () => { toggle(query[fv.dataset.g], fv.dataset.v); render(); };
  });
  const sel = el.querySelector('#status-sel');
  sel.onchange = () => { query.status = sel.value; render(); };
  el.querySelectorAll('.ichip').forEach(c => {
    c.onclick = () => { toggle(query.interactions, c.dataset.i); render(); };
  });
}

function render() {
  const results = runQuery(index.records, query);
  $('#resultbar').textContent =
    `${results.length} result${results.length === 1 ? '' : 's'}` +
    (results.length > MAX_CARDS ? ` (showing first ${MAX_CARDS})` : '');
  $('#results').innerHTML = results.slice(0, MAX_CARDS).map(r => cardHtml(r, query)).join('');
  renderFacets();
}

boot();
