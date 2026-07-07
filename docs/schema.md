# Rule model (schema v1 — frozen 2026-07-06)

> Operational tagging rules live in [tagging-conventions.md](tagging-conventions.md).
> Post-freeze changes require a migration in scripts/migrations/ (see 0001 for the pattern).

Every effect text is annotated as a list of **rules**: WHEN (trigger) + IF (conditions) + DO (actions).
Searchable fields use the closed enums in [scripts/lib/schema.js](../scripts/lib/schema.js) — that file
is the source of truth; this doc explains intent and conventions.

Two strictness tiers:
- **Searchable fields** (`trigger.type`, `trigger.subject`, `condition.type`, `condition.who`,
  `action.verb`, `action.actor`, `action.target`, `action.statuses`, `action.stats`,
  `action.statusKind`, `action.qualifiers`, `action.flow`, `magnitude` incl. `scaleStat`/`scaleRef`,
  `rule.chance`, record `flags`) — enum-validated, drive the search facets.
- **`params`** objects anywhere — freeform nuance for display ("whichever the target lacks",
  selector details). Never validated beyond being an object, never faceted.

## Annotation shape

```jsonc
{
  "id": "trait:flesh-rot",
  "textHash": "…",           // stamped by absorb/extract; import flags drift as stale
  "schemaVersion": 0,
  "provenance": "claude",     // machine | template | claude | human
  "machineTemplate": "…",     // only on machine drafts
  "rules": [
    {
      "trigger": { "type": "after_afflicted", "subject": "enemy", "params": {} },
      "conditions": [ { "type": "has_status", "who": "enemy", "params": { "status": "Burning" } } ],
      "actions": [
        { "verb": "apply_status", "target": "trigger_subject",
          "statuses": ["Weak"], "stats": [],
          "magnitude": { "amountPct": 30, "direction": "up" }, "params": {} }
      ],
      "chance": 50,            // only when text says "X% chance"
      "modifiesDefault": true  // only for "instead/would" replacement effects
    }
  ],
  "flags": { "stacks": false },   // only when text has "does not stack"
  "waivedStatuses": [],           // statuses mentioned in text but deliberately not modeled
  "notes": null
}
```

## Conventions

- **Spells** (and other on-use effects): the payload rule uses trigger `activated`.
  Conditional riders ("or a massive amount if afflicted with Burning") are conditions
  on the same rule or a second `activated` rule.
- **"While X..." / "If all the creatures..."** auras: trigger `passive` + a condition
  (`team_composition` covers all "Master of X" traits).
- **Branching** ("The Nether" acts per class): one rule per branch, sharing the trigger,
  each with the distinguishing condition. No special branch construct.
- **"This trait does not stack."**: strip from rules, set `flags.stacks: false`.
- **Damage tier words** (spells): `magnitude.tier` ∈ small/moderate/large/massive/devastating.
- **Status buff/debuff split** is derived from the status lexicon — one verb `apply_status`.
- **Status aliases**: text sometimes uses variants ("Stoned" for Stone, "Fear" for Feared) —
  [data/lexicon/status-aliases.json](../data/lexicon/status-aliases.json). Annotations always
  use canonical names; the validator accepts alias matches as text evidence.
- **Extra statuses**: unique statuses absent from buffs/debuffs.csv (e.g. Mania) live in
  [data/lexicon/extra-statuses.json](../data/lexicon/extra-statuses.json).
- **noText realm properties** (39 rows, self-descriptive names): taggable from the name;
  validator uses the name as evidence haystack.
- **Escape hatch**: anything unmodelable gets `flags.unmodeled: true` + `notes` — never bend
  an enum to fit. The audit alarm fires if any `other` exceeds 3% usage.

## Enums (v1)

See scripts/lib/schema.js for the authoritative lists: `TRIGGER_TYPES` (29), `SCOPES` (16),
`CONDITION_TYPES` (14), `ACTION_VERBS` (31), `TIERS` (5), `SCALE_SPECIALS`, `SCALE_REFS` (15),
`QUALIFIERS` (random/stolen/permanent), `STATUS_KINDS`, `FLOWS` (dealt/taken), magnitude keys.

## Pipeline

```
npm run import     # CSV -> data/normalized + lexicons + manifest drift detection
npm run extract    # -> data/evidence + machine-draft annotations (155 and growing)
npm run cluster    # -> data/evidence/clusters.json (consistency groups)
npm run absorb     # data/batches/*.json -> per-record annotations (all-or-nothing)
npm run validate   # full invariant suite; exit 1 on violation
npm run audit      # enum usage + quota alarm + random review sample
npm run pipeline   # import + extract + validate
```

Invariants validate enforces: enum conformance; both-ways status evidence; textHash freshness;
"does not stack" ⇔ `flags.stacks`; cluster consistency (same template shape ⇒ same rule skeleton);
manifest/annotation agreement; orphan detection; lexicon-closure probes (warnings).
