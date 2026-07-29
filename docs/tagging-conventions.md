# Tagging conventions (schema v12 — v2 frozen 2026-07-06; extensions 2026-07-28: v3 verbs, v4 action_state, v5 crit rename + amplifies, v6 activation/limit verbs, v7 relic scope, v8 comparison/outcome conditions, v9 battle_action + event triggers, v10 trait_modifier, v11 after_status_effect, v12 after_timeline_move)

**Watching `other`:** `npm run audit` ends with an *other-watch* section grouping
every `other` use by its params shape. A shape reaching ~8 uses is an enum
candidate — extend the enum and migrate rather than letting it accumulate
(this produced v3, v6, v8, v9, v11 and v12). The strongest signal is an
*asymmetry*: if a verb exists but the matching trigger doesn't (or vice versa),
the corpus can answer half the question. That argument carried v9
(Defend/Provoke) and v12 (timeline_move). Current watch items below quota:
counting/adjacency meta-rules ("acts as if the party has 3 more X", 9 uses —
genuinely meta, may stay), "would"-timing events (6), battle-fatigue modifiers
(4). Known false positive: verb-other `{effect}` (~37) is a generic catch-all
key over unrelated one-off meta-rules, not one family.

Re-read this before every tagging session. Post-freeze schema changes require a
migration script in scripts/migrations/ and a full re-validation.

## The one governing principle

**Searchability first.** If a player might plausibly filter by a fact, it belongs in an
enum-validated field, not in `params`. `params` is display-only nuance. When unsure,
ask: "would someone search for this?" — narrow facts count ("applies *random* debuffs",
"scales with *damage dealt*", "*steals* stats"), not just broad ones.

## Actor / subject / target — who is who

Three distinct roles; never rely on context to disambiguate them:

- `trigger.subject` = whose event fires the rule ("After **an ally** attacks…" — the
  turn-taker / event participant).
- `action.actor` = who performs the action. **There is NO default.** Omitted actor means
  *ambient — no distinct performer* ("each other creature takes damage", passive voice).
  **Set actor on ANY verb whenever the text names a performer in active voice** — "this
  creature afflicts…" → `actor: holder`, "they afflict the target" → `trigger_subject`.
  The scope `holder` means the entity the record is attached to: trait holder, relic
  bearer, the minion itself. `holder` is never the turn-taker (that's `trigger_subject`)
  and is not valid in spell rules (spells use `caster`). Verbs with an intrinsic
  performer — `attack`, `cast` — REQUIRE an explicit actor (validator-enforced).
  Receiving isn't performing: "the caster recovers Health" is a heal with target caster,
  no actor.
- `action.target` = who the action lands on. In attack-trigger rules the attacked creature
  is `target`; in activated rules the spell's chosen target is `target`.

Worked example — "After another ally attacks, this creature attacks.":
`trigger: {type: after_attack, subject: ally}` (turn-taker),
`action: {verb: attack, actor: holder, target: …}` (the trait holder follows up).
Three creatures, three structurally distinct roles.

Positional scopes: `adjacent_allies` / `adjacent_enemies` / `adjacent_any` — anchored on
the holder by default; a different anchor ("creatures adjacent to the target") goes in
params. Facet note: when an action's actor/target is `trigger_subject`, the search index
resolves it to the trigger's side ("the enemy that was healed casts…" facets as
actor: enemy) — tag the indirection honestly and let the index do the resolving.

## Decision rules (from the pilot, user-reviewed)

