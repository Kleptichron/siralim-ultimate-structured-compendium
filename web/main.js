import {
  PICKERS, SORTS, PAGE, EXCLUDABLE, emptyQuery, cloneQuery, runQuery, sortResults,
  facetCounts, anyRuleScopedFilter, activeFilterCount, pctRangeActive,
  canUseAllMode, isAllMode, chipApplied, queryToHash, hashToQuery,
} from '/filter.js';
import { initHighlight, cardHtml } from '/render.js';
import { initRoving, stateAttrs, captureFocus, restoreFocus } from '/a11y.js';
import {
  buildToMarkdown, resultsToCsv, resultsToMarkdown, resultsToJson, copyText, downloadFile,
} from '/export.js';
import {
  SLOTS, TRAITS_PER_CREATURE, SLOT_LABELS, SLOT_KEYS, SLOT_REFUSAL, slotAccepts, placeLabel,
  emptyBuild, buildToParam, buildFromParam,
  buildIsEmpty, buildWarnings, buildSummary, buildCount, saveBuild, loadBuild,
} from '/build.js';

// Cards render at roughly 20µs each, so a 250-card chunk costs ~5ms while the
// full 4,068 costs ~110ms. Revealing in chunks AND resetting on every query
// change keeps typing cheap no matter how deep the reader has scrolled.
let index = null;
let query = emptyQuery();
let lastResults = [];
let build = emptyBuild();
let buildMode = false;
let byId = new Map();       // trait lookup for the builder
let traitByName = new Map();

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
  const s = modeHash();
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
  const params = new URLSearchParams(incoming);
  buildMode = params.has('build');
  if (buildMode) {
    // Deliberately NOT saved: opening someone's shared link should not
    // overwrite the build you were working on. Editing it does save, so a
    // build you actually touch becomes your working copy.
    build = buildFromParam(params.get('build'), params.get('nether') === '1');
  } else {
    query = hashToQuery(incoming); // carries sort + reveal count
    $('#search').value = query.q;
  }
  lastHash = modeHash();
  applyMode();
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
  // Trait lookups for the builder: names are unique corpus-wide, so a
  // type-ahead by name resolves to exactly one trait.
  const traits = index.records.filter(r => r.type === 'traits');
  byId = new Map(traits.map(r => [r.id, r]));
  traitByName = new Map(traits.map(r => [r.name.toLowerCase(), r]));
  const options = rs => rs.map(r => `<option value="${attr(r.name)}">`).join('');
  $('#traitnames').innerHTML = options(traits); // nether stones take anything
  $('#traitnames-creature').innerHTML = options(traits.filter(r => slotAccepts(r, 0)));
  $('#traitnames-artifact').innerHTML = options(traits.filter(r => slotAccepts(r, 2)));

  // A shared link always wins; otherwise pick up the working copy from storage.
  const bootParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  buildMode = bootParams.has('build');
  if (buildMode) build = buildFromParam(bootParams.get('build'), bootParams.get('nether') === '1');
  else build = loadBuild() ?? emptyBuild();
  query = hashToQuery(location.hash);
  lastHash = modeHash();
  $('#search').value = query.q;
  $('#search').addEventListener('input', e => { query.q = e.target.value; render(); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('#search')) {
      e.preventDefault();
      $('#search').focus();
    }
  });
  // Jumping past the header lands ON the region, so the next Tab enters it —
  // and the sidebar has to be open for "skip to filters" to mean anything.
  for (const b of document.querySelectorAll('.skip')) {
    b.onclick = () => {
      const el = $(b.dataset.skip);
      if (el === $('#facetsinner')) setNav(true);
      el.focus();
      el.scrollIntoView({ block: 'start' });
    };
  }
  $('#buildtoggle').onclick = () => {
    buildMode = !buildMode;
    closeAddMenu();
    // Leaving an empty build should land on the search, not a stale hash.
    lastHash = null;
    syncUrl('push');
    applyMode();
  };
  // Dismiss the menu the way a menu should dismiss.
  document.addEventListener('click', e => {
    if (!e.target.closest('#addmenu') && !e.target.closest('.addtrait')) closeAddMenu();
    if (!e.target.closest('#xmenu') && !e.target.closest('#xtoggle')) closeExportMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    closeAddMenu();
    closeExportMenu();
  });
  addEventListener('resize', () => { closeAddMenu(); closeExportMenu(); });

  // Open on desktop, shut on phones where it would cover the results.
  setNav(!narrow());
  $('#navtoggle').onclick = () => setNav(document.body.classList.contains('nav-closed'));
  $('#backdrop').onclick = () => setNav(false);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && narrow() && !document.body.classList.contains('nav-closed')) setNav(false);
  });
  // Crossing the breakpoint (rotation, resize) re-applies the right default,
  // otherwise a drawer left open becomes a stuck column on desktop.
  window.matchMedia('(max-width: 760px)').addEventListener('change', e => setNav(!e.matches));

  // Delegated once: #results is rebuilt wholesale on every paint, so per-chip
  // handlers would be re-attached thousands of times.
  $('#results').addEventListener('click', e => {
    const add = e.target.closest('.addtrait');
    if (add) { openAddMenu(add.dataset.id, add); return; }
    const el = e.target.closest('.chip.clickable');
    if (!el) return;
    const entries = JSON.parse(el.dataset.f);
    // Toggle: a chip already fully in the query removes itself. A partly
    // applied chip completes instead, rather than tearing down what is there.
    const removing = chipApplied(query, entries);
    for (const [kind, a, b, c] of entries) {
      if (kind === 'g') {
        if (removing) query[a].delete(b); else query[a].add(b);
      } else if (kind === 'p') {
        const sel = query.pickers[a];
        if (removing) {
          sel.on.delete(c);
          // The key belongs to the picker, not this chip — only clear it once
          // nothing is left selecting against it.
          if (!sel.on.size && !sel.off.size) sel.key = '';
        } else {
          if (b) sel.key = b; // a picker holds one key; an empty one means "any"
          sel.on.add(c);
        }
      } else if (kind === 'pct') {
        if (removing) { query.pctMin = null; query.pctMax = null; }
        else { query.pctMin = a; query.pctMax = b; }
      }
    }
    render({ push: true });
  });

  // popstate covers Back/Forward; hashchange covers editing the address bar.
  addEventListener('popstate', adoptUrl);
  addEventListener('hashchange', adoptUrl);
  applyMode();
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
  facetOrder = Object.fromEntries(EXCLUDABLE.map(group => {
    const seen = [...facetCounts(index.records, base, group).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v]) => v);
    // Some scales read wrong by frequency — magnitude tiers belong in size
    // order (small → devastating), not "moderate, large, small, …".
    const canonical = index.ordered?.[group];
    if (!canonical) return [group, seen];
    const rest = seen.filter(v => !canonical.includes(v));
    return [group, [...canonical.filter(v => seen.includes(v)), ...rest]];
  }));
}

