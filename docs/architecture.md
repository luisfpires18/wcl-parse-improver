# Architecture

A single Express process serves a static vanilla-JS frontend and three JSON
endpoints. All state lives on disk in `cache/`. There is no database, no build
step, and no client framework.

```
public/             browser: one HTML page, one JS file, one stylesheet
server/index.js     Express app — routes only, no logic
server/characters.js the tracked-character store (characters.json)
server/wcl/         talking to Warcraft Logs (auth, GraphQL client, cache, queries, spec roles)
server/parse/       defensive parsers turning WCL's loose JSON scalars into shapes
server/analysis/    everything that produces a number or a sentence
scripts/            CLI entry points (same code paths, no browser)
fixtures/           real captured API payloads — the tests run against these
test/               node:test suites
characters.json     which characters/specs to track (created on first run)
```

## Request flow

The expensive work is `buildComparison`, which assembles "my run + a cohort of
comparable runs" and is shared by both data endpoints.

```
GET /api/report?...
  └─ buildComparison()                     server/wcl/comparison.js
       ├─ fetchMyEncounterRuns()           my logged runs on this dungeon (spec-filtered)
       │    └─ summarizeAtLevel()          pick my run at (or nearest) the requested key level
       ├─ fetchRunDetail(mine)             fight timing, casts, buffs, damage, deaths, cast events
       ├─ fetchTopRuns()                   live top-N same-spec ranking at that key level
       └─ fetchRunDetail(each cohort run)
  └─ buildReport(bundle)                   server/analysis/compare.js
       ├─ computeRunMetrics() per run      server/analysis/metrics.js
       ├─ gaps[] + adviceFor(gap)          server/analysis/advice.js
       ├─ buildTimeline()                  server/analysis/timeline.js
       ├─ buildParsePlan()                 server/analysis/parseTiers.js
       ├─ buildConsumables()               flask/food diff
       └─ buildSummary()                   server/analysis/summary.js
```

`buildComparison` is called by both `/api/report` and `/api/dps-series`. The
second call is a cache hit, so the heavy fetch happens once.

## Endpoints

All three take the character selector: `name`, `server` (slug), `region`,
`zone`, `className`, `specName`. Class and spec are **not** cosmetic — they
select the comparison cohort *and* filter which of your own runs count (see
[wcl-api.md](wcl-api.md#spec-filtering)).

| Endpoint | Extra params | Returns |
| --- | --- | --- |
| `GET /api/overview` | `refresh` | Per-dungeon table: key level, time, runs, score points, Best %, Median %, best DPS |
| `GET /api/report` | `encounter` (required), `level`, `compareTo`, `refresh` | The full gap report |
| `GET /api/dps-series` | `encounter`, `level`, `compareTo` | Binned DPS-over-time for both runs + spike analysis + full cast order |

`level` is clamped to 2–30 and defaults to `DEFAULT_LEVEL` (20); the frontend
overrides it with the highest key level you've actually logged for that
dungeon. `compareTo` narrows the cohort to one named player, turning every
downstream stat into a focused 1:1 comparison instead of a cohort median.
`refresh=1` bypasses the disk cache for ranking queries — use after logging new
runs.

`/api/dps-series` is deliberately split out and lazy-loaded: it pulls the raw
damage event stream (tens of thousands of events), so the report renders first
and the chart arrives after.

## Tracked characters

Which characters exist is data, not code — `characters.json` in the project
root, managed through four more endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/character?name&server&region&zone` | Detect a character's class and spec list (the add form's preview) |
| `GET /api/characters` | The saved list |
| `POST /api/characters` | Add or update one (validated) |
| `DELETE /api/characters/:id` | Stop tracking one |

`detectCharacter()` needs a single WCL round trip: `Character.classID` gives the
class (looked up in the cached `gameData.classes`), and `zoneRankings.allStars`
reveals which specs actually have logged runs — so the add form can pre-check
them. A character or server that doesn't exist comes back as `character: null`,
which becomes a 404 rather than a 500.

`validateCharacter()` in `server/characters.js` is the trust boundary. It
re-checks the class exists, that every spec belongs to it, and that every spec
is DPS — because a bogus `specName` does **not** error against Warcraft Logs, it
silently returns zero rankings (see [wcl-api.md](wcl-api.md#the-spec-slug-vs-display-name-trap)).
Specs are stored as `{ name, slug }`; only the slug is ever sent to the API.

## Frontend

[`public/app.js`](../public/app.js) is plain DOM manipulation — no framework,
no bundler. Notable pieces:

- **Dynamic tabs** — fetched from `/api/characters` on boot, one per character,
  plus an *Add character* tab. The active character's `className` and the
  selected spec **slug** drive every request. Name/server are display-only in
  the character bar: letting them be edited freely would desync `className` from
  the character and silently pull another class's cohort.
- **Timeline SVG** — one lane per cooldown-gated ability. Lanes are chosen
  server-side purely by cast frequency, never by ability name, so it survives
  ability reworks.
- **DPS chart with brush** — drag to select a time window; the cast-order
  columns and rotation-composition table below re-filter to that window, so
  you can inspect any individual pull rather than only the opener. Uses mouse
  events with document-level move/up listeners (not pointer capture).
- **Escaping** — every interpolated value goes through `esc()`. All rendering
  is template strings into `innerHTML`, so this is the only thing standing
  between a player name and an XSS.

## Analysis modules

| Module | Responsibility |
| --- | --- |
| `metrics.js` | Per-run facts: total CPM, per-ability casts/CPM, damage share, idle windows, deaths, aura uptimes (raw + active), and the DK-specific spender mix / Runic Power waste |
| `compare.js` | `buildReport` — diffs my metrics against the cohort median, produces ranked `gaps[]`, the tables, consumables, and the honesty footer |
| `advice.js` | One concrete sentence per gap, derived from the diff |
| `spikes.js` | Why their damage spikes are bigger: aligns burst windows to each run's own peak, then diffs damage casts and amplifiers inside them |
| `timeline.js` | Lane selection + the "info" sentence about lane differences |
| `parseTiers.js` | How much more DPS you need for the next parse color, projected from your own logged (percentile, DPS) pairs at that key level |
| `summary.js` | The prose summary and "what to do next time" list — restates ranked gaps, never introduces a new claim |

The split matters: `metrics.js` only measures one run, `compare.js` only
compares, `advice.js` only phrases. Nothing downstream can invent a number that
wasn't measured upstream.
