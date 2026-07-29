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

const MB = n => `${(n / 1048576).toFixed(1)} MB`;
// Let the browser actually paint before a long synchronous step, otherwise the
// message describing that step lands only after it has already finished.
// rAF does not fire at all in a backgrounded or non-compositing tab, so a timer
// backstop is required — without it, loading in a background tab hangs forever.
const paintTick = () => new Promise(resolve => {
  let settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  requestAnimationFrame(() => requestAnimationFrame(finish));
  setTimeout(finish, 50);
});

const GZIP_MAGIC = [0x1f, 0x8b];

// Streams a response so the progress bar reflects real bytes rather than a
// spinner that conveys nothing.
async function readWithProgress(res, onProgress) {
  // With Content-Encoding set, Content-Length counts COMPRESSED bytes while the
  // reader yields decompressed ones — the ratio is meaningless, so don't fake
  // it. That header also tells us the true transfer size, which is what the
  // reader can no longer observe.
  const encoded = !!res.headers.get('content-encoding');
  const declared = Number(res.headers.get('content-length')) || 0;
  const total = encoded ? 0 : declared;
  if (!res.body) { // no streaming support: still works, just no progress
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, transferred: declared || buf.length };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    read += value.length;
    onProgress(read, total);
  }
  const buf = new Uint8Array(read);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return { bytes: buf, transferred: encoded && declared ? declared : read };
}