// Which groups are collapsed. Held here rather than in the DOM because
// renderFacets rebuilds innerHTML on every click, which would otherwise reset
// every <details> the reader had opened. Not in the URL — it is a view
// preference, not part of the query being shared.
const collapsed = new Set([
  'conditions', 'flows', 'scaleRefs', 'tiers', 'qualifiers', 'markers', 'pct',
  'class', 'race', // the two narrowest key pickers; status and stat stay open
]);

// Short names for the summary chips, where the sidebar's headings are too long.
const GROUP_LABEL = {
  types: 'source', triggers: 'when', verbs: 'action', actors: 'actor',
  targets: 'target', conditions: 'if', flows: 'flow', scaleRefs: 'scales with',
  tiers: 'tier', qualifiers: 'qualifier', markers: '', families: 'family',
};

const MARKER_LABELS = {
  noStack: 'does not stack',
  chanceBased: 'chance-based',
  perRank: 'scales per rank',
  unmodeled: 'not fully modelled',
};

// Shown from the FIRST selected value, not the second: with one selected the
// two modes return the same records, but ALL re-counts everything else as "how
// many co-occur with this", which is the only way to see which values can
// actually be combined. Never shown for groups where a record holds just one
// value — "source: cards AND traits" is always empty, a trap rather than a
// feature.
function allModeToggle(group, selectedCount) {
  if (!canUseAllMode(group) || selectedCount < 1) return '';
  const all = query.allOf.has(group);
  const hint = all
    ? (selectedCount > 1
      ? 'records must carry ALL of these — counts show what each would narrow to'
      : 'counts now show what co-occurs with this, i.e. what can be added')
    : 'records carry ANY of these — switch to ALL to see what combines';
  // A real button, not a span: it is a control in a header, not part of a
  // roving group, so it should be its own tab stop.
  return `<button type="button" class="anyall" data-group="${group}" data-fk="aa:${group}"
    aria-pressed="${all}" aria-label="Match ${all ? 'all' : 'any'} of the selected values"
    title="${hint} — click to switch">
    <span class="${all ? '' : 'sel'}">any</span><span class="${all ? 'sel' : ''}">all</span></button>`;
}

// How many results an exclusion actually removes. The plain count answers "how
// many if I INCLUDE this", which is the wrong question once a value is
// excluded — and is why excluding a 0-count value looks broken rather than
// inert. Cheap: only ever computed for the handful of excluded values.
function exclusionImpact(mutate) {
  const sub = cloneQuery(query);
  mutate(sub);
  return runQuery(index.records, sub).length - lastResults.length;
}

