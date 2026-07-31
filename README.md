# Siralim Ultimate Structured Compendium

4,164 traits, spells, relics, perks, cards, minions, statuses and realm
properties. Each one parsed out of prose into a structured rule model, behind a
faceted search that runs entirely in your browser.

**[Open the compendium →](https://kleptichron.github.io/siralim-ultimate-structured-compendium/)**

## Why another compendium

Other tools search *words*. This one searches *what an effect does*.

Every effect is annotated as a list of rules. A rule is **WHEN** (a trigger) +
**IF** (conditions) + **DO** (actions), over closed enums. That turns guesswork
into filters:

- **"What triggers off Burning?"** Not what *inflicts* it, or what's *immune* to
  it. Those are three different answers. A text search gives you all three at
  once.
- **"What fires at the start of battle and applies a debuff, in the same
  rule?"** A keyword AND can only tell you both words appear somewhere. 947 of
  the 1,780 traits are multi-sentence, so that gap matters.
- **"What scales with damage dealt?"** It's a field you filter on. You don't
  have to guess the wording.
- **"Which traits can go in an artifact slot?"** Slot eligibility comes from the
  source data. The team builder refuses what the game refuses.

The query lives in the URL. Any search or six-creature build can be pasted to
someone else. Results export as Markdown, CSV or JSON.

## Running it

Node 24. No API keys, no services, no database.

```bash
npm ci
npm run build-index   # data/annotations -> web/public/index.json
npm run dev           # http://localhost:5173
```

`source/game/` is committed, so none of that needs the game installed. To pick
up a patch:

```bash
npm run extract-game -- "C:/path/to/Siralim Ultimate"
npm run import -- --dry-run   # what changed, before it rewrites anything
npm run import
```

`npm test` builds the index, validates the corpus, then runs the regression
suites. It takes about 30s. Two of the suites sweep every trigger × verb and
verb × target combination through the real filter code, in both match modes.

## The pipeline

```
<install>/localization/*.csv     the game's own string tables
  │  npm run extract-game        English gameplay strings, markup intact
  ▼                              (manual, needs the game, never runs in CI)
source/game/*.json  +  source/*.csv     effect text  +  community metadata
  │  npm run import              join by name, resolve markup, hash each text,
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
web/public/index.json            3.6 MB, 393 KB gzipped, everything the app needs
```

Three more commands. `npm run cluster` groups identical template shapes, so one
sentence can't get tagged two ways. `npm run absorb` applies a batch of
annotations all-or-nothing. `npm run audit` reports enum usage and quota alarms,
and takes `-- --ids a,b` to spot-check records.

`data/annotations/` holds no effect text. Just ids, the rule model, and a short
`textHash`. Re-importing compares those hashes. Anything whose wording moved gets
marked `stale`, so a balance patch shows up as a to-do list instead of as quietly
wrong answers.

## Data provenance

Effect text and names come from the game. Siralim Ultimate ships its own
localization tables at `<install>/localization/*.csv`, and `npm run extract-game`
reads the English column into `source/game/`. That folder is committed, so a
clean checkout builds the same site without the game installed.

Everything else comes from community compilations in `source/`: which creature,
family, class and material each trait belongs to, which specialization owns each
perk, and numbers like charge costs and relic bonuses. The game's string tables
don't carry any of that. `traits.csv` and `relics.csv` follow the column layout
of the community-maintained *Siralim Ultimate Compendium* spreadsheet, and
`perks.csv` and `specializations.csv` come from a separate compilation. Years of
player transcription went into these files, and this project is built on top of
that work. The Compendium lives at
[docs.google.com/spreadsheets/…](https://docs.google.com/spreadsheets/d/1qvWwf1fNB5jN8bJ8dFGAVzC7scgDCoBO-hglwjTT4iY/edit?usp=sharing);
corrections for it go to its maintainers, not this repo.

Patch 3.0 will expose the game's database files directly, which is where the
relational data will come from once it lands.

## Layout

| path | |
|---|---|
| `source/game/` | the game's English gameplay strings, markup intact, vendored |
| `source/` | community-compiled metadata, eleven CSVs, untouched |
| `data/normalized/` | parsed records: stable id, name, text, textHash, meta |
| `data/annotations/` | the rule model, one JSON per record |
| `data/lexicon/` | statuses, classes, families, stats, aliases for source typos |
| `data/manifest.json` | id → hash, status, provenance |
| `scripts/` | pipeline, `lib/schema.js` (enums + validator), migrations, tests |
| `web/` | the Vite app, vanilla JS, no framework |
| `docs/` | [the rule model](docs/schema.md), [tagging conventions](docs/tagging-conventions.md) |

`scripts/lib/schema.js` is the source of truth for what's searchable.
[docs/schema.md](docs/schema.md) explains the thinking behind it.

## Deploying

Pushing to `main` runs `.github/workflows/pages.yml`: `npm test`, then
`npm run build`, then a GitHub Pages deploy. The built site is static and
entirely relative-pathed. It works at a domain root, under a project-page
subpath, or straight off the filesystem.

One catch. The Pages source has to be set to **GitHub Actions** once, in
Settings → Pages. Until it is, the build passes and the deploy fails with
`HttpError: Not Found`.

## Attribution

An unofficial fan project, not affiliated with or endorsed by Thylacine Studios.
Siralim Ultimate and its effect text are their work. It's described here so the
tool can answer questions about the game. If you want the game, and you should,
it's [on Steam](https://store.steampowered.com/app/1289810/Siralim_Ultimate/).

The data under `source/` was transcribed by Siralim players, not by this project.
That work is the reason any of this is possible, and the credit belongs to them.

The code, the rule model and the annotations are MIT-licensed
([LICENSE](LICENSE)). That covers this project's own work only. It doesn't cover
the game content under `source/`, the effect text carried into
`data/normalized/`, or whatever upstream compilation those files came from.