const gunzip = async bytes =>
  new Uint8Array(await new Response(
    new Response(bytes).body.pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer());

// Prefers the pre-compressed copy: ~9x less over the wire, and whether that
// saving happens is otherwise entirely up to the host. Two shapes to handle —
// a host that labels it Content-Encoding: gzip (the browser decodes for us) and
// one that serves it as opaque bytes (we decode). Sniffing the gzip magic
// covers both without trusting headers. Falls back to the plain file.
async function fetchIndex(onProgress) {
  let lastErr;
  for (const url of ['/index.json.gz', '/index.json']) {
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = new Error(`server responded ${res.status} for ${url}`); continue; }
      let { bytes, transferred } = await readWithProgress(res, onProgress);
      if (bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
        if (typeof DecompressionStream === 'undefined') {
          lastErr = new Error('gzipped index but no DecompressionStream support');
          continue;
        }
        bytes = await gunzip(bytes);
      }
      const text = new TextDecoder().decode(bytes);
      // A dev server that answers unknown paths with the SPA shell returns
      // 200 + HTML, so res.ok proved nothing. Sniff the first character rather
      // than parsing 3MB twice — if this is not an object, try the next URL.
      if (text.trimStart()[0] !== '{') {
        lastErr = new Error(`${url} did not return JSON`);
        continue;
      }
      return { text, transferred, url };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('could not load the index');
}

async function loadIndex() {
  const el = $('#boot');
  const msg = el.querySelector('.boot-msg');
  const track = el.querySelector('.boot-track');
  const bar = el.querySelector('.boot-bar');
  const sub = el.querySelector('.boot-sub');
  // Reveal only if we are still working after 150ms — a warm cache beats it and
  // the panel never appears. Deliberately NOT cancelled once the download ends:
  // if parsing is what's slow, the panel should still show up and say so.
  setTimeout(() => el.classList.add('show'), 150);

  const { text, transferred } = await fetchIndex((got, total) => {
    if (!total) { track.classList.add('indeterminate'); sub.textContent = MB(got); return; }
    bar.style.width = `${Math.min(100, (got / total) * 100).toFixed(1)}%`;
    sub.textContent = `${MB(got)} of ${MB(total)}`;
  });

  track.classList.remove('indeterminate');
  bar.style.width = '100%';
  msg.textContent = 'Preparing index…';
  sub.textContent = `${MB(transferred)} downloaded`; // wire size, not inflated size
  await paintTick(); // the parse below blocks; make sure this message is visible first

  let parsed;
  {
    try {
      parsed = JSON.parse(text);
    } catch {
      // A dev server that answers unknown paths with the SPA shell returns
      // 200 + HTML here, so res.ok told us nothing. Say what actually happened
      // instead of surfacing "Unexpected token '<'".
      throw new Error('index.json did not contain JSON — is it built? (npm run build-index)');
    }
  }
  if (!parsed || !Array.isArray(parsed.records)) {
    throw new Error('index.json is missing its records array');
  }
  return parsed;
}

async function boot() {
  try {
    index = await loadIndex();
  } catch (err) {
    const el = $('#boot');
    el.classList.add('failed', 'show'); // already failed — no reason to hold it back
    el.querySelector('.boot-msg').textContent = 'Could not load the compendium.';
    el.querySelector('.boot-sub').textContent = String(err.message ?? err);
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = () => location.reload();
    el.append(retry);
    return;
  }
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
  document.body.classList.add('ready');
  $('#boot').remove();
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

// Which groups are collapsed. Held here rather than in the DOM because
// renderFacets rebuilds innerHTML on every click, which would otherwise reset
// every <details> the reader had opened. Not in the URL — it is a view
// preference, not part of the query being shared.
const collapsed = new Set([
  'conditions', 'flows', 'scaleRefs', 'tiers', 'qualifiers', 'markers',
  'class', 'race', // the two narrowest key pickers; status and stat stay open
]);

const MARKER_LABELS = {
  noStack: 'does not stack',
  chanceBased: 'chance-based',
  perRank: 'scales per rank',
  unmodeled: 'not fully modelled',
};

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
  // An active filter forces its group open — a collapsed group hiding the
  // reason the result count dropped would be baffling.
  const active = selected.size || excluded.size;
  const open = active || !collapsed.has(group) ? ' open' : '';
  const badge = active ? `<span class="gcount">${selected.size + excluded.size}</span>` : '';
  return `<details class="facet-group" data-group="${group}"${open}>
    <summary><h3>${title}</h3>${badge}</summary>${rows}</details>`;
}

// A dropdown instead of rows: 169 families would be an unusable list, and the
// existing key pickers already establish the select idiom for long vocabularies.
// Option order is frozen like every other group so the list never reshuffles.
function facetSelectHtml(title, group, counts) {
  const selected = [...query[group]][0] ?? '';
  const options = [`<option value="">— any ${title.toLowerCase()} —</option>`];
  for (const v of facetOrder[group]) {
    const n = counts.get(v) ?? 0;
    if (!n && v !== selected) continue; // a dropdown can hide empties without shifting anything
    options.push(`<option value="${v}" ${v === selected ? 'selected' : ''}>${v} (${n})</option>`);
  }
  const badge = selected ? '<span class="gcount">1</span>' : '';
  const open = selected || !collapsed.has(group) ? ' open' : '';
  return `<details class="facet-group" data-group="${group}"${open}>
    <summary><h3>${title}</h3>${badge}</summary>
    <select data-fsel="${group}">${options.join('')}</select></details>`;
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
  const active = (sel.key ? 1 : 0) + sel.on.size + sel.off.size;
  const open = active || !collapsed.has(cfg.id) ? ' open' : '';
  const badge = active ? `<span class="gcount">${active}</span>` : '';
  return `<details class="facet-group" data-group="${cfg.id}"${open}>
    <summary><h3>${cfg.title}</h3>${badge}</summary>
    <select data-psel="${cfg.id}">${options.join('')}</select>
    <div class="ichips">${chips}</div></details>`;
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
    ${facetSelectHtml('Creature family', 'families', facetCounts(index.records, query, 'families'))}
    ${PICKERS.map(pickerHtml).join('')}
    ${facetGroupHtml('Source', 'types', query.types, facetCounts(index.records, query, 'types'))}
    ${facetGroupHtml('Trigger', 'triggers', query.triggers, facetCounts(index.records, query, 'triggers'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Action', 'verbs', query.verbs, facetCounts(index.records, query, 'verbs'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Actor (who does it)', 'actors', query.actors, facetCounts(index.records, query, 'actors'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Target (who it hits)', 'targets', query.targets, facetCounts(index.records, query, 'targets'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Condition', 'conditions', query.conditions, facetCounts(index.records, query, 'conditions'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Scales with', 'scaleRefs', query.scaleRefs, facetCounts(index.records, query, 'scaleRefs'), v => v.replace(/_/g, ' '))}
    ${facetGroupHtml('Damage / healing flow', 'flows', query.flows, facetCounts(index.records, query, 'flows'))}
    ${facetGroupHtml('Magnitude tier', 'tiers', query.tiers, facetCounts(index.records, query, 'tiers'))}
    ${facetGroupHtml('Qualifier', 'qualifiers', query.qualifiers, facetCounts(index.records, query, 'qualifiers'))}
    ${facetGroupHtml('Properties', 'markers', query.markers, facetCounts(index.records, query, 'markers'), v => MARKER_LABELS[v] ?? v)}
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
  el.querySelectorAll('select[data-fsel]').forEach(s => {
    s.onchange = () => {
      query[s.dataset.fsel] = new Set(s.value ? [s.value] : []);
      render({ push: true });
    };
  });
  el.querySelectorAll('.ichip').forEach(c => {
    const sel = query.pickers[c.dataset.p];
    c.onclick = () => { cycle(sel.on, sel.off, c.dataset.i); render({ push: true }); };
  });
  // Record collapse intent from the summary CLICK, not the toggle event:
  // parsing <details open> during the innerHTML rebuild fires toggle too, so a
  // group force-opened by an active filter would silently lose its default.
  // At click time `open` still holds the pre-click state.
  el.querySelectorAll('details[data-group] > summary').forEach(s => {
    s.onclick = () => {
      const d = s.parentElement;
      if (d.open) collapsed.add(d.dataset.group); else collapsed.delete(d.dataset.group);
    };
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