function facetGroupHtml(title, group, selected, counts, labelFn = x => x) {
  const excluded = query.excluded[group];
  const order = [...facetOrder[group]];
  // A value can be selected without being in the corpus order (e.g. a typo in a
  // pasted URL) — show it anyway so it can be cleared.
  for (const v of [...selected, ...excluded]) if (!order.includes(v)) order.push(v);
  const rows = order.map(v => {
    let n = counts.get(v) ?? 0;
    const state = selected.has(v) ? 'on' : excluded.has(v) ? 'off' : '';
    let hint = 'click to include, again to exclude';
    let inert = '';
    if (state === 'off') {
      n = exclusionImpact(sub => sub.excluded[group].delete(v));
      hint = n ? `excluded — hiding ${n} — click to clear` : 'excluded, but nothing here has it — no effect';
      if (!n) inert = ' inert';
      return `<div class="fv off${inert}" data-g="${group}" data-v="${v}" data-fk="fv:${group}:${v}" title="${hint}"
         ${stateAttrs(`${title}: ${labelFn(v)}`, 'off')}>
         <span>${labelFn(v)}</span><span class="n">−${n}</span>
       </div>`;
    }
    return `<div class="fv ${state} ${n === 0 && !state ? 'zero' : ''}" data-g="${group}" data-v="${v}" data-fk="fv:${group}:${v}" title="${hint}"
       ${stateAttrs(`${title}: ${labelFn(v)}`, state)}>
       <span>${labelFn(v)}</span><span class="n">${n}</span>
     </div>`;
  }).join('');
  // An active filter forces its group open — a collapsed group hiding the
  // reason the result count dropped would be baffling.
  const active = selected.size || excluded.size;
  const open = active || !collapsed.has(group) ? ' open' : '';
  const badge = active ? `<span class="gcount">${selected.size + excluded.size}</span>` : '';
  return `<details class="facet-group" data-group="${group}"${open}>
    <summary><h3>${title}</h3>${badge}${allModeToggle(group, selected.size)}</summary>
    <div data-roving role="group" aria-label="${title} values">${rows}</div></details>`;
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

// Percentage magnitudes mean different things per verb (20% more damage vs 20%
// more Attack), so the range is most useful alongside an Action filter — and it
// is rule-scoped, so "damage_modifier at 100%+" means one action is both.
function pctRangeHtml() {
  const active = query.pctMin !== null || query.pctMax !== null;
  const open = active || !collapsed.has('pct') ? ' open' : '';
  const val = v => (v === null ? '' : v);
  return `<details class="facet-group" data-group="pct"${open}>
    <summary><h3>Magnitude %</h3>${active ? '<span class="gcount">1</span>' : ''}</summary>
    <div class="pctrange">
      <input type="number" id="pctmin" min="0" step="5" placeholder="min" value="${val(query.pctMin)}">
      <span class="dim">to</span>
      <input type="number" id="pctmax" min="0" step="5" placeholder="max" value="${val(query.pctMax)}">
    </div></details>`;
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
    let n = sel.key ? (pairs.get(`${sel.key}|${i}`) ?? 0) : (perInteraction.get(i) ?? 0);
    const state = sel.on.has(i) ? 'on' : sel.off.has(i) ? 'off' : '';
    if (state === 'off') {
      // Same reasoning as the facet rows: show what the exclusion removes, so
      // an impossible pairing (a debuff can never be "granted") reads as −0.
      n = exclusionImpact(sub => sub.pickers[cfg.id].off.delete(i));
      const hint = n ? `excluded — hiding ${n}` : 'excluded, but nothing here has it — no effect';
      return `<span class="ichip off${n ? '' : ' inert'}" data-p="${cfg.id}" data-i="${i}" data-fk="ic:${cfg.id}:${i}" title="${hint}"
        ${stateAttrs(`${sel.key || 'any'} ${i.replace(/_/g, ' ')}`, 'off')}>${i.replace(/_/g, ' ')} <span class="cn">−${n}</span></span>`;
    }
    // Count sits in a fixed-width slot: chips are inline and wrap, so a count
    // shrinking from 4 digits to 1 would reflow the block to fewer lines and
    // shove every group below it upward — the other half of the jumping.
    return `<span class="ichip ${state} ${n === 0 && !state ? 'zero' : ''}" data-p="${cfg.id}" data-i="${i}" data-fk="ic:${cfg.id}:${i}"
      ${stateAttrs(`${sel.key || 'any'} ${i.replace(/_/g, ' ')}`, state)}>${i.replace(/_/g, ' ')} <span class="cn">${n}</span></span>`;
  }).join('');
  const active = (sel.key ? 1 : 0) + sel.on.size + sel.off.size;
  const open = active || !collapsed.has(cfg.id) ? ' open' : '';
  const badge = active ? `<span class="gcount">${active}</span>` : '';
  return `<details class="facet-group" data-group="${cfg.id}"${open}>
    <summary><h3>${cfg.title}</h3>${badge}${allModeToggle(cfg.id, sel.on.size)}</summary>
    <select data-psel="${cfg.id}">${options.join('')}</select>
    <div class="ichips" data-roving role="group" aria-label="${cfg.title} interactions">${chips}</div></details>`;
}

