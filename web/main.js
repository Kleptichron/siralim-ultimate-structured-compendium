import {
  PICKERS, SORTS, PAGE, EXCLUDABLE, emptyQuery, runQuery, sortResults, facetCounts,
  anyRuleScopedFilter, queryToHash, hashToQuery,
} from '/filter.js';
import { initHighlight, cardHtml } from '/render.js';

// Cards render at roughly 20µs each, so a 250-card chunk costs ~5ms while the
// full 4,068 costs ~110ms. Revealing in chunks AND resetting on every query
// change keeps typing cheap no matter how deep the reader has scrolled.
let index = null;
let query = emptyQuery();
let lastResults = [];

const $ = sel => document.querySelector(sel);

// --- URL as the single source of truth for a search -----------------------
// Discrete filter changes push a history entry (so Back undoes one filter);
// typing only replaces it, which keeps history clean and stays well under
// Safari's replaceState rate limit.
let lastHash = null;
let urlTimer = null;

// mode: 'push'    — a distinct search, Back should undo it
//       'replace' — same search, new view (revealing more); write it now
//       'defer'   — typing; coalesce so we do not replaceState per keystroke
function syncUrl(mode) {
  const s = queryToHash(query);
  if (s === lastHash) return;
  lastHash = s;
  const url = s ? `#${s}` : location.pathname + location.search;
  clearTimeout(urlTimer);
  const apply = () => history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  if (mode === 'defer') urlTimer = setTimeout(apply, 250); else apply();
}

function adoptUrl() {
  const incoming = location.hash.replace(/^#/, '');
  if (incoming === lastHash) return; // our own write echoing back
  query = hashToQuery(incoming); // carries sort + reveal count
  lastHash = queryToHash(query);
  $('#search').value = query.q;
  paint();
}

async function boot() {
  index = await (await fetch('/index.json')).json();
  initHighlight(index.statuses);
  computeFacetOrder();
  $('#coverage').textContent =
    `${index.counts.tagged}/${index.counts.total} tagged · schema v${index.schemaVersion}`;
  query = hashToQuery(location.hash);
  lastHash = queryToHash(query);
  $('#search').value = query.q;
  $('#search').addEventListener('input', e => { query.q = e.target.value; render(); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#search')) {
      e.preventDefault();
      $('#search').focus();
    }
  });
  // popstate covers Back/Forward; hashchange covers editing the address bar.
  addEventListener('popstate', adoptUrl);
  addEventListener('hashchange', adoptUrl);
  render();
}

// Three states, cycled by clicking: off -> include -> exclude -> off. No hidden
// modifier key, so it is discoverable and works on touch.
function cycle(inc, exc, v) {
  if (inc.has(v)) { inc.delete(v); exc.add(v); }
  else if (exc.has(v)) exc.delete(v);
  else inc.add(v);
}

// Row order and membership are frozen at boot from the UNFILTERED corpus.
// Recomputing either per render made the sidebar jump under the cursor: one
// click drops ~29 rows across the groups and re-sorting by count moves nearly
// every survivor, so the row you just clicked slides out from under the mouse.
// Now only the numbers and the highlight change; nothing moves.
let facetOrder = {};

function computeFacetOrder() {
  const base = emptyQuery();
  facetOrder = Object.fromEntries(EXCLUDABLE.map(group => [
    group,
    [...facetCounts(index.records, base, group).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => v),
  ]));
}

function facetGroupHtml(title, group, selected, counts, labelFn = x => x) {
  const excluded = query.excluded[group];
  const order = [...facetOrder[group]];
  // A value can be selected without being in the corpus order (e.g. a typo in a
  // pasted URL) — show it anyway so it can be cleared.
  for (const v of [...selected, ...excluded]) if (!order.includes(v)) order.push(v);
  const rows = order.map(v => {
    const n = counts.get(v) ?? 0;
    const state = selected.has(v) ? 'on' : excluded.has(v) ? 'off' : '';
    const hint = excluded.has(v) ? 'excluded — click to clear' : 'click to include, again to exclude';
    return `<div class="fv ${state} ${n === 0 && !state ? 'zero' : ''}" data-g="${group}" data-v="${v}" title="${hint}">
       <span>${labelFn(v)}</span><span class="n">${n}</span>
     </div>`;
  }).join('');
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
    const state = sel.on.has(i) ? 'on' : sel.off.has(i) ? 'off' : '';
    // Count sits in a fixed-width slot: chips are inline and wrap, so a count
    // shrinking from 4 digits to 1 would reflow the block to fewer lines and
    // shove every group below it upward — the other half of the jumping.
    return `<span class="ichip ${state} ${n === 0 && !state ? 'zero' : ''}" data-p="${cfg.id}" data-i="${i}">${i.replace(/_/g, ' ')} <span class="cn">${n}</span></span>`;
  }).join('');
  return `<div class="facet-group"><h3>${cfg.title}</h3>
    <select data-psel="${cfg.id}">${options.join('')}</select>
    <div class="ichips">${chips}</div></div>`;
}

