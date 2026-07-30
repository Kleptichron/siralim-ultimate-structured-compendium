# Siralim Ultimate Structured Compendium

Every effect in Siralim Ultimate — 5,215 traits, spells, relics, perks, cards,
blessings, artifact and spell-gem properties, minions, statuses and realm
properties — read from the game's own string tables and parsed out of prose into
a structured rule model, behind a faceted search that runs entirely in your
browser.

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

4,068 records carry an annotation at schema v13, of 5,215 in the corpus. The gap
is the backlog from switching onto the game's own strings (see
[Data provenance](#data-provenance)), and it is tracked, not estimated:

| | records | |
|---|---|---|
| current | 3,732 | annotated against the text they still have |
| `stale` | 336 | annotated, but the text changed under them — re-review queued |
| `todo` | 1,147 | mostly sources the corpus did not previously cover at all |

`npm run validate` lists both, and reports drift on a record that is *not* marked
stale as a hard error — an untracked change is a bug, a tracked one is a queue.

**A stale annotation is withheld from the index rather than shipped.** Its rules
were written against different wording and can contradict the text now displayed
— `Bonding` read "the same class" where the game says "a different class" — and a
rule that disagrees with its own record is worse than no rule, because nothing on
screen reveals it. Those records ship as searchable text with a `text changed`
badge, and keep the facets that come from their metadata rather than their rules
(family, slot eligibility), so filtering still finds them.

Health of the enums, which is the honest measure of whether the model fits the
corpus:

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

`source/game/` is committed, so none of that needs the game installed. Refreshing
it after a patch does:

```bash
npm run extract-game -- "C:/Program Files (x86)/Steam/steamapps/common/Siralim Ultimate"
npm run import -- --dry-run   # what the patch changed, before it rewrites anything
npm run import
```

`npm test` builds the index, validates the whole corpus, then runs the
regression suites (~30s — two of them sweep every trigger × verb and verb ×
target combination through the real filter code in both match modes).

## The pipeline

```
<game install>/localization/     the game's own string tables, 16 languages
  │  npm run extract-game        English gameplay strings, markup intact
  ▼                              (manual: needs the game; never runs in CI)
source/game/*.json  +  source/*.csv        text & names    +    metadata
  │  npm run import              join by name, resolve markup to display text,
  ▼                              extract refs, hash, flag real drift as stale
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

Two sources, with a deliberate split of authority between them.

**Effect text and names come from the game.** Siralim Ultimate ships its own
localization tables — `<install>/localization/*.csv`, one row per string, one
column per language. `npm run extract-game` reads the English column of the
gameplay tables and vendors the result into `source/game/`, which is committed;
nothing downstream reads the install, so a clean checkout builds the same site
without the game present. `source/game/meta.json` records the Steam build id the
data came from, so **which patch this describes is no longer unrecorded**.

Those strings carry semantic markup the display text throws away:

```
game    After this creature {ACTION_attacks}, it afflicts the target with {CONDNAME_DEBUFF_BURNED}.
shown   After this creature attacks, it afflicts the target with Burning.
```

Every status, stat, class, family and battle action is typed at the position it
occurs, and the three `CONDNAME` namespaces (`BUFF_`/`DEBUFF_`/`MINION_`) separate
things the rendered sentence spells identically. That is ground truth: each
record keeps a `refs` block derived from it, and `validate` checks annotations
against those refs instead of guessing whether a capitalised word is a status.
Switching to it retired eight of the ten entries in `status-aliases.json` —
`Frzoen`, `shelled`, `Immunity` and the rest were transcription artefacts that
cannot occur in the game's own strings.

**Relationships and metadata come from the community CSVs**, because the game's
string tables do not contain them: which creature a trait comes from, which
specialization owns a perk, a spell's charge cost, a relic's stat bonus, the level
each relic rank unlocks at. That data lives in compiled code — `data.win` has no
`CODE` chunk, so the game is YYC-compiled and its tables are native machine code,
not extractable. `source/*.csv` remains authoritative for all of it, joined to the
game rows by name. Where only one side has a row, `npm run import` says so rather
than dropping it.

One deliberate exception runs the other way: **perk text** keeps the community
transcription where one exists. The game's perk strings are templates —
`<5>% of your creatures' chance to dodge attacks` — where `<5>` is the value *per
rank* that the game multiplies at display time. A static page cannot render that,
and the transcription already spells it out ("5% … per rank. Maximum Bonus: 100%").
The game's markup still supplies the `refs`.

Switching the corpus over found real errors in the transcriptions, which is the
point of having done it: **Bonding** said "the same class" where the game says "a
different class"; **Bad Trip** named the wrong spell entirely (Cyanide Gas for
Delirium); five spell names were misspelled (`Iceicle Rain`, `Villify`); and
several effects were missing a whole sentence. 336 records changed in ways the
markup does not account for and are queued for re-review; 859 changed only in
typing or punctuation and kept their annotations.

Verify anything load-bearing in game rather than in here — this is a reading of
the game's strings, not of its code, and the numbers in an effect's text are not
always the whole rule.

## Layout

| path | |
|---|---|
| `source/game/` | the game's English gameplay strings, markup intact, vendored |
| `source/` | community-compiled metadata, eleven CSVs, untouched |
| `data/normalized/` | parsed records: id, name, text, textHash, meta, markup, refs |
| `data/annotations/` | the rule model, one JSON per record |
| `data/lexicon/` | statuses, classes, families, stats, status display names, aliases |
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

`source/game/` holds Thylacine Studios' own English effect strings, read from an
installed copy's localization tables. The metadata under `source/*.csv` was
transcribed and compiled by Siralim players, not by this project; that work is
still the reason the relational side of this is possible, and the credit for it
belongs to them. See [Data provenance](#data-provenance) for which side supplies
what.

The code, the rule model and the annotations are MIT-licensed ([LICENSE](LICENSE)).
That license covers this project's own work only. It does not extend to the game
content under `source/game/` and `source/`, to the effect text carried through
into `data/normalized/` and the built index, or to any upstream compilation those
files were derived from.