function renderFacets() {
  // Written into the persistent inner wrapper, not the aside: the wrapper owns
  // the scroll position and the fixed width the collapse animation clips.
  const el = $('#facetsinner');
  const scrollTop = el.scrollTop; // rebuilding innerHTML would otherwise jump to top
  const scoped = anyRuleScopedFilter(query);
  el.innerHTML = `
    <button class="clear">Clear all filters</button>
    <label class="samerule ${scoped ? '' : 'idle'}" title="Action, actor, target, flow, qualifier and magnitude filters must all be satisfied by the SAME action, together with its rule's trigger and conditions. Untick to match them anywhere in the record. Only changes results when two or more such filters are active.">
      <input type="checkbox" id="samerule" ${query.sameRule ? 'checked' : ''}>
      <span>Match within a single action</span>
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
    ${pctRangeHtml()}
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
  for (const [id, key] of [['#pctmin', 'pctMin'], ['#pctmax', 'pctMax']]) {
    const input = el.querySelector(id);
    input.onchange = () => {
      const v = input.value.trim();
      query[key] = v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
      render({ push: true });
    };
  }
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
  el.querySelectorAll('.anyall').forEach(t => {
    t.onclick = e => {
      e.preventDefault();  // don't let the click collapse the group
      e.stopPropagation();
      const g = t.dataset.group;
      if (query.allOf.has(g)) query.allOf.delete(g); else query.allOf.add(g);
      render({ push: true });
    };
  });
  el.querySelectorAll('details[data-group] > summary').forEach(s => {
    s.onclick = () => {
      const d = s.parentElement;
      if (d.open) collapsed.add(d.dataset.group); else collapsed.delete(d.dataset.group);
    };
  });
  initRoving(el);
  el.scrollTop = scrollTop;
}

const num = n => n.toLocaleString();

function renderResultBar() {
  // The bar is rebuilt on every paint, so an open menu would be left anchored
  // to a button that no longer exists.
  closeExportMenu(false);
  const total = lastResults.length;
  const visible = Math.min(query.shown, total);
  if (query.recordId) {
    // Say plainly that this is one effect, not a search — and that a stale or
    // mistyped id is the reason the page is empty, rather than showing "0".
    $('#resultbar').innerHTML = total
      ? `<span>one effect · <span class="dim">${query.recordId}</span></span>
         <button class="showall-link">Show all effects</button>`
      : `<span>No effect with id <span class="dim">${query.recordId}</span></span>
         <button class="showall-link">Show all effects</button>`;
    $('#resultbar').querySelector('.showall-link').onclick = () => {
      query = emptyQuery();
      render({ push: true });
    };
    return;
  }
  const count = total > visible
    ? `showing ${num(visible)} of ${num(total)} results`
    : `${num(total)} result${total === 1 ? '' : 's'}`;
  const opts = SORTS.map(s =>
    `<option value="${s.id}" ${query.sort === s.id ? 'selected' : ''}>${s.label}</option>`).join('');
  $('#resultbar').innerHTML =
    `<span>${count}</span><label class="sort">sort <select id="sort">${opts}</select></label>
     <div class="bexport"><button class="bx" id="xtoggle" data-fk="x:toggle"
       aria-haspopup="menu" aria-expanded="false" ${total ? '' : 'disabled'}>Export…</button></div>`;
  $('#sort').onchange = e => { query.sort = e.target.value; render({ push: true }); };
  $('#xtoggle').onclick = () => (isXMenuOpen() ? closeExportMenu() : openExportMenu());
}

// --- exporting the result set ----------------------------------------------
// The whole matching set, not the revealed page: the filter is what the reader
// built, and "export" that silently meant "the first 250" would be a trap.
// Sizes are estimated from per-record averages measured over the full index —
// serialising 4,068 records just to label a menu item would stall the click.
const BYTES_PER_RECORD = { md: 240, csv: 340, json: 1825 };
const approx = (n, kind) => {
  const b = n * BYTES_PER_RECORD[kind];
  return b < 1048576 ? `~${Math.max(1, Math.round(b / 1024))} KB` : `~${(b / 1048576).toFixed(1)} MB`;
};

const isXMenuOpen = () => !$('#xmenu').hidden;

// What the reader filtered to, as a line of prose — it becomes the Markdown
// heading, so a pasted table says what it is a table of.
function exportTitle() {
  const chips = activeChips();
  return chips.length
    ? `${num(lastResults.length)} results · ${chips.map(c => c.label).join(' · ')}`
    : `All ${num(lastResults.length)} effects`;
}

function openExportMenu() {
  const el = $('#xmenu');
  const n = lastResults.length;
  const item = (x, label, note) =>
    `<button class="xitem" role="menuitem" data-rove data-x="${x}" data-fk="x:${x}">
       <span>${label}</span><span class="dim">${note}</span></button>`;
  el.innerHTML = `<div class="xhead">Exporting <strong>${num(n)}</strong> result${n === 1 ? '' : 's'}
      — everything the filter matches, not just what is shown.</div>
    ${item('md', 'Copy as Markdown', `table · name, type, source, effect · ${approx(n, 'md')}`)}
    ${item('csv', 'Download CSV', `every facet as a column · ${approx(n, 'csv')}`)}
    ${item('json', 'Download JSON', `the full rule model · ${approx(n, 'json')}`)}`;
  el.hidden = false;
  $('#xtoggle').setAttribute('aria-expanded', 'true');

  const r = $('#xtoggle').getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;

  el.querySelectorAll('.xitem').forEach(b => {
    b.onclick = () => {
      const origin = location.origin + location.pathname;
      const stamp = { generated: index.generated, schemaVersion: index.schemaVersion, query: location.hash.replace(/^#/, '') };
      if (b.dataset.x === 'md') {
        flash(b.querySelector('span'), copyText(resultsToMarkdown(lastResults, origin, exportTitle())), 'Markdown copied');
        return;
      }
      const csv = b.dataset.x === 'csv';
      downloadFile(
        `su-compendium-results-${lastResults.length}.${csv ? 'csv' : 'json'}`,
        csv ? resultsToCsv(lastResults, origin) : resultsToJson(lastResults, stamp),
        csv ? 'text/csv' : 'application/json',
      );
      say(`Downloaded ${num(lastResults.length)} results as ${csv ? 'CSV' : 'JSON'}`);
      closeExportMenu();
    };
  });
  // The container persists across opens while its contents do not, so the
  // "already wired" flag has to be cleared or the second open would arrow
  // through items that no longer exist.
  delete el.dataset.roved;
  initRoving(el);
  el.querySelector('.xitem').focus();
}

// returnFocus is off when the bar itself is being rebuilt: the button we would
// hand focus back to is about to be replaced, and render() restores focus to
// whatever the reader was actually using.
function closeExportMenu(returnFocus = true) {
  const el = $('#xmenu');
  if (el.hidden) return;
  el.hidden = true;
  const t = $('#xtoggle');
  if (t) {
    t.setAttribute('aria-expanded', 'false');
    if (returnFocus) t.focus();
  }
}

function renderMore() {
  const remaining = lastResults.length - Math.min(query.shown, lastResults.length);
  const el = $('#more');
  if (remaining <= 0) { el.innerHTML = ''; return; }
  const next = Math.min(PAGE, remaining);
  el.innerHTML = `
    <button class="showmore" data-fk="more:next">Show ${num(next)} more</button>
    ${remaining > next ? `<button class="showall" data-fk="more:all">Show all ${num(lastResults.length)}</button>` : ''}
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
  initRoving($('#results')); // only the appended cards: the rest are flagged
  syncUrl('replace');
  renderResultBar();
  const focused = captureFocus();
  renderMore();
  restoreFocus(focused); // keep "Show 250 more" pressable twice running
}

