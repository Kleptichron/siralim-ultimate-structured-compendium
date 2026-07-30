# Rule model (schema v13)

> v2 was frozen 2026-07-06; every change since is a numbered version with a
> migration in [scripts/migrations/](../scripts/migrations/). Operational tagging
> rules live in [tagging-conventions.md](tagging-conventions.md).

Every effect text is annotated as a list of **rules**: WHEN (trigger) + IF
(conditions) + DO (actions). [scripts/lib/schema.js](../scripts/lib/schema.js) is
the source of truth for the enums and the validator; this doc explains intent.

## Three strictness tiers

1. **Searchable fields** — enum-validated, and what the facets are derived from:
   `trigger.type`, `trigger.subject`, `condition.type`, `condition.who`,
   `action.verb`, `action.actor`, `action.target`, `action.statuses`,
   `action.stats`, `action.statusKind`, `action.qualifiers`, `action.flow`,
   `magnitude` (incl. `scaleStat`/`scaleRef`), `rule.chance`, record `flags`.
2. **Conventional `params` keys** — freeform in shape, but validated against the
   lexicons because `build-index` reads them into facets: `params.class`,
   `params.classes`, `params.race`, `params.races`, `params.spellClass`,
   `params.sourceClass`, `params.vsClass`, `params.sourceRace`, `params.stat`,
   `params.stats`. Adding these checks immediately caught two dynamic phrases
   sitting in faceted keys, which is why the tier exists at all.
