# Metrics

Every number the report shows, and where it comes from.

## Severity — the orange badge on each gap

Severity is a heuristic estimate of **how many percentage points of your DPS
gap that one problem costs you**. Each gap category has its own formula and its
own hand-picked weight, computed in
[`buildReport`](../server/analysis/compare.js). The result is clamped to `>= 0`,
rounded to one decimal, and the list is sorted descending.

| Gap | Severity formula | Only shown if |
| --- | --- | --- |
| Deaths | `(myDeaths − cohortDeaths) × 4` | more deaths than the cohort median |
| Total CPM | `pctBehind × 0.8` | `myCPM < cohortCPM × 0.97` |
| Idle time | `myIdle% − cohortIdle%` (raw pp, weight 1.0) | more than 1pp idler |
| Ability usage | `relCpmDiff × theirDamageShare × 100` | `\|severity\| >= 0.5` |
| Aura uptime | `activeUptimeDiff × 0.15` | the aura is self-cast (actionable) |
| Spender mix | `shareDiff × 5` | share differs by more than 10pp |
| Runic Power waste | `(myWaste% − cohortWaste%) × 0.5` | more than 3pp above the cohort |

The **ability formula** is the interesting one — *missing casts × how much that
ability actually matters*:

```js
const relDiff  = (cohortCpm - myCpm) / cohortCpm;   // fraction of casts missing
const severity = relDiff * Math.max(share, 0.005) * 100;
```

That's why an ability you cast 26% less often can still rank below one you cast
only 15% less often: the second carries more of the cohort's damage. Abilities
below `MIN_DAMAGE_SHARE` (1%) are dropped entirely unless somebody is casting
them at least 0.5 CPM.

**Severities are not comparable across categories with any precision.** The
`×4`, `×0.8`, `×0.15`, `×5` weights are tuned constants, not sim-derived.
Ranking *within* a category is sound; "is 4.0 deaths worse than 4.2 CPM" is a
judgment call baked into those numbers.

## The honesty footer

Severities are deliberately **not** summed naively — deaths cause idle time
causes low CPM, so adding all three triple-counts one mistake.

```js
const throughput = Math.max(sevOf('cpm'), sevOf('downtime')) + sevOf('deaths');
const rest       = (sevOf('ability') + sevOf('uptime') + sevOf('spender') + sevOf('waste')) * 0.6;
const explained  = throughput + rest;
explainedPct = Math.min(95, 100 * explained / dpsGapPct);
```

Only the largest of the overlapping throughput cluster counts, the rest is
discounted 40%, and the claim is capped at 95% — the tool never asserts it has
fully explained a gap. When you *match or beat* the comparison there is no
positive gap to attribute, and `explainedPct` is `null` rather than a nonsense
negative.

The unexplained remainder is routing, pull size, group comp and funnel —
things a parse comparison genuinely cannot see, and the footer says so.

## What gets excluded from "your mistakes"

Two categories are pulled out of the gap list and rendered separately:

- **Group-comp buffs** — auras you never gained at all, or that the log's own
  apply/remove events prove were cast by a groupmate (see
  [wcl-api.md](wcl-api.md#buff-provenance)). Their Augmentation Evoker is not
  your execution error.
- **Downtime-caused uptime loss** — auras where your *raw* uptime trails the
  cohort but your *active-time* uptime (fight minus idle windows) matches.
  The loss came from dying, and dying is already counted above. Fix that, not
  the buff.

## Per-run metrics

From [`computeRunMetrics`](../server/analysis/metrics.js):

- **Total CPM** — casts per minute over the fight. Runs differ in length, so
  raw cast counts are never compared directly.
- **Idle windows** — gaps longer than `DOWNTIME_GAP_MS` (5s) with zero casts.
  `idlePct` is their share of the fight.
- **Active uptime** — aura uptime measured over engaged time (fight minus idle
  windows), so downtime doesn't double-count as buff mismanagement.
- **Damage share** — each ability's fraction of that player's total damage.
- **Runic Power waste** *(DK only)* — WCL's own computed `waste` field on
  resource-gain events, not derived or guessed.

Utility spells (`IGNORED_ABILITIES`) are excluded everywhere — Icebound
Fortitude, Shadowmeld, Death Charge and friends are not rotation.

## Parse tiers

[`parseTiers.js`](../server/analysis/parseTiers.js) answers "how much more DPS
for the next color". Tiers are the WCL percentile bands:

| gray | green | blue | purple | orange | pink |
| --- | --- | --- | --- | --- | --- |
| 0 | 25 | 50 | 75 | 95 | 99 |

The DPS-per-percentile slope is fitted from **your own logged `(rankPercent,
dps)` pairs at that exact key level** — never a guessed population curve, which
WCL does not expose. Percentiles are bracket-relative, so mixing key levels
would corrupt the fit. Needs at least `MIN_POINTS` (2) real runs at the level;
shows at most 3 tiers ahead, and only tiers above your *current* best.

## Spike analysis

[`spikes.js`](../server/analysis/spikes.js) answers "why is their burst bigger".

Naive window comparison fails because two runs pull at different times — a
fixed absolute-time window compares your trash pull to their boss. So:

1. Find their DPS peaks (local maxima in the binned series).
2. Align **each run's window to its own burst peak** within `±ALIGN_SEC` (30s),
   not to the wall clock.
3. Inside the aligned windows, diff the **damage casts** (`Scourge Strike ×9`
   vs `×2`) and which **amplifiers** fired (Army of the Dead, Dark
   Transformation, potions…). Utility casts are excluded.
4. Measure opener timing from each player's **first damage cast**, not from
   fight start, and only flag a difference larger than `START_GAP_SEC` (6s).

## Rotation similarity

Shown for whatever time window you brush on the DPS chart. Two different
numbers, because they answer different questions:

- **Spell mix** — total-variation *match* of the two cast-count distributions:
  `100·(1 − ½Σ|pᵢ−qᵢ|)`, i.e. the share of casts landing on the same button in
  the same proportion. Order-blind. Answers "are we pressing the same buttons,
  as often?"
- **Cast order** — the same match applied to cast-to-cast *transition* (bigram)
  distributions. Order-sensitive. Answers "in the same sequence?"

**Why not cosine?** Cosine of raw cast-count vectors is magnitude-dominated and
scale-invariant, so the handful of big shared buttons pin it near 99% for *any*
two runs of the same spec — it can't tell a great player from a mediocre one.
TV match spreads out honestly: across real top-player fixtures, spell mix lands
~84–91% and cast order ~65–75%, where cosine reported 97–100% / 83–97%.

They diverge usefully. A real result from this tool: 89% spell mix, 70% cast
order — nearly the same buttons, but meaningfully different sequencing. They
alternated Death Coil ↔ Scourge Strike; the player chained Scourge Strike →
Scourge Strike.