// --- sidebar visibility -----------------------------------------------------
// One control, two behaviours: on desktop it collapses the column so results
// get the full width; below the breakpoint the sidebar is an overlay drawer,
// because a fixed 320px column left only 55px for results on a phone.
const narrow = () => window.matchMedia('(max-width: 760px)').matches;

function setNav(open) {
  document.body.classList.toggle('nav-closed', !open);
  $('#navtoggle').setAttribute('aria-expanded', String(open));
  $('#backdrop').hidden = !(open && narrow()); // backdrop only for the drawer
}

function syncNavCount() {
  const n = activeFilterCount(query);
  $('#navcount').textContent = n ? String(n) : '';
}

const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Every filter currently applied, as one removable chip each. With 16 groups
// and most collapsed by default, the sidebar alone can't answer "why am I
// seeing these results" — and when it's collapsed or drawered it isn't even on
// screen. Sort and match-mode are deliberately absent: they shape the ordering
// and the reading, not which records qualify.
function activeChips() {
  const chips = [];
  const add = (kind, label, off = false) => chips.push({ kind, label, off });
  const valueLabel = (g, v) => (g === 'markers' ? MARKER_LABELS[v] ?? v : String(v).replace(/_/g, ' '));
  // Say "all" in the chip when the group demands every value — otherwise two
  // chips look identical whether they mean AND or OR.
  const prefix = (g, size) => {
    const base = GROUP_LABEL[g] ? GROUP_LABEL[g] : '';
    const all = isAllMode(query, g, size) ? (base ? ' (all)' : 'all: ') : '';
    return base ? `${base}${all}: ` : all;
  };

  if (query.q) add('q', `“${query.q}”`);
  for (const g of EXCLUDABLE) {
    for (const v of query[g]) add(`set:${g}:${v}`, `${prefix(g, query[g].size)}${valueLabel(g, v)}`);
    for (const v of query.excluded[g]) add(`ex:${g}:${v}`, `${prefix(g, 0)}${valueLabel(g, v)}`, true);
  }
  for (const cfg of PICKERS) {
    const sel = query.pickers[cfg.id];
    // "(all)" goes at the END so it qualifies the whole chip — mid-phrase it
    // read as "any status (all) grants", which parses as nonsense.
    const suffix = isAllMode(query, cfg.id, sel.on.size) ? ' (all)' : '';
    const subject = sel.key || `any ${cfg.id}`;
    if (sel.key) add(`pk:${cfg.id}:key`, `${cfg.id}: ${sel.key}`);
    for (const i of sel.on) add(`pk:${cfg.id}:on:${i}`, `${subject} ${i.replace(/_/g, ' ')}${suffix}`);
    for (const i of sel.off) add(`pk:${cfg.id}:off:${i}`, `${subject} ${i.replace(/_/g, ' ')}`, true);
  }
  if (pctRangeActive(query)) {
    const lo = query.pctMin, hi = query.pctMax;
    const range = lo !== null && hi !== null ? `${lo}–${hi}%` : lo !== null ? `≥ ${lo}%` : `≤ ${hi}%`;
    add('pct', `magnitude ${range}`);
  }
  return chips;
}

// Takes the query to act on so the empty state can try removals on a copy
// without disturbing what is on screen.
function removeChip(q, kind) {
  const [head, ...rest] = kind.split(':');
  if (head === 'q') { q.q = ''; return; }
  if (head === 'pct') { q.pctMin = null; q.pctMax = null; return; }
  if (head === 'set' || head === 'ex') {
    const group = rest[0];
    const value = rest.slice(1).join(':'); // ids can contain ':'
    (head === 'set' ? q[group] : q.excluded[group]).delete(value);
    return;
  }
  if (head === 'pk') {
    const [id, which, ...iRest] = rest;
    const sel = q.pickers[id];
    if (which === 'key') sel.key = '';
    else sel[which === 'on' ? 'on' : 'off'].delete(iRest.join(':'));
  }
}

