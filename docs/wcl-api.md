# Warcraft Logs API notes

Quirks of the [v2 client API](https://www.warcraftlogs.com/api/docs) that this
project learned by probing real payloads. Most cost a bug first.

Auth is OAuth2 client-credentials ([`auth.js`](../server/wcl/auth.js)); the
token is fetched once and reused. Credentials live in `.env`, which is
gitignored and must never be committed.

## Loosely-typed JSON scalars

`zoneRankings`, `encounterRankings`, `characterRankings`, `table` and `events`
are all declared as generic JSON scalars in the schema. GraphQL gives you no
field validation on them at all.

Everything under [`server/parse/`](../server/parse/) therefore parses
defensively: unexpected shapes are written to `debug/` via `dumpDebug()` and
the code carries on with a sane default, rather than throwing on a payload the
API changed under you.

## Keystone level is packed into numeric fields

M+ rankings don't carry the key level as its own field. It's arithmetic-encoded
into the metric:

```
bestAmount  = keyLevel * 2e7 + DPS
fastestKill = durationMs - keyLevel * 2e7
```

Decoded in [`parse/zoneRankings.js`](../server/parse/zoneRankings.js).

## `characterRankings(bracket:)` is an index, not a key level

The `bracket` argument is a 1-based **index into the zone's bracket list**, not
the keystone level:

```js
bracketIndex = Math.round((keyLevel - brackets.min) / brackets.bucket) + 1;
```

For zone 47 (`min: 2`, `bucket: 1`) that's `keyLevel - 1`. Verified
empirically: `bracket: 20` returns runs whose `bracketData` is `21`.
[`fetchTopRuns`](../server/wcl/api.js) computes this from a cached
`ZONE_BRACKETS` query and then **verifies** the returned rows actually match
the requested level, dumping a debug file if they don't. Don't trust the
mapping blindly — it's the kind of thing that changes silently.

## Spec filtering

**`zoneRankings` and `encounterRankings` return your best across *all* specs
unless you pass `specName`.** This is the single nastiest default in the API.

Without it, a Demon Hunter's "best Pit of Saron" silently mixed in a Devourer
run, and a Death Knight's overview average blended Frost runs into Unholy.
Nothing errors; the numbers are just quietly wrong.

`specName` is threaded through `fetchOverview`, `fetchMyEncounterRuns` and
`buildComparison` so the overview, the cohort, *and* which of your own runs are
eligible all agree on one spec.

**`specName: null` is not "no filter" — it's an error.** Passing the argument as
an explicit null makes WCL answer `Internal server error`, for both the `dps`
and `playerscore` metrics. To mean "all specs" the argument must be **omitted
from the variables entirely**, which is what `withSpec()` in
[`api.js`](../server/wcl/api.js) exists to do.

## Class and spec metadata

`gameData.classes { id name slug specs { id name slug } }` returns all 13
classes. `Character.classID` indexes it directly, which is how the "add
character" flow auto-detects a class from just name + server + region.

Crucially, **`class.slug` is exactly the `className` the ranking queries want**
(`DeathKnight`, `DemonHunter` — not the display name `Death Knight`), and
`spec.slug` is exactly the `specName`. Because the spec list comes from the API
rather than a hardcoded table, a newly added spec (Devourer) appears on its own.

Game data changes only on patches, so this sits in the disk cache indefinitely.

### The spec slug vs display name trap

`characterRankings(specName:)` requires the spec **slug**:

| `specName` | Result |
| --- | --- |
| `"BeastMastery"` | 100 rankings |
| `"Beast Mastery"` | **0 rankings, no error** |

`zoneRankings` tolerates *both* forms, so a codebase that only exercises the
character's own rankings will look perfectly healthy right up until the cohort
comes back empty. Every spec name that reaches the API must be the slug;
`spec.name` is display-only. Guarded by `test/characters.test.js`, which asserts
the stored spec keeps `slug: "BeastMastery"` alongside `name: "Beast Mastery"`.

Note that `zoneRankings.allStars[].spec` also reports slugs — which is what lets
the add-character form pre-check the specs that actually have logged runs.

## Roles are not in the API

`GameSpec` exposes `id`, `class`, `name`, `slug` — and no role. `RoleType` is
`Any | DPS | Healer | Tank`, but nothing maps a spec onto one.

So `server/wcl/specs.js` carries a small hardcoded map of the non-DPS specs,
keyed by `` `${classSlug}/${specSlug}` ``. The compound key is mandatory: `Holy`
is both Paladin and Priest, `Protection` is both Paladin and Warrior, and
`Frost` is both Death Knight and Mage. Anything absent from the map is DPS, so
new specs need no code change.

## Actor name collisions inside one report

`masterData.actors` can contain **two different characters with the same name**
— e.g. one player's Death Knight on Aggra and their Demon Hunter on Grim Batol
both appearing in the same log:

```json
[{ "id": 2,  "name": "Unreally", "subType": "DeathKnight",  "server": "Aggra(Português)" },
 { "id": 45, "name": "Unreally", "subType": "DemonHunter", "server": "GrimBatol" }]
```

Matching on name alone picks the first one. That resolves to the wrong actor
ID, every table query returns that character's (empty, for this fight) casts,
and the whole report reads **0 CPM** while the headline DPS — which comes from
the ranking scalar, not the fight detail — still looks correct. A silent,
convincing failure.

[`resolveActor`](../server/wcl/api.js) therefore disambiguates same-named
actors by **server, then class**, using the character the caller asked for.
Server names normalize across formats (`"GrimBatol"` ≈ `"grim-batol"`,
`"Aggra(Português)"` ≈ `"aggra-portugues"`). Guarded by
[`test/resolveActor.test.js`](../test/resolveActor.test.js).

## `sourceID` on events already folds in pets

Querying `events(dataType: DamageDone, sourceID: <player>)` returns the
player's pet damage too — Magus of the Dead and ghoul abilities come back under
the player's own `sourceID`. Verified against a real payload. One query covers
total output; do **not** separately fetch and add pet actors, or you'll
double-count.

## Buff provenance

Every event returned by `events(dataType: Buffs, sourceID: <me>)` carries its
*own* `sourceID` — the actor who actually applied the aura. The `sourceID`
argument means "whose uptime am I viewing", not "who cast it".

That's the discriminator between a self-buff and a raid buff. Verified on a
real payload: for Black Attunement (an Augmentation Evoker buff) every
apply/remove event on the player was sourced from a groupmate; for Dark
Transformation all 72 were self-sourced. `classifyBuffSources()` uses this to
keep external buffs out of "fix your rotation" advice, regardless of how much
uptime you happened to have.

## Resource events

For Runic Power: `resourceChangeType === 6`, `maxResourceAmount: 1000` (RP is
scaled ×10, so 1000 = 100.0 RP), and `sourceID === targetID`. The stream
contains **only gain events**, each carrying WCL's own computed `waste` field
(how much of that gain exceeded the cap) — which is exactly what a waste metric
needs, and means nothing has to be derived. Other `resourceChangeType` values
(e.g. `3`, targeting a pet) are a different actor's resource and are filtered
out.

## Percentiles

Best % / Median % come from `encounterRankings` per-bracket parse pools — the
same numbers the WCL character page shows, verified digit-for-digit. They are
**bracket-relative**, so a percentile at +21 is not comparable to one at +19,
and the site's headline "Best %" may come from a *higher* key than the one
you're currently comparing at.

## Unused, but available

The `combatantInfo` event carries full gear (item IDs, item level, enchants,
bonus IDs, gems, set IDs), the talent tree, `specID`, and the character's
computed secondary stats (mastery, crit, haste, versatility). Enough to build a
SimulationCraft profile from the log alone, with no Armory access. Nothing
currently reads it.