function renderFacets() {
  const el = $('#facets');
  const scrollTop = el.scrollTop; // rebuilding innerHTML would otherwise jump to top
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
    // Text, match mode and sort are not filters — clearing filters keeps them.
    const { q, sameRule, sort } = query;
    query = Object.assign(emptyQuery(), { q, sameRule, sort });
    render({ push: true });
  };
  el.querySelector('#samerule').onchange = e => {
    query.sameRule = e.target.checked;
    render({ push: true });
  };
  el.querySelectorAll('.fv').forEach(fv => {
    const g = fv.dataset.g;
    fv.onclick = () => { cycle(query[g], query.excluded[g], fv.dataset.v); render({ push: true }); };
  });
  el.querySelectorAll('select[data-psel]').forEach(s => {
    s.onchange = () => { query.pickers[s.dataset.psel].key = s.value; render({ push: true }); };
  });
  el.querySelectorAll('.ichip').forEach(c => {
    const sel = query.pickers[c.dataset.p];
    c.onclick = () => { cycle(sel.on, sel.off, c.dataset.i); render({ push: true }); };
  });
  el.scrollTop = scrollTop;
}

const num = n => n.toLocaleString();

function renderResultBar() {
  const total = lastResults.length;
  const visible = Math.min(query.shown, total);
  const count = total > visible
    ? `showing ${num(visible)} of ${num(total)} results`
    : `${num(total)} result${total === 1 ? '' : 's'}`;
  const opts = SORTS.map(s =>
    `<option value="${s.id}" ${query.sort === s.id ? 'selected' : ''}>${s.label}</option>`).join('');
  $('#resultbar').innerHTML =
    `<span>${count}</span><label class="sort">sort <select id="sort">${opts}</select></label>`;
  $('#sort').onchange = e => { query.sort = e.target.value; render({ push: true }); };
}

function renderMore() {
  const remaining = lastResults.length - Math.min(query.shown, lastResults.length);
  const el = $('#more');
  if (remaining <= 0) { el.innerHTML = ''; return; }
  const next = Math.min(PAGE, remaining);
  el.innerHTML = `
    <button class="showmore">Show ${num(next)} more</button>
    ${remaining > next ? `<button class="showall">Show all ${num(lastResults.length)}</button>` : ''}
    <span class="dim">${num(remaining)} not shown</span>`;
  el.querySelector('.showmore').onclick = () => reveal(query.shown + PAGE);
  el.querySelector('.showall')?.addEventListener('click', () => reveal(lastResults.length));
}

// Append only the newly revealed cards: the ones already on screen are
// unchanged, and the facet sidebar does not depend on how many are visible.
// Revealing more is not a new search, so it replaces the history entry rather
// than pushing one — the URL still updates, so the link stays copyable.
function reveal(upTo) {
  const from = query.shown;
  query.shown = Math.min(upTo, lastResults.length);
  $('#results').insertAdjacentHTML('beforeend',
    lastResults.slice(from, query.shown).map(r => cardHtml(r, query)).join(''));
  syncUrl('replace');
  renderResultBar();
  renderMore();
}

function paint() {
  lastResults = sortResults(runQuery(index.records, query), query);
  renderResultBar();
  $('#results').innerHTML = lastResults.slice(0, query.shown).map(r => cardHtml(r, query)).join('');
  renderMore();
  renderFacets();
}

function render({ push = false } = {}) {
  query.shown = PAGE; // a new query starts at the top
  syncUrl(push ? 'push' : 'defer');
  paint();
}

boot();
