# Tagging conventions (schema v1 — FROZEN 2026-07-06)

Re-read this before every tagging session. Post-freeze schema changes require a
migration script in scripts/migrations/ and a full re-validation.

## The one governing principle

**Searchability first.** If a player might plausibly filter by a fact, it belongs in an
enum-validated field, not in `params`. `params` is display-only nuance. When unsure,
ask: "would someone search for this?" — narrow facts count ("applies *random* debuffs",
"scales with *damage dealt*", "*steals* stats"), not just broad ones.

## Actor / subject / target — who is who

- `trigger.subject` = whose event fires the rule ("After **an ally** attacks…").
- `action.actor` = who performs the action. **Default when omitted: the record's owner** —
  the trait holder, the relic bearer('s relic), the perk's affected creatures, the minion
  itself; for `activated` (spell) rules, the caster. **Set `actor` explicitly whenever the
  performer differs from that default** (e.g. adoration: the *enemy* casts → `trigger_subject`),
  and feel free to set `actor: "self"` for clarity in branchy rules (The Nether).
- `action.target` = who the action lands on. In attack-trigger rules the attacked creature
  is `target`; in activated rules the spell's chosen target is `target`.

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
