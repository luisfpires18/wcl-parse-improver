# Caching, rate limiting and debugging

WCL bills API usage in points and the heavy queries are slow. The tool is built
so that iterating on analysis code costs **zero** API calls: fetch once, then
replay from disk forever.

All of it lives in [`server/wcl/client.js`](../server/wcl/client.js).

## Two layers

### 1. Raw GraphQL cache — `cache/<hash>.json`

Every successful response is written to disk, keyed by
`sha256(query + JSON.stringify(variables))`. A cache hit skips the network
entirely. Because the key includes variables, changing *any* argument
(including `sourceID` or `specName`) is naturally a different entry.

This is why the second `buildComparison` call — the one `/api/dps-series` makes
after `/api/report` already ran — is free.

### 2. Derived cache — `cache/derived-<key>.json`

For values where the upstream payload is enormous but the useful result is
tiny. Currently just the binned DPS-over-time series: the raw damage event
stream for one run can be ~15 MB, while the 5-second-binned series is a few KB.

Those raw event pages are fetched with `noCache: true` so the blob is **never**
persisted; only the compact series is cached.

The derived key must identify the *player*, not just the fight:

```js
const who = `${playerName}@${server ?? ''}`.toLowerCase();
const cacheKey = `dps-${code}-${fightID}-${binMs}-${who}`;
```

One report+fight can contain two same-named actors (see
[wcl-api.md](wcl-api.md#actor-name-collisions-inside-one-report)); a
player-agnostic key would happily serve the wrong character's cached series.

## Refreshing after new runs

Report *contents* never change once uploaded — a new best run just produces a
new report code, which is a natural cache miss. Only the **ranking** queries go
stale, so only those need bypassing.

`refresh=1` on `/api/overview` or `/api/report` sets `noCache` for the ranking
fetches. In the UI this is the **↻ Refresh data** button on both the overview
and the report. Nuking `cache/` entirely also works, at the cost of refetching
everything.

## Rate limiting

`gql()` sleeps so that consecutive **uncached** network fetches are at least
`FETCH_DELAY_MS` (400ms) apart. The limiter is a module-level timestamp, which
means **parallel calls would race it**. Fetches are therefore issued
sequentially on purpose — the `await`-in-a-loop in `buildComparison` and the
back-to-back `fetchDamageSeries` calls in `/api/dps-series` are not an
oversight. Don't "optimize" them into `Promise.all`.

Cost in practice: the first report for a dungeon pulls ~6 reports and takes up
to a minute. Everything after is instant.

## Debug dumps

`dumpDebug(name, payload)` writes an unexpected payload to
`debug/<name>-<timestamp>.json` and logs the path, instead of throwing. It's
used for GraphQL errors, unresolvable actors, missing fights, bracket→level
mismatches, and any scalar that doesn't parse to the expected shape.

If a report renders with obviously wrong numbers, look in `debug/` first — the
tool usually already noticed and wrote down what confused it.

## Testing without the network

[`fixtures/`](../fixtures/) holds real captured API payloads. `npm test` runs
`node:test` suites entirely against those, so the whole analysis layer is
tested offline and deterministically. `scripts/analyze.js` will also re-run the
analysis over a saved fixture with no API access at all.