1. **Spells** → trigger `activated`. Conditional escalation ("or a massive amount if
   Burning") = a second `activated` rule with the `has_status` condition and
   `params: {replacesBase: true}` on the action.
2. **Branching** (per-class effects) = one rule per branch, same trigger, distinguishing
   condition each. No branch construct.
3. **"While X" / team requirements** = `passive` + condition (`team_composition` for
   "all your creatures are X").
4. **Unnamed statuses** ("a random debuff", "3 buffs") → no `statuses` array; set
   `statusKind` (buff|debuff) and `qualifiers: ["random"]` when random. Both searchable.
5. **Steals**: statuses → verb `steal_status`; stats → two `stat_change` actions
   (down on victim, up on receiver), each with `qualifiers: ["stolen"]`.
   **Conversions** ("buffs become debuffs") → `remove_status` + `apply_status`.
6. **Chance**: `rule.chance` = the searchable number. Per-rank chances record the
   max-rank value, with the per-rank rate in params and a note.
7. **Scaling** (searchable, always):
   - Real stat → `magnitude.scaleStat` + `scalePct` ("equal to 15% of Intelligence").
   - Stat-shaped specials → `scaleStat`: all | highest_stat | lowest_stat | total_stats |
     missing_health | level | rank.
   - Event quantities → `magnitude.scaleRef`: damage_dealt | damage_taken | healing_done |
     healing_received | amount_gained | status_potency | minion_count | buff_count |
     debuff_count | turns_taken | dead_creatures | spell_gems | creatures_in_party |
     infusions | other. Human-readable per-unit text goes in `magnitude.per`.
8. **Damage/healing direction** → `action.flow`: `dealt` (outgoing) | `taken` (incoming).
   "Takes 30% less damage" = damage_modifier + flow taken + direction down.
9. **Status behavior changes** ("Rebirth lasts forever", "potency +50%") → verb
   `status_modifier` with the status in `statuses` (facets as a distinct
   "modifies" interaction).
10. **"This trait/perk does not stack."** → strip from rules; `flags.stacks: false`
    (validator enforces both directions).
11. **Permanent statuses** ("Enemies always have Weak") → `apply_status` +
    `qualifiers: ["permanent"]`, trigger `passive`.
12. **Bomb detonation** → verb `detonate`, statuses ["Bomb"].
13. **"Cannot X"** (Provoke, be resurrected, dodge) → verb `prevent_action`,
    `params.action` says what.
14. **Buff/debuff definition records** (buffs.csv/debuffs.csv): `passive`/event trigger with
    condition `has_status {who, params.status: <its own name>}` describing the mechanic.
15. **Escape hatch**: genuinely unmodelable text → `flags.unmodeled: true` + `notes`.
    Never bend an enum. Watch the 3% `other` quota (`npm run audit`).
16. **Multi-sentence effects**: one rule per independent WHEN/DO fact. Meta-clauses that
    modify other mechanics ("ignores traits that…") go in `notes` if their core is
    already modeled.
17. **Critical hits** (v3, renamed v5): chance to crit → verb
    `crit_chance_modifier`; crit damage AMOUNT → `damage_modifier` +
    `params.criticalOnly` + flow dealt.
18. **Gear amplifiers** (v3): "Artifacts' X properties / Nether Stones are N% more
    powerful" → verb `equipment_modifier`, `params.equipment` ('artifact' |
    'nether_stone'), `params.property` when the text names one.
19. **Card-set meta-records** ("Doubles the potency of these effects") (v5) →
    empty `rules` + `amplifies: [sibling ids]` (validator checks the ids
    exist). The index inherits the amplified records' facets, so the
    meta-record answers the same searches its siblings do. `flags.unmodeled`
    stays reserved for genuinely unmodelable text.
20. **"While they're Provoking/Defending/dead"** (v4) → condition `action_state`,
    `params.state` ('provoking' | 'defending' | 'dead'). Being attacked with a
    failed Dodge etc. stays a trigger param, not a state.
21. **Flat chance grants** ("have a 5% chance to avoid damage") → `rule.chance`
    carries the number (rule 6), verb describes the outcome
    (`dodge_modifier` + `params.kind: 'avoid damage'`). Chance DELTAS
    ("10% lower chance to Dodge") stay `dodge_modifier` + magnitude.
22. **Defend & Provoke** (v9) → verb `battle_action`, `params.action`
    ('defend' | 'provoke' | 'defend or provoke'); add `params.mode: 'remove'`
    when an effect *clears* that state. `redirect_target` is now ONLY genuine
    targeting redirection (interception, Confused, random retargeting) — never
    the Provoke action.
