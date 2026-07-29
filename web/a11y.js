// Keyboard support for the click-only controls.
//
// Making all 1,260 of them tab stops would trade one problem for another: with
// 250 result cards you would tab past ~1,300 chips before reaching anything
// else. So each group of related controls is ONE tab stop, and arrow keys move
// within it — the roving-tabindex pattern. Tab still gets you around the page;
// arrows get you around a group.
//
// Activation goes through el.click(), so the existing click handlers stay the
// single definition of what a control does.

const ITEM = '[data-rove]';

function focusItem(items, next) {
  const i = Math.max(0, Math.min(items.length - 1, next));
  for (const el of items) el.tabIndex = -1;
  items[i].tabIndex = 0;
  items[i].focus();
}

// Groups are re-created on every render, so this is called after each one.
// `reveal` appends cards without rebuilding the ones already on screen, so the
// flag keeps those from collecting a second keydown listener each time.
export function initRoving(root) {
  // The root itself can be the group — querySelectorAll only sees descendants,
  // so a container that IS [data-roving] would silently never get wired.
  const SEL = '[data-roving]:not([data-roved])';
  const groups = [...root.querySelectorAll(SEL)];
  if (root.matches?.(SEL)) groups.unshift(root);
  for (const group of groups) {
    const items = [...group.querySelectorAll(ITEM)];
    if (!items.length) continue;
    group.dataset.roved = '1';
    // Entering the group lands on whatever is selected, if anything — otherwise
    // the first item. Tabbing into a long list at a checked value is friendlier
    // than always starting at the top.
    const start = Math.max(0, items.findIndex(el => el.getAttribute('aria-pressed') === 'true'));
    items.forEach((el, i) => { el.tabIndex = i === start ? 0 : -1; });

    group.addEventListener('keydown', e => {
      const el = e.target.closest(ITEM);
      if (!el) return;
      const at = items.indexOf(el);
      if (at < 0) return;
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': e.preventDefault(); focusItem(items, at + 1); break;
        case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); focusItem(items, at - 1); break;
        case 'Home': e.preventDefault(); focusItem(items, 0); break;
        case 'End': e.preventDefault(); focusItem(items, items.length - 1); break;
        case 'Enter': case ' ': case 'Spacebar':
          e.preventDefault();
          el.click(); // one definition of what activation means
          break;
        default: break;
      }
    });
  }
}

// --- surviving a re-render -------------------------------------------------
// Activating a control rebuilds the panel or the result list that contains it,
// which drops focus to the top of the document — so every keyboard interaction
// would cost a scroll back to where you were. Capture what was focused, then
// put focus on the control that replaced it.
//
// The key is whatever identifies the control across renders: an explicit
// data-fk, or for result chips the filters they stand for (so applying a
// "passive" chip lands you on a "passive" chip in the new results). If it is
// gone entirely, fall back to the region — never to the top of the page.
const REGIONS = ['#facetsinner', '#activefilters', '#results', '#more', '#build'];

export function captureFocus() {
  const el = document.activeElement?.closest?.('[data-fk],[data-f]');
  if (!el) return null;
  return {
    key: el.dataset.fk ?? el.dataset.f,
    region: REGIONS.find(r => el.closest(r)) ?? null,
  };
}

export function restoreFocus(saved) {
  if (!saved) return;
  const k = CSS.escape(saved.key);
  const el = document.querySelector(`[data-fk="${k}"],[data-f="${k}"]`);
  if (el) focusRoved(el);
  else document.querySelector(saved.region ?? '')?.focus();
}

// Focus an item and make it the one tab stop for its group, so returning by Tab
// comes back here rather than to wherever the group started.
function focusRoved(el) {
  const group = el.closest('[data-roving]');
  if (group) for (const it of group.querySelectorAll(ITEM)) it.tabIndex = -1;
  el.tabIndex = 0;
  el.focus();
}

// aria-pressed alone cannot express three states — excluded and unselected both
// read as "not pressed" — so the state is also spelled out in the label.
export function stateAttrs(label, state) {
  const spoken = state === 'on' ? 'included' : state === 'off' ? 'excluded' : 'not selected';
  return `role="button" data-rove aria-pressed="${state === 'on'}" `
    + `aria-label="${label}, ${spoken}"`;
}
