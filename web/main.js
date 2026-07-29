import { PICKERS, emptyQuery, runQuery, facetCounts, anyRuleScopedFilter } from '/filter.js';
import { initHighlight, cardHtml } from '/render.js';

const MAX_CARDS = 250;

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

function pickerHtml(cfg) {
  const sel = query.pickers[cfg.id];
  const { pairs, perInteraction } = facetCounts(index.records, query, `picker:${cfg.id}`);
  const perKey = new Map();
  for (const [pair, n] of pairs) {
    const k = pair.split('|')[0];
    if (k === '*') continue; // wildcard (unnamed statuses) serves any-key queries only
    perKey.set(k, (perKey.get(k) ?? 0) + n);
  }
  const options = [`<option value="">— any ${cfg.id} —</option>`,
    ...[...perKey.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<option value="${k}" ${sel.key === k ? 'selected' : ''}>${k} (${n})</option>`)];
  const chips = cfg.interactions.map(i => {
    const n = sel.key ? (pairs.get(`${sel.key}|${i}`) ?? 0) : (perInteraction.get(i) ?? 0);
    const on = sel.on.has(i);
    return `<span class="ichip ${on ? 'on' : ''} ${n === 0 && !on ? 'zero' : ''}" data-p="${cfg.id}" data-i="${i}">${i.replace(/_/g, ' ')} ${n}</span>`;
  }).join('');
  return `<div class="facet-group"><h3>${cfg.title}</h3>
    <select data-psel="${cfg.id}">${options.join('')}</select>
    <div class="ichips">${chips}</div></div>`;
}

function renderFacets() {
  const el = $('#facets');
  const scoped = anyRuleScopedFilter(query);
  el.innerHTML = `
    <button class="clear">Clear all filters</button>
    <label class="samerule ${scoped ? '' : 'idle'}" title="Require one rule to satisfy every trigger/action/actor/target/interaction filter, instead of the record merely containing each somewhere. Only changes results when two or more of those filters are active.">
      <input type="checkbox" id="samerule" ${query.sameRule ? 'checked' : ''}>
      <span>Match within a single rule</span>
    </label>
    ${PICKERS.map(pickerHtml).join('')}
    ${facetGroupHtml('Source', 'types', query.types, facetCounts(index.records, query, 'types'))}
    ${facetGroupHtml('Trigger', 'triggers', query.triggers, facetCounts(index.records, query, 'triggers'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Action', 'verbs', query.verbs, facetCounts(index.records, query, 'verbs'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Actor (who does it)', 'actors', query.actors, facetCounts(index.records, query, 'actors'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Target (who it hits)', 'targets', query.targets, facetCounts(index.records, query, 'targets'), v => v.replace(/_/g, ' '))}
  `;
  el.querySelector('.clear').onclick = () => {
    const q = query.q;
    const sameRule = query.sameRule;
    query = emptyQuery();
    query.q = q;
    query.sameRule = sameRule;
    render();
  };
  el.querySelector('#samerule').onchange = e => { query.sameRule = e.target.checked; render(); };
  el.querySelectorAll('.fv').forEach(fv => {
    fv.onclick = () => { toggle(query[fv.dataset.g], fv.dataset.v); render(); };
  });
  el.querySelectorAll('select[data-psel]').forEach(s => {
    s.onchange = () => { query.pickers[s.dataset.psel].key = s.value; render(); };
  });
  el.querySelectorAll('.ichip').forEach(c => {
    c.onclick = () => { toggle(query.pickers[c.dataset.p].on, c.dataset.i); render(); };
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
