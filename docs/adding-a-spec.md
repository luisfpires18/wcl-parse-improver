# Adding characters, classes and specs

Adding a character is a **UI action**, not a code change. Click *＋ Add
character*, type name / server slug / region / zone, hit **Detect class**. The
class is read from Warcraft Logs, its specs are listed, and the ones with logged
runs are pre-checked. Tick the specs you want and save.

Only the specs you tick are ever analysed. Add a Shaman, tick only Enhancement,
and Elemental/Restoration runs are excluded from every number — the overview,
the cohort, and which of *your* runs are eligible.

The result lands in `characters.json` in the project root, which you can also
hand-edit:

```json
[{ "id": "unreally-aggra-portugues-deathknight",
   "name": "Unreally", "server": "aggra-portugues", "region": "EU", "zone": 47,
   "className": "DeathKnight", "classLabel": "Death Knight",
   "specs": [{ "name": "Unholy", "slug": "Unholy" }, { "name": "Frost", "slug": "Frost" }] }]
```

`slug` is what goes to the API; `name` is what you read. They differ for
multi-word specs (`BeastMastery` vs `Beast Mastery`) and getting it wrong
returns an empty cohort **with no error** — see
[wcl-api.md](wcl-api.md#the-spec-slug-vs-display-name-trap).

## DPS specs only

The report is damage-shaped end to end: the headline is a DPS gap, per-ability
severity is weighted by each ability's *share of damage*, the chart is
DPS-over-time, and spike analysis diffs damage casts. None of that means
anything for a healer.

So healer and tank specs are listed in the picker — you can see the class's full
set — but disabled, labelled `healer, not supported` / `tank, not supported`.
The server rejects them too (`validateCharacter`), because the client is not a
trust boundary.

Roles come from a hardcoded map in [`server/wcl/specs.js`](../server/wcl/specs.js),
keyed by `` `${classSlug}/${specSlug}` `` — the API has no role field, and a
spec-name-only key would be wrong (`Holy` is Paladin *and* Priest; `Protection`
is Paladin *and* Warrior; `Frost` is Death Knight *and* Mage). Anything absent
from the map is DPS, so a new spec like Devourer works with no code change.

## What already generalizes

These read the log and adapt on their own — no per-spec code:

- overview, percentiles, parse tiers, the DPS-gap headline
- total CPM, per-ability CPM weighted by *the cohort's own* damage share
- idle windows, deaths, aura uptimes (raw and active-time)
- the rotation timeline (lanes picked by cast frequency, never by name)
- cast-order columns, spell-mix and cast-order similarity
- consumables (flask/food diff), group-comp buff separation
- the summary, advice sentences and honesty footer

## What is still Death Knight-specific

Four places. Each is gated, so other specs get nothing rather than something
wrong.

| Where | What | On another spec |
| --- | --- | --- |
| [`comparison.js`](../server/wcl/comparison.js) | `NAMED_PLAYERS` — two fixed reference players always added to the cohort | Gated to `DeathKnight`/`Unholy`; others get a pure top-5 cohort |
| [`compare.js`](../server/analysis/compare.js) | `statPriorityNote` — "Mastery > Crit > Haste > Vers" | Gated to Unholy; others get a generic "match your spec's stat priority" |
| [`spikes.js`](../server/analysis/spikes.js) | `AMPLIFIERS` — named damage cooldowns (Army of the Dead, Dark Transformation, potions…) | Empty, so burst windows show cast diffs but no amplifier line |
| [`advice.js`](../server/analysis/advice.js) | `ABILITY_MECHANIC_NOTE` for Graveyard / Necrotic Coil | Never matches |

The **resource panels** are handled by spec capabilities in
[`specs.js`](../server/wcl/specs.js) rather than by a class check at the render
site. `buildReport` sets `tables.spender` / `tables.rpWaste` to `null` when they
don't apply and the UI skips null panels, so a Shaman is never shown a row
labelled *Death Coil casts*:

- `usesRunicPower(classSlug)` — RP waste, true for **all** Death Knight specs.
- `usesEpidemicSpenderMix(classSlug, specSlug)` — the Death Coil vs Epidemic
  split, **Unholy only**; Frost spends on Frost Strike.

`FLASK_STAT` in `compare.js` maps flask names to secondary stats. It's
class-agnostic and only needs updating when a patch adds flasks.

## Making the last four generic

The clean shape is a spec registry — one entry per spec exporting its amplifier
list and any spec-specific notes:

```js
{ className, specName, amplifiers: Set<string>, statPriority: string | null,
  mechanicNotes: Record<string, string> | null }
```

`spikes.js`, `compare.js` and `advice.js` would look the spec up instead of
importing a constant. The resource capabilities in `specs.js` already follow
this shape and are the model to copy.

## Adding a spec's damage cooldowns

Optional, and the only per-spec thing worth doing by hand: add the spec's burst
cooldowns to `AMPLIFIERS` in `spikes.js` so the spike windows can say *why*
their burst was bigger. Without it everything else still works.