function renderActiveFilters() {
  const el = $('#activefilters');
  // In permalink mode the result bar already explains the view.
  const chips = query.recordId ? [] : activeChips();
  if (!chips.length) { el.innerHTML = ''; return; }
  el.innerHTML = chips.map(c =>
    `<button class="afchip ${c.off ? 'off' : ''}" data-kind="${attr(c.kind)}" data-fk="af:${attr(c.kind)}"
       title="Remove this filter">${attr(c.label)}<span class="x">×</span></button>`).join('')
    + '<button class="afclear">Clear all</button>';
  el.querySelectorAll('.afchip').forEach(b => {
    b.onclick = () => {
      removeChip(query, b.dataset.kind);
      if (b.dataset.kind === 'q') $('#search').value = '';
      render({ push: true });
    };
  });
  el.querySelector('.afclear').onclick = () => {
    const { q, sameRule, sort } = query;
    query = Object.assign(emptyQuery(), { q, sameRule, sort });
    render({ push: true });
  };
}

// Nothing matched. Rather than a bare "0 results", work out what would actually
// help and offer it: 31% of two-chip combinations taken from one card drop that
// card under action scoping, and 86% of those come back by relaxing the match
// mode — so a blank screen is usually one click from what the reader wanted.
function renderEmptyState() {
  const el = $('#results');
  if (query.recordId) { el.innerHTML = ''; return; } // the bar already explains
  const options = [];

  if (query.sameRule && anyRuleScopedFilter(query)) {
    const relaxed = cloneQuery(query);
    relaxed.sameRule = false;
    const n = runQuery(index.records, relaxed).length;
    if (n) {
      options.push({ act: 'relax', label: `Match anywhere in the record instead`, n });
    }
  }
  // Which single filter is costing the most? Cheap — a handful of active chips.
  let best = null;
  for (const c of activeChips()) {
    const sub = cloneQuery(query);
    removeChip(sub, c.kind);
    const n = runQuery(index.records, sub).length;
    // No added quotes: the text-query chip already carries its own.
    if (n && (!best || n > best.n)) best = { act: 'drop', kind: c.kind, label: `Drop ${c.label}`, n };
  }
  if (best) options.push(best);

  el.innerHTML = `<div class="empty">
    <p class="empty-title">Nothing matches all of these filters.</p>
    ${options.length
      ? `<p class="dim">Closest ways back:</p><div class="empty-acts">${options.map(o =>
          `<button data-act="${o.act}"${o.kind ? ` data-kind="${attr(o.kind)}"` : ''}>${attr(o.label)}
             <span class="n">${num(o.n)}</span></button>`).join('')}</div>`
      : '<p class="dim">Try removing a filter, or search for a creature or effect name.</p>'}
  </div>`;
  el.querySelectorAll('.empty-acts button').forEach(b => {
    b.onclick = () => {
      if (b.dataset.act === 'relax') query.sameRule = false;
      else { removeChip(query, b.dataset.kind); if (b.dataset.kind === 'q') $('#search').value = ''; }
      render({ push: true });
    };
  });
}

// --- add-to-build menu -----------------------------------------------------
// Six creatures x three or four slots is too many for a flat list, so the menu
// is a grid: one row per creature, one button per slot, each showing what is
// already there. Picking an occupied slot replaces it — the alternative, hiding
// full slots, makes a full build look broken rather than replaceable.
function openAddMenu(traitId, anchor) {
  const el = $('#addmenu');
  const rec = byId.get(traitId);
  if (!rec) return;
  const slotCount = build.nether ? TRAITS_PER_CREATURE : 3;
  const rows = build.slots.map((row, c) => {
    const label = creatureLabel(row);
    const buttons = row.slice(0, slotCount).map((id, s) => {
      const held = byId.get(id);
      const isThis = id === traitId;
      // Disabled rather than hidden: a missing Artifact column would read as a
      // rendering fault, where a greyed one with a reason teaches the rule.
      const ok = slotAccepts(rec, s);
      const title = !ok ? `${rec.name} ${SLOT_REFUSAL[SLOT_KEYS[s]]}`
        : held ? `replaces ${held.name}`
        : `empty ${SLOT_LABELS[s]} slot`;
      return `<button class="amslot${held ? ' filled' : ''}${isThis ? ' same' : ''}"
        data-c="${c}" data-s="${s}" ${ok ? '' : 'disabled'} title="${attr(title)}">
        <span class="amslot-label">${SLOT_LABELS[s][0]}</span>
        <span class="amslot-held">${held ? attr(held.name) : '—'}</span>
      </button>`;
    }).join('');
    return `<div class="amrow">
      <div class="amname">Creature ${c + 1}${label ? `<span class="dim"> · ${attr(label)}</span>` : ''}</div>
      <div class="amslots">${buttons}</div>
    </div>`;
  }).join('');

  // Name the restriction once at the top rather than leaving the reader to
  // hover a greyed button to find out why half the grid is unavailable.
  // The two exclusions never overlap, so every slot a given trait is refused
  // from is refused for the same reason — the first one speaks for all of them.
  const firstBlocked = SLOT_KEYS.slice(0, slotCount).findIndex((_, s) => !slotAccepts(rec, s));
  const why = firstBlocked === -1 ? ''
    : `<div class="amwhy">${attr(rec.name)} ${attr(SLOT_REFUSAL[SLOT_KEYS[firstBlocked]])}</div>`;
  el.innerHTML = `<div class="amhead">Add <strong>${attr(rec.name)}</strong> to…</div>${why}${rows}
    <div class="amfoot"><label><input type="checkbox" id="amnether" ${build.nether ? 'checked' : ''}>
      <span>Nether stone slot</span></label><button class="amclose">Close</button></div>`;
  el.hidden = false;

  // Anchor under the button, clamped so it never leaves the viewport.
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const top = r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  el.querySelectorAll('.amslot').forEach(b => {
    b.onclick = () => {
      build.slots[+b.dataset.c][+b.dataset.s] = traitId;
      saveBuild(build);
      closeAddMenu();
      syncBuildBadge();
      if (buildMode) renderBuild();
    };
  });
  $('#amnether').onchange = e => {
    build.nether = e.target.checked;
    saveBuild(build);
    openAddMenu(traitId, anchor); // re-render with the extra column
    $('#amnether').focus();       // ...without yanking focus off the checkbox
  };
  el.querySelector('.amclose').onclick = closeAddMenu;
  // Opened from the keyboard the menu is useless unless focus follows it there
  // and comes back afterwards — Escape would otherwise strand you at the top of
  // the document. Re-rendering for the nether checkbox keeps the same opener.
  addMenuOpener = anchor;
  el.querySelector('.amslot:not([disabled])')?.focus(); // a disabled button cannot take it
}

