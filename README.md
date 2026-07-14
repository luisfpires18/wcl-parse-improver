# wcl-parse-improver

Compare your Warcraft Logs Mythic+ parses against top players of your spec at
the same (or higher) keystone level, and get concrete, data-derived advice on
what they do differently.

Built for and verified against a real character (Unholy DK, zone 47 /
Midnight Season 1), but works for any character/spec/zone — everything is
parameterized.

## What it shows

- **Add any character from the UI** — type name + server + region + zone; the
  class is auto-detected from Warcraft Logs and you pick which of its specs to
  track (specs with logged runs are pre-checked). Only DPS specs can be
  analysed — the whole report is damage-based — so healer/tank specs are shown
  but disabled. Saved to `characters.json`.
- **Character tabs + spec filter** — one tab per tracked character, with a
  dropdown for its chosen specs. The spec selects the comparison cohort *and*
  filters which of your own runs count — without it, Warcraft Logs blends your
  specs together.
- **Overview** — per-dungeon best key level, time, runs, dungeon score points,
  Best % / Median % parse percentiles (matches the WCL character page exactly)
  and best DPS.
- **Gap report** per dungeon — your best run vs the top-5 same-spec runs at
  the same key level (or +1/+2):
  - deaths, idle windows (>5s with zero casts), total casts per minute,
    per-ability cast rates weighted by the cohort's damage share, buff/debuff
    uptimes, Epidemic vs Death Coil spender mix
  - ranked "biggest gaps first", each with one sentence of advice
  - group-comp buffs you never had (e.g. their Aug Evoker) are separated out,
    not counted as your mistakes
  - an honesty footer estimating how much of the DPS gap the rotational
    metrics actually explain

## Setup

1. **Node 20.6+** (uses built-in fetch, node:test and ESM; developed on 22).
2. Create a (free) Warcraft Logs API client at
   <https://www.warcraftlogs.com/api/clients/> — any name, no redirect URL,
   "Public client" unchecked. Copy the client ID and secret.
3. In the project root:

   ```
   cp .env.example .env
   # edit .env:
   #   WCL_CLIENT_ID=your-client-id
   #   WCL_CLIENT_SECRET=your-client-secret
   ```

4. Install and run:

   ```
   npm install
   npm start
   ```

   Open <http://localhost:3000>. On first run `characters.json` is seeded with
   two example characters; use **＋ Add character** to track your own, and
   **Remove** to drop the examples.

The first report for a dungeon pulls ~6 reports from the WCL API and takes up
to a minute; every response is cached on disk in `cache/` (keyed by
query+variables), so everything after that is instant and free. Delete
`cache/` to force fresh data (e.g. after new runs are logged).

## CLI scripts

```
npm run overview                 # print the per-dungeon overview table
node scripts/fetch-comparison.js <encounterID> [levelOffset] [cohortSize]
node scripts/analyze.js [fixtures/comparison-<id>-plus<n>.json]   # offline
npm test                         # unit tests against real API fixtures
```

## How accuracy is handled

- Percentiles come from `encounterRankings` per-bracket parse pools — the
  same numbers the WCL character page shows (verified digit-for-digit).
- WCL packs the keystone level into M+ numeric fields; this tool decodes
  `bestAmount = level*2e7 + DPS` and `fastestKill = ms - level*2e7`.
- Cohort comparisons use **medians across N runs**, never a single run.
- Advice is derived only from the data diff — no hardcoded "correct
  rotation" that would rot with every patch.
- JSON scalars are parsed defensively: unexpected shapes are dumped to
  `debug/` for inspection instead of crashing.

## Project layout

```
server/wcl/       auth, GraphQL client + disk cache, queries, comparison
server/parse/     defensive parsers for the JSON-scalar payloads
server/analysis/  per-run metrics, cohort comparison, advice
public/           vanilla-JS UI
scripts/          CLI entry points
fixtures/         real API payloads used by the tests
test/             node:test suites (npm test)
docs/             how it works — architecture, metrics, WCL API notes
```

## Docs

- [docs/architecture.md](docs/architecture.md) — modules, request flow, endpoints
- [docs/metrics.md](docs/metrics.md) — severity formulas, honesty model, parse tiers
- [docs/wcl-api.md](docs/wcl-api.md) — Warcraft Logs API quirks and gotchas
- [docs/caching.md](docs/caching.md) — the two-layer disk cache and refresh
- [docs/adding-a-spec.md](docs/adding-a-spec.md) — adding characters/specs, and what's still class-specific