23. **Effect-activation & minion events** (v9): "after X effects activate"
    (on-attack effects, Trick Slots, innate traits) → trigger
    `after_effect_activates` + `params.what`; minions arriving or departing →
    `after_minion_gained` / `after_minion_lost`. Damage-threshold events
    ("takes damage exceeding 25% of Max Health", "would take fatal damage") use
    the EXISTING `after_damaged` trigger + `damage_threshold` condition.
    Overworld spawn/encounter rates → verb `spawn_modifier`.
24. **Dynamic checks & outcome riders** (v8): property checks against another
    entity or a slot ("target's class equals the caster's", "first creature in
    the party") → condition `comparison` (params.what/of/equals). Riders on a
    prior action's result ("if this spell kills the target", "if a debuff was
    removed") → condition `outcome` (params.result). "Has all of X, Y, Z"
    composition requirements → `count_comparison`, never `other`.
25. **Trait amplifiers** (v10): "their innate traits are 50% more powerful /
    grow twice as fast / have no downside" → verb `trait_modifier` +
    `params.property`. Keep the three apart: `grant_ability` GIVES a trait,
    `activation_modifier` makes trait effects fire extra times,
    `trait_modifier` changes how the trait itself behaves.
26. **Activation counts & rule caps** (v6): "X effects activate N additional
    times / activate now" → verb `activation_modifier` (`params.what` names
    the effect family; magnitude carries the count). "Maximum N per
    battle/turn" caps → verb `limit_modifier` + `magnitude.amountFlat`.
27. **Relics** (v7): "the bearer" = `holder`. The relic is its own battle
    entity: "This relic Attacks/Casts" → actor `relic`; "After this relic
    Attacks" → trigger subject `relic`. The `relic` scope is valid only in
    relic records. "This relic or its bearer…" (either source) → subject
    holder + `params.byRelicOrBearer`. Cast spell names go in `params.spell`;
    spell-name words that collide with status names ("Stone Skin") get
    `waivedStatuses`. "This relic and its bearer deal…" → one holder-targeted
    modifier + `params.includesRelic`. Stat-gain amplifiers use the cards
    shape: `stat_change` + `params.amplifies: 'stat gains'` (NOT stat_rule).
28. **Status payloads fire** (v11): when the *status itself* does something —
    "after their Bomb detonates", "after a creature is damaged or healed by
    Burning", "after it breaks free from Snared" — use trigger
    `after_status_effect` + `params.status`. A creature merely taking damage
    stays `after_damaged` (add `params.status` when a status dealt it).
29. **Timeline movement** (v12): "after this creature is moved to the top /
    sent to the bottom / forcibly moved on the Timeline" → trigger
    `after_timeline_move` + `params.to` (top|bottom) and `params.forced`. The
    action side stays verb `timeline_move` + `params.to`.

## Semi-structured params (validated + faceted)

A few conventional `params` keys are read by facet derivation and validated against
lexicons — use exactly these names: `params.class` (∈ classes) and `params.race`
(∈ families) on conditions; `params.stat` (∈ stats) on `stat_comparison` conditions and
`after_stat_change` triggers; `params.sourceClass`/`vsClass` on damage modifiers
("less damage from Death spells" → class × vs facet).

## Every status name in the text must be accounted for

The validator rejects annotations that ignore a mentioned status. If a status is
genuinely flavor/incidental, list it in `waivedStatuses` (rare — prefer modeling).
Canonical names only ("Stone", "Feared") — the validator accepts text aliases
("Stoned", "Fear") as evidence automatically.

## Batch mechanics

Write `data/batches/<name>.json` as an array of `{id, rules, flags?, notes?}`;
`npm run absorb` stamps textHash/provenance/schemaVersion, validates all-or-nothing,
explodes to per-record files, updates the manifest, deletes the batch file.
Then `npm run validate` must stay green. Machine drafts (provenance `machine`) may be
overwritten by better hand tags via absorb; human overrides in data/overrides win over
everything and are never auto-touched.