let addMenuOpener = null;

function closeAddMenu() {
  const el = $('#addmenu');
  if (el.hidden) return;
  el.hidden = true;
  if (addMenuOpener?.isConnected) addMenuOpener.focus();
  addMenuOpener = null;
}

function syncBuildBadge() {
  const n = buildCount(build);
  $('#buildtoggle').textContent = n ? `Build ${n}` : 'Build';
  $('#buildtoggle').classList.toggle('on', buildMode);
}

// --- team builder ----------------------------------------------------------

function creatureLabel(row) {
  // Name the slot after whatever its innate pick belongs to, so the sheet reads
  // as a team rather than a list of loose traits.
  const rec = byId.get(row[0]);
  return rec?.meta?.creature ? `${rec.meta.creature} · ${rec.meta.family}` : '';
}

// Innate and Fusion both want creature traits; Artifact wants a material; a
// nether stone takes anything.
const SLOT_LIST = ['traitnames-creature', 'traitnames-creature', 'traitnames-artifact', 'traitnames'];

function slotInputHtml(c, s, id) {
  const rec = byId.get(id);
  const wrong = rec && !slotAccepts(rec, s);
  return `<label class="bslot">
    <span class="bslot-label">${SLOT_LABELS[s]}</span>
    <input list="${SLOT_LIST[s]}" data-c="${c}" data-s="${s}" data-fk="bs:${c}:${s}" placeholder="trait name…"
      value="${rec ? attr(rec.name) : ''}" class="${(id && !rec) || wrong ? 'unknown' : ''}">
    <span class="bslot-err">${wrong ? `${attr(rec.name)} ${attr(SLOT_REFUSAL[SLOT_KEYS[s]])}` : ''}</span>
  </label>`;
}

