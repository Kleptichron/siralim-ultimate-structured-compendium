# Tests

```bash
npm test
```

Rebuilds the index, runs `validate`, then the suites. About 35 seconds.

The index is rebuilt first on purpose: these suites check the **derived**
artefact the app actually loads, so a green run against a stale `index.json.gz`
would be reporting on code that no longer exists. To run the suites alone
against the current index:

```bash
node --test "scripts/tests/*.test.js"
```

The suites import `web/*.js` directly — the same files the browser loads, which
is why those modules use relative specifiers. Nothing is copied or rewritten;
a test that passes against a transformed copy proves less than it appears to.

## What each suite guards

| Suite | Guards | The bug it exists for |
| --- | --- | --- |
| `chips` | Every clickable chip on a card finds that card | Chip labels come from `render.js`, the filters they carry must agree with the facets `build-index.js` emitted. When those drift the chip still looks right and silently searches for something else — 116 unnamed-status chips once took their interaction from the status kind instead of the verb. |
| `sweeps` | Every (trigger, action) and (action, target) pair, both match modes, against truth computed off the match bags | Rule and action scoping. Before per-action bags, `deal_damage → caster` returned 21 records of which 18 were wrong: the verb came from one action and the target from another in the same record. |
| `slots` | Which build slots a trait may occupy, and the warnings for a bad one | The rule is derived from two sentinels in the source data. A corpus change that alters either would otherwise quietly shrink what the builder offers, and nothing would say so. |
| `export` | CSV / Markdown / JSON serializers over the whole corpus | An export is the one output nobody proofreads. The CSV is parsed back with an independent RFC 4180 reader rather than the writer's own rules — a test that agrees with the code it tests would pass on a file no spreadsheet could open. |

## Writing more

`harness.js` has `loadIndex()`, `traitsOf`, `byId` and `everyRecord`. Prefer
`everyRecord` over a bare loop: it reports *"3 of 4,068 records failed"* with
the first few ids, rather than `false !== true`. A whole-corpus assertion is
only useful if the failure tells you which record to go and look at.

Two things worth keeping up:

- **Sweep the corpus, don't sample it.** Every bug in the table above was found
  by an exhaustive pass and would have survived a handful of examples.
- **Check the test can fail.** Each of these was confirmed by breaking the code
  it covers and watching the right assertion catch it. An assertion that cannot
  fail is worse than none, because it reads as coverage.
