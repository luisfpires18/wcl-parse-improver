# v2 roadmap (proposal — not built)

Ideas ordered by expected value per effort. Nothing here is started; the MVP
is deliberately table-level because tables are cheap (API points) and stable.

## 1. Event-level rune / runic power waste

Fetch `events(dataType: Resources)` for my run only (cohort optional later):
time spent rune-capped and RP overcap wasted per minute, compared to the
cohort's spender cast rates. This is the classic "invisible" parse leak and
the most requested next metric.

Cost: ~2-4 extra event queries per report; needs pagination.

## 2. Per-pull segmentation

M+ logs are one long fight, but cast events + downtime windows already give
natural pull boundaries (gaps with no casts and no damage). Segment both my
run and cohort runs into pulls, align them by ordinal, and report "you lose
most of your gap in pulls 4-6 (the gauntlet)" instead of whole-run averages.
Also makes the downtime advice concrete: which pack transition costs the
most.

## 3. Parse improvement tracking over time

`encounterRankings.ranks[]` already contains every logged run with timestamps
and percentiles. Store a snapshot per day (tiny JSON, no extra API cost
beyond what the overview fetches) and chart Best %/Median % per dungeon over
weeks. Answers "is the practice working?".

## 4. Live guide enrichment

Optionally fetch the current Unholy M+ guide (wowhead / icy-veins) at report
time, and show "guide says" alongside each "data says" gap — clearly
separated, never merged, so patch-day guide drift can't corrupt the data
conclusions.

## 5. Talent / gear diffs

characterRankings entries and report data expose talents/gear in some
payload variants. Surface "4 of 5 top players run X, you run Y" without
judging. Needs shape probing per patch; kept last because it's the most
volatile surface.

## Infra niceties

- Cache eviction by age (currently manual `rm -rf cache/`)
- Progress streaming for the first slow report fetch (SSE)
- Multi-character profiles