function renderBuild() {
  const el = $('#build');
  // Editing a slot re-renders the whole sheet, so the same rule as the search
  // side applies: put focus back on the control that was just used.
  const focused = captureFocus();
  const warnings = buildWarnings(build, byId);
  const summary = buildSummary(build, byId);
  const flagged = new Set(warnings.flatMap(w => w.places.map(p => `${p.creature}:${p.slot}`)));
  const empty = buildIsEmpty(build) ? 'disabled' : '';

  const creatures = build.slots.map((row, c) => {
    const shown = row.slice(0, build.nether ? TRAITS_PER_CREATURE : 3);
    const cards = shown.map((id, s) => {
      const rec = byId.get(id);
      if (!rec) return '';
      const warn = flagged.has(`${c}:${s}`) ? ' bwarn' : '';
      return `<div class="bcard${warn}">${cardHtml(rec, query)}</div>`;
    }).join('');
    return `<section class="bcreature">
      <header class="bcreature-head">
        <h3>Creature ${c + 1}</h3><span class="dim">${attr(creatureLabel(row))}</span>
      </header>
      <div class="bslots">${shown.map((id, s) => slotInputHtml(c, s, id)).join('')}</div>
      ${cards}
    </section>`;
  }).join('');

  el.innerHTML = `
    <div class="bbar">
      <label class="bnether"><input type="checkbox" id="netherbox" data-fk="bnether" ${build.nether ? 'checked' : ''}>
        <span>Nether stone 4th trait</span></label>
      <span class="dim">${summary.count} trait${summary.count === 1 ? '' : 's'} chosen${
        summary.noStack ? ` · ${summary.noStack} do not stack` : ''}</span>
      <div class="bexport">
        <button class="bx" data-x="md" data-fk="bx:md" ${empty}>Copy Markdown</button>
        <button class="bx" data-x="link" data-fk="bx:link" ${empty}>Copy link</button>
        <button class="bx" data-x="file" data-fk="bx:file" ${empty}>Download .md</button>
      </div>
      <button class="bclear" data-fk="bclear">Clear build</button>
    </div>
    ${warnings.length ? `<div class="bwarnings">${warnings.map(w =>
      `<div class="bwarning ${w.severity}"><strong>${attr(w.name)}</strong> ${attr(w.note)}
        <span class="dim">${attr(w.places.map(placeLabel).join(', '))}</span></div>`).join('')}</div>` : ''}
    ${summary.count ? `<div class="bsummary">
      ${summary.statuses.length ? `<div><span class="dim">applies</span> ${summary.statuses.slice(0, 12)
        .map(([n, c2]) => `<span class="bpill">${attr(n)}${c2 > 1 ? ` ×${c2}` : ''}</span>`).join('')}</div>` : ''}
      ${summary.triggers.length ? `<div><span class="dim">fires on</span> ${summary.triggers.slice(0, 10)
        .map(([n, c2]) => `<span class="bpill">${attr(n.replace(/_/g, ' '))}${c2 > 1 ? ` ×${c2}` : ''}</span>`).join('')}</div>` : ''}
    </div>` : ''}
    <div class="bteam">${creatures}</div>`;

  el.querySelectorAll('.bslots input').forEach(input => {
    input.onchange = () => {
      const s = +input.dataset.s;
      const typed = input.value.trim();
      const rec = traitByName.get(typed.toLowerCase());
      // A name the slot cannot take is a different mistake from a typo, and the
      // suggestion list will not have offered it — so say which rule refused
      // it. Both cases clear the slot and leave the text on screen to fix.
      const refused = rec && !slotAccepts(rec, s);
      build.slots[+input.dataset.c][s] = rec && !refused ? rec.id : '';
      saveBuild(build);
      const err = input.parentElement.querySelector('.bslot-err');
      if (typed && !rec) {
        input.classList.add('unknown');
        err.textContent = 'no trait by that name';
        return;
      }
      if (refused) {
        input.classList.add('unknown');
        err.textContent = `${rec.name} ${SLOT_REFUSAL[SLOT_KEYS[s]]}`;
        say(`${rec.name} ${SLOT_REFUSAL[SLOT_KEYS[s]]}`);
        return;
      }
      renderMode({ push: true });
    };
  });
  $('#netherbox').onchange = e => { build.nether = e.target.checked; saveBuild(build); renderMode({ push: true }); };
  el.querySelector('.bclear').onclick = () => {
    const nether = build.nether;
    build = emptyBuild();
    build.nether = nether;
    saveBuild(build);
    renderMode({ push: true });
  };
  el.querySelectorAll('.bx').forEach(b => {
    b.onclick = () => {
      const url = permaUrl();
      if (b.dataset.x === 'link') { flash(b, copyText(url), 'Link copied'); return; }
      const md = buildToMarkdown(build, byId, {
        url,
        slotLabels: SLOT_LABELS,
        netherSlots: TRAITS_PER_CREATURE,
        summary,
        warnings,
        placeLabel,
      });
      if (b.dataset.x === 'md') flash(b, copyText(md), 'Markdown copied');
      else { downloadFile('su-team.md', md, 'text/markdown'); say('Downloaded su-team.md'); }
    };
  });
  initRoving(el); // the sheet renders real cards, chips and all
  restoreFocus(focused);
}

// The address bar already holds it, but only after syncUrl has run — build it
// from the same source the URL comes from so a copy is never a render behind.
const permaUrl = () => `${location.origin}${location.pathname}${location.search}#${modeHash()}`;

// Confirm in the button itself, and to a screen reader. Restoring the label
// from a timer rather than a re-render keeps it independent of what else
// happens to the panel in the meantime.
function say(msg) { $('#say').textContent = msg; }

// `label` is the element whose text is swapped, which is not always the button
// itself — a menu item carries a description underneath that should stay put.
async function flash(btn, promise, msg, label = btn) {
  const ok = await promise;
  const original = label.dataset.label ?? label.textContent;
  label.dataset.label = original;
  label.textContent = ok ? 'Copied ✓' : 'Copy failed';
  btn.classList.toggle('failed', !ok);
  say(ok ? msg : 'Copy failed — your browser blocked clipboard access');
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    label.textContent = label.dataset.label ?? original;
    btn.classList.remove('failed');
  }, 1600);
}

// Build mode owns the URL while active — writing the search query alongside it
// would let one clobber the other on the next render.
function modeHash() {
  if (!buildMode) return queryToHash(query);
  const p = buildToParam(build);
  return `build=${p}${build.nether ? '&nether=1' : ''}`;
}

function renderMode({ push = false } = {}) {
  if (!buildMode) { render({ push }); return; }
  syncUrl(push ? 'push' : 'replace');
  renderBuild();
}

function applyMode() {
  $('#build').hidden = !buildMode;
  for (const id of ['#resultbar', '#activefilters', '#results', '#more']) $(id).hidden = buildMode;
  document.body.classList.toggle('building', buildMode);
  $('#buildtoggle').classList.toggle('on', buildMode);
  syncBuildBadge();
  if (buildMode) renderBuild(); else paint();
}

function paint() {
  lastResults = sortResults(runQuery(index.records, query), query);
  syncNavCount();
  renderResultBar();
  renderActiveFilters();
  if (lastResults.length === 0) renderEmptyState();
  else {
    $('#results').innerHTML = lastResults.slice(0, query.shown).map(r => cardHtml(r, query)).join('');
    initRoving($('#results'));
  }
  renderMore();
  renderFacets();
}

function render({ push = false } = {}) {
  query.shown = PAGE; // a new query starts at the top
  // Typing focuses the search box, which carries no focus key — so this is a
  // no-op there and only fires for the controls that rebuild themselves.
  const focused = captureFocus();
  syncUrl(push ? 'push' : 'defer');
  paint();
  restoreFocus(focused);
}

boot();
