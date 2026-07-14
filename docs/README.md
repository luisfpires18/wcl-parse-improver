# Documentation

Reference docs for `wcl-parse-improver` — a local web app that compares your
Warcraft Logs Mythic+ parses against top players of the same class/spec and
tells you, from the data alone, what they do differently.

Start with the [project README](../README.md) for setup and CLI usage. These
docs cover how the thing actually works.

| Doc | What's in it |
| --- | --- |
| [architecture.md](architecture.md) | Modules, request flow, HTTP endpoints, frontend structure |
| [metrics.md](metrics.md) | Every number the report shows: severity formulas, the honesty model, parse tiers, spike analysis, rotation similarity |
| [wcl-api.md](wcl-api.md) | Warcraft Logs API quirks learned the hard way — keystone packing, bracket indices, spec filtering, actor name collisions |
| [caching.md](caching.md) | The two-layer disk cache, rate limiting, refresh, debug dumps |
| [adding-a-spec.md](adding-a-spec.md) | Adding characters/specs from the UI, why DPS-only, and which code is still Death Knight-specific |

## Design rules this project holds itself to

These are the constraints that shaped the code. Break them and the tool starts
lying to the user.

1. **Data over opinion.** Advice is derived from the diff between your run and
   the cohort's. There is no hardcoded "correct rotation" that rots on patch
   day. (A curated Unholy DK rotation guide page used to exist; it was removed
   for exactly this reason.)
2. **Never claim more than you measured.** The report's honesty footer states
   how much of the DPS gap the rotational metrics actually explain, discounts
   overlapping causes, and caps the claim at 95%.
3. **Separate "your mistake" from "not your fault".** Group-comp buffs you
   never had, and uptime lost to deaths/downtime, are pulled out of the gap
   list and shown separately so they never read as execution errors.
4. **Compare against medians, not a single hero run.** One top player having a
   lucky pull is not a target.
5. **Fail loud, degrade quiet.** Unexpected API payloads get dumped to
   `debug/` rather than crashing; spec-specific analysis that doesn't apply
   (e.g. Runic Power waste on a Demon Hunter) simply doesn't render.
6. **Node-only, sane deps.** Express is the single runtime dependency. Tests
   run on `node:test` against real captured API payloads in `fixtures/`.