3. **Everything else in `params`** — display-only nuance ("whichever the target
   lacks", selector details). Never validated beyond being an object, never
   faceted.

The rule that keeps the tiers honest: **an entity distinction belongs in a scope,
never in a display-only param.** If a query should be able to find it, it is tier
1 or tier 2. Both `holder` (v2) and `relic` (v7) exist because the alternative
was a `params` value nobody could search.

Two shapes the validator rejects outright, both learned the hard way:

- **A compound string in a faceted key** — `params.status: "Bleeding or Poisoned"`
  or `params.stats: "Attack, Defense or Speed"`. It passes a text-evidence check
  by literal match and then produces *no facets at all*. Use the plural array
  form (`statuses: [...]`, `stats: [...]`).
- **A second trigger hidden in params** — `trigger.params.alsoAfter`. "Defends or
  provokes" is two trigger types, so it is two rules.

## Record shape

Records are built by `npm run import` and are what annotations attach to.

```jsonc
{
  "id": "trait:flesh-rot",
  "name": "Flesh Rot",
  "text": "After an enemy is afflicted with either Weak or Vulnerable, …",
  "textHash": "…",
  "meta": { "class": "Death", "family": "Abomination", … },  // from source/*.csv
  "markup": "After an enemy is afflicted with either {CONDNAME_DEBUFF_WEAK} …",
  "refs": {                   // what the game's markup asserts about this string
    "statuses": ["Vulnerable", "Weak"],
    "debuffs":  ["Vulnerable", "Weak"],   // buffs/debuffs/minions kept apart
    "families": [], "classes": [], "stats": [], "actions": ["afflicted"],
    "markup": []              // semantic bracket tags: slot_spell, temporary, …
  }
}
```

`refs` is the game's own typing of the sentence, not a re-parse of it, so it is
the evidence `validate` prefers: `crossCheckRefs` requires every status an
annotation claims to be one the game types here, and every buff or debuff the game
types to be claimed or explicitly waived. Records with no `refs` (the
community-only sources — realm properties, nemesis modifiers) fall back to the
older prose check.

## Annotation shape

```jsonc
{
  "id": "trait:flesh-rot",
  "textHash": "…",            // stamped on write; import flags text drift as stale
  "schemaVersion": 13,
  "provenance": "claude",     // machine | template | claude | human
  "machineTemplate": "…",     // only on machine drafts
  "rules": [
    {
      "trigger": { "type": "after_afflicted", "subject": "enemy", "params": {} },
      "conditions": [ { "type": "has_status", "who": "enemy", "params": { "status": "Burning" } } ],
      "actions": [
        { "verb": "apply_status", "actor": "holder", "target": "trigger_subject",
          "statuses": ["Weak"], "stats": [],
          "magnitude": { "amountPct": 30, "direction": "up" }, "params": {} }
      ],
      "chance": 50,             // only when the text says "X% chance"
      "modifiesDefault": true   // only for "instead/would" replacement effects
    }
  ],
  "flags": { "stacks": false },  // stacks | manualCastOnly | unmodeled
  "amplifies": ["card:x:1"],     // meta-records: the siblings whose potency this doubles
  "waivedStatuses": [],          // mentioned in text, deliberately not modeled
  "notes": null
}
```

`magnitude` keys: `amountPct`, `amountFlat`, `tier`, `scaleStat`, `scaleRef`,
`scalePct`, `per`, `perRank`, `direction`, `cap`.

## Who does what

One `SCOPES` enum serves `trigger.subject`, `condition.who`, `action.actor` and
`action.target`. The distinctions that carry the most weight:

- **`holder`** — the entity the record's effect is attached to: the trait's
  creature, the relic's bearer, the minion itself. **Never the turn-taker.**
  Invalid in spell rules, which use `caster`.
- **`trigger_subject`** — whoever the trigger was about. In "After another ally
  attacks, this creature attacks", the ally is `trigger_subject` and the creature
  is `holder`. Collapsing these two was the mistake v2 fixed.
- **`relic`** — the relic itself, a battle entity distinct from whoever carries
  it ("this relic Attacks"). Validator-enforced to relic records only.
- **Omitted `actor`** — ambient, no performer. There is deliberately **no
  default**; an absent actor is a claim, not an oversight. Verbs with an
  intrinsic performer (`attack`, `cast`) must name one, and the validator says so.

## Enums (v13)

Authoritative lists in [scripts/lib/schema.js](../scripts/lib/schema.js):
`TRIGGER_TYPES` (34), `SCOPES` (20), `CONDITION_TYPES` (17), `ACTION_VERBS` (39),
`TIERS` (5), `SCALE_SPECIALS` (8), `SCALE_REFS` (15), `QUALIFIERS`
(random/stolen/permanent), `STATUS_KINDS` (buff/debuff), `FLOWS` (dealt/taken),
`DIRECTIONS` (up/down), `PROVENANCE` (4).

### Distinctions worth keeping straight

| these look alike | but |
|---|---|
| `after_status_effect` vs `after_damaged` | a status's own payload resolving (Bomb detonates, Burning ticks) vs the victim taking damage |
| `timeline_move` vs `after_timeline_move` | what moves the Timeline vs what fires off being moved |
| `provoke` vs `redirect_target` | the Provoke battle action vs genuine targeting redirection (interception, Confused, random targeting) |
| `grant_ability` vs `trait_modifier` vs `activation_modifier` | gives a trait vs changes how traits behave (potency, growth, downsides) vs makes an effect fire extra times |
| `crit_chance_modifier` vs `damage_modifier` | crit *chance* vs crit *damage* (the latter is `damage_modifier` + `params.criticalOnly`) |
| `status_modifier` vs `apply_status` | changes a status's potency/duration/behavior vs inflicting it |

## Conventions

- **Spells** and other on-use effects: the payload rule uses trigger `activated`.
  Conditional riders ("or a massive amount if afflicted with Burning") become
  conditions on the same rule, or a second `activated` rule.
- **"While X…" / "If all your creatures…"** auras: trigger `passive` + a
  condition. `team_composition` covers the "Master of X" family (~117 records).
- **Branching** ("The Nether" acts per class): one rule per branch, sharing the
  trigger, each with its distinguishing condition. No special branch construct.
- **"This trait does not stack."** — strip from rules, set `flags.stacks: false`.
  Enforced both ways: the phrase requires the flag, the flag requires the phrase.
- **Damage tier words** (spells use these, not numbers):
  `magnitude.tier` ∈ small / moderate / large / massive / devastating.
- **Buff vs debuff** is derived from the status lexicon — one verb, `apply_status`.
- **Status aliases** — a leftover from when effect text was hand-transcribed and
  spelled a status several ways. Now that the text comes from the game, only
  `Poison`→`Poisoned` and `Scorn`→`Scorned` still occur;
  [status-aliases.json](../data/lexicon/status-aliases.json) maps those, and
  `validate` warns about any entry that has stopped matching anything.
  Annotations always use canonical names.
- **Status display names** — the game's internal key is not the shown name
  (`DEBUFF_BURNED` → "Burning", `BUFF_WARD` → "Warded"), and only compiled code
  holds the mapping, so it is curated in
  [status-names.json](../data/lexicon/status-names.json). Every value is checked
  against the strings the game ships; an unlisted token fails the extract.
- **Extra statuses** the game's status table does not carry (Secret Stuff, a
  Witch Doctor perk buff) live in
  [extra-statuses.json](../data/lexicon/extra-statuses.json).
- **noText realm properties** (39 self-descriptive names) are tagged from the
  name; the validator uses the name as the evidence haystack.
