# Siralim Ultimate Structured Compendium

Every effect in Siralim Ultimate — 4,068 traits, spells, relics, perks, cards,
minions, statuses and realm properties — parsed out of prose into a structured
rule model, behind a faceted search that runs entirely in your browser.

**[Open the compendium →](https://kleptichron.github.io/siralim-ultimate-structured-compendium/)**

## Why another compendium

The existing tools search *words*. This one searches *what an effect does*.

Every effect text is annotated as a list of rules, each one **WHEN** (a trigger)
+ **IF** (conditions) + **DO** (actions), over closed enums. That turns questions
which are pure guesswork against a text search into ordinary filters:

- **"What triggers off Burning?"** — as opposed to what *inflicts* it, or what
  makes a creature *immune* to it. Same status, three unrelated answers; a text
  search for "Burning" returns all three mixed together and can't tell them
  apart.
- **"What fires at the start of battle *and* applies a debuff — in the same
  rule?"** Not "mentions both somewhere in four sentences", which is what a
  keyword AND gives you. 947 of the 1,780 traits are multi-sentence, so this
  distinction is the difference between an answer and a pile of false positives.
- **"What scales with damage dealt?"** Scaling sources are a searchable field,
  not a phrase to guess the wording of.
- **"Which traits can actually go in an artifact slot?"** Slot eligibility comes
  from the source data, so the team builder refuses placements the game would.

Results are shareable: the query lives in the URL, so any search or six-creature
build can be pasted to someone else. Result sets export as Markdown, CSV or JSON.

## Status

Tagging is **complete** — all 4,068 records across all eleven sources, at schema
v13. Health of the enums, which is the honest measure of whether the model fits
the corpus:

| | share of annotated records |
|---|---|
| `verb: other` | 0.9% |
| `trigger: other` | 0.3% |
| `condition: other` | **zero** |

Anything landing in `other` often enough gets promoted to a real enum value plus
a migration, rather than left as a shrug — `npm run audit` groups every `other`
use by shape and alarms past a quota. Fifteen migrations so far
(`scripts/migrations/`), most of them triggered that way.

## Running it

Node 24. No API keys, no services, no database.

```bash
npm ci
npm run build-index   # data/annotations -> web/public/index.json
npm run dev           # http://localhost:5173
```

`npm test` builds the index, validates the whole corpus, then runs the
regression suites (~30s — two of them sweep every trigger × verb and verb ×
target combination through the real filter code in both match modes).

## The pipeline

```
source/*.csv                     community-compiled effect data, unmodified
  │  npm run import              parse, assign stable ids, hash each text,
  ▼                              build lexicons, flag drift as stale
data/normalized/*.json
  │  npm run extract             deterministic machine drafts + evidence
  ▼
data/annotations/<source>/<id>.json    one file per record: the rule model
  │  npm run validate            enum conformance, status evidence both ways,
  │                              textHash freshness, cluster consistency
  ▼
  │  npm run build-index         derive flat facets from the rules
  ▼
web/public/index.json            3.9 MB, 406 KB gzipped, everything the app needs
```

Other commands: `npm run cluster` (group identical template shapes so the same
sentence can't be tagged two ways), `npm run absorb` (apply a batch of
annotations all-or-nothing), `npm run audit` (enum usage, quota alarms, review
sample; `-- --ids a,b` to spot-check specific records).

`data/annotations/` holds no effect text — only ids, the rule model, and a short
`textHash`. Re-importing compares those hashes and marks every record whose
wording moved as `stale`, so a balance patch surfaces as a list of things to
re-check instead of quietly wrong answers.

## Data provenance

The effect data in `source/` was **not** exported from the game, and it is worth
being precise about that, because a reference tool that is wrong about where its
facts came from is worse than no tool.

It is community-compiled. `traits.csv` and `relics.csv` match the column layout
of the community-maintained *Siralim Ultimate Compendium* spreadsheet, whose
published exports carry a version banner and a maintainer contact in row 1.
`perks.csv` and `specializations.csv` come from a different source again — they
are the only two files using `snake_case` headers rather than Title Case. The
transcription typos the lexicon has to alias around (`Frzoen` for Frozen,
`Beserk` for Berserk, `Poison` for Poisoned) are human ones, which is the
clearest single sign these are transcriptions rather than a machine export.

**Which game version this describes is unrecorded.** The copy here has no
version banner, so the site states only when the data was indexed, not which
patch it reflects. It is a snapshot of a spreadsheet that was itself maintained
by hand: treat it as approximately current, and verify anything load-bearing in
game rather than in here.

## Layout

| path | |
|---|---|
| `source/` | community-compiled effect data, eleven CSVs, untouched |
| `data/normalized/` | parsed records: stable id, name, text, textHash, meta |
| `data/annotations/` | the rule model, one JSON per record |
| `data/lexicon/` | statuses, classes, families, stats, and aliases for source typos |
| `data/manifest.json` | id → hash, status, provenance |
| `scripts/` | pipeline, `lib/schema.js` (enums + validator), migrations, tests |
| `web/` | the Vite app — vanilla JS, no framework |
| `docs/` | [the rule model](docs/schema.md), [tagging conventions](docs/tagging-conventions.md) |

`scripts/lib/schema.js` is the source of truth for what is searchable.
[docs/schema.md](docs/schema.md) explains the intent behind it.

## Deploying

Pushing to `main` runs `.github/workflows/pages.yml`: `npm test`, then
`npm run build`, then a GitHub Pages deploy. The built site is static and
entirely relative-pathed, so it works at a domain root, under a project-page
subpath, or straight off the filesystem.

The Pages source has to be set to **GitHub Actions** once, in
Settings → Pages — until it is, the build job passes and the deploy job fails
with `HttpError: Not Found`.

## Attribution

An unofficial fan project. Not affiliated with, endorsed by, or connected to
Thylacine Studios.

Siralim Ultimate and its effect text are Thylacine Studios' work, described here
so the tool can answer questions about the game. If you want the game — and you
should, this tool is no substitute — it's
[on Steam](https://store.steampowered.com/app/1289810/Siralim_Ultimate/).

The effect data under `source/` was transcribed and compiled by Siralim players,
not by this project. That work is the reason any of this is possible, and the
credit for it belongs to them. See [Data provenance](#data-provenance) for what
is and isn't known about which compilations these files came from.

The code, the rule model and the annotations are MIT-licensed ([LICENSE](LICENSE)).
That license covers this project's own work only. It does not extend to the game
content under `source/`, to the effect text carried through into
`data/normalized/` and the built index, or to any upstream compilation those
files were derived from.
