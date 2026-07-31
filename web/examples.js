// The example searches on the start view. Each hash is a real URL fragment —
// clicking one navigates, and the hashchange listener does the rest.
//
// A module rather than markup in main.js so the test suite can run every hash
// against the built index: an enum rename or a re-tag that empties one of
// these would otherwise ship a start page whose first click returns nothing.
//
// The middle two are a deliberate pair. Same status, different interaction,
// different lists — that contrast is the whole pitch, so they sit adjacent.
export const EXAMPLES = [
  {
    hash: 'when=start_of_battle&status=:inflicts',
    label: 'Inflicts a debuff at the start of battle',
    note: 'trigger and action in the same rule',
  },
  {
    hash: 'status=Burning:inflicts',
    label: 'Inflicts Burning',
    note: '',
  },
  {
    hash: 'status=Burning:triggers_off',
    label: 'Triggers off Burning',
    note: 'reacts to it rather than causing it — compare the list above',
  },
  {
    hash: 'stat=Speed:scales_with',
    label: 'Scales with Speed',
    note: 'wherever a magnitude scales with it',
  },
];