- **Chance shape**: a flat chance to do something → `rule.chance`. A chance that
  the effect *changes* → `magnitude`.
- **Meta-records** ("Doubles the potency of these effects") use `amplifies` with
  the sibling ids. `build-index` inherits those siblings' facets, so the record
  answers the queries its siblings answer.
- **Escape hatch**: `flags.unmodeled: true` + `notes`. Never bend an enum to fit.

## Version history

Each row is a schema bump with its migration. `0013` and `0015` are corpus fixes
that split disjunctions rather than version bumps.

| v | change | migration |
|---|---|---|
| 1 | searchable qualifiers, `statusKind`, `flow`, `magnitude.scaleRef` | `0001` |
| 2 | actor semantics: `self` → `holder`, omitted actor = ambient, explicit actor required for attack/cast | `0002` |
| 3 | crit-chance and `equipment_modifier` verbs | `0003` |
| 4 | condition `action_state` (provoking / defending / dead / off-turn) | `0004` |
| 5 | `crit_modifier` → `crit_chance_modifier`; `amplifies` replaces `flags.unmodeled` for meta-records | `0005` |
| 6 | `activation_modifier`, `limit_modifier` | `0006` |
| 7 | scope `relic` | `0007` |
| 8 | conditions `comparison` and `outcome` | `0008` |
| 9 | `battle_action` verb, `spawn_modifier`, `after_effect_activates`, `after_minion_gained`, `after_minion_lost` | `0009` |
| 10 | `trait_modifier` | `0010` |
| 11 | `after_status_effect` | `0011` |
| 12 | `after_timeline_move` | `0012` |
| 13 | `battle_action` split into first-class `defend` and `provoke` verbs | `0014` |

### How enum additions get decided

Two signals, both of which have earned their keep:

- **Quota.** `npm run audit` groups every `other` use by params shape and alarms
  at 8+. Anything reaching quota gets a proposed enum extension plus a migration,
  not a shrug. This produced v8.
- **Asymmetry** — the stronger of the two. A verb that exists without its
  matching trigger, or vice versa, means the corpus can only answer half the
  question. "What moves the Timeline?" was answerable while "what fires when a
  creature is moved?" was not. That argument carried v9 and v12.

Not every `other` is a family. `verb: other` with a generic `{effect}` param
(~37 records) is a catch-all over unrelated one-off meta-rules — it looks like
the biggest cluster in the audit and should **not** be extracted.

## Pipeline

```
npm run extract-game # game localization -> source/game/*.json (manual; needs the game)
npm run import       # game + CSV -> data/normalized + lexicons + manifest drift
                     #   --dry-run  report the drift without writing anything
                     #   --verbose  print before/after for each changed text
npm run extract      # -> data/evidence + machine-draft annotations
npm run cluster      # -> data/evidence/clusters.json (consistency groups)
npm run absorb       # data/batches/*.json -> per-record annotations (all-or-nothing)
npm run validate     # full invariant suite; exit 1 on violation
npm run audit        # enum usage + quota alarm + other-watch + review sample
npm run build-index  # -> web/public/index.json (facet derivation)
npm run pipeline     # import + extract + validate
npm test             # build-index + validate + regression suites
```

`npm run audit -- --ids card:angel:1,trait:flesh-rot` spot-checks specific
records, rendering every searchable field.

**Never pipe `npm run validate` through `grep`** — it masks the exit code, and a
bad batch got committed that way once. Redirect and tail instead.

## Invariants the validator enforces

- Enum conformance across all searchable fields, plus lexicon conformance for the
  conventional `params` keys.
- **Status evidence, both ways**: every status an annotation claims must be one the
  game's markup types in that record, and every buff or debuff the markup types
  must be either referenced or explicitly in `waivedStatuses`. Records with no
  markup (the community-only sources) use the older prose match, which accepts a
  canonical name or an alias. Families are checked the same way.
- Unresolved markup — a token the extractor could not map would silently become a
  missing ref, so it is an error.
- `textHash` freshness — annotations written against text that has since changed
  are stale, not silently wrong. A record the manifest already marks `stale` reports
  its findings as such; drift on a record that is *not* marked stale is a hard
  error, because that is the case that means something is actually wrong.
- "does not stack" ⇔ `flags.stacks: false`.
- Cluster consistency: identical template shapes must get identical rule
  skeletons.
- `amplifies` targets exist, are not self-referential, and are non-empty.
- Non-empty `rules`, unless the record is `flags.unmodeled`, has `amplifies`, or
  is a `loreOnly` record.
- Scope `relic` only in relic records.
- Manifest/annotation agreement, orphan detection, lexicon-closure probes.
