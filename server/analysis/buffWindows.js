// Which buffs were UP, and when.
//
// Every other rotation view in this project reads cast events. That makes it
// structurally blind to a whole class of mistake: a buff that is never *cast*.
// Inertia (Havoc) is a proc off Vengeful Retreat — it appears in no cast stream,
// so cast-order analysis can never see that the top player fired The Hunt inside
// it and you fired it bare. Same blind spot hides Metamorphosis windows, Avenging
// Wrath, Dark Transformation, trinket procs.
//
// The log already answers this: the Buffs table ships per-aura time bands, for
// both runs, on any non-lite fetch. So we draw them and let the player read it.
//
// NOTHING here is spell knowledge. A buff qualifies purely because it is
// self-applied and impermanent — the same "frequency-based, never name-based"
// rule the cooldown lanes already use (see timeline.js). It keeps working when a
// patch renames Wings or reworks Inertia, because it never knew their names.
import { IGNORED_ABILITIES } from './metrics.js';

// Show the spec's whole buff kit, not a top-N. A previous cut ranked lanes by
// uptime and kept only 6 — which starves exactly the buffs that matter most: the
// SHORT ones. A Havoc DH's Inertia is a ~5s window off Vengeful Retreat, so it
// loses every uptime contest to Metamorphosis and Demonsurge and never gets a
// lane, while being the entire reason their burst is bigger. The cap is now just
// a sanity bound, not an editorial choice.
const MAX_BUFF_LANES = 16;
// A buff up nearly all fight is a passive, not a window you open.
const PERMANENT_UPTIME_CEILING = 90;
// …and one that barely exists is noise on a chart.
const MIN_UPTIME_PCT = 1;
// Consumables are self-applied and can dip under the uptime ceiling (food falls
// off, a flask is re-applied), but they are not rotation. Matching them by name
// is safe: this is a stable consumable naming convention, not patch-volatile
// talent knowledge — and compare.js already keys flask/food detection off the
// same convention.
const CONSUMABLE_RE = /flask|phial|well fed|\bfood\b|rune of|augment rune|potion of/i;

/**
 * The self-applied, impermanent buffs of one run, as fight-relative bands.
 *
 * @param {object} detail a fetchRunDetail() result (needs .buffs and .fight)
 * @param {Record<string, {self:number, foreign:number}>} buffSources from
 *   classifyBuffSources(). Only ever computed for "mine" — which is correct and
 *   sufficient: whether a DK can self-apply Dark Transformation is a property of
 *   the ability, not of one run. Both sides of a comparison are the same spec, so
 *   mine's classification filters theirs. (Same rationale as the
 *   REPORT_BUFF_SOURCE_EVENTS comment in wcl/queries.js.)
 * @returns {{name:string, uptimePct:number, uses:number, bands:{startMs:number,endMs:number}[]}[]}
 */
export function selectBuffWindows(detail, buffSources = {}, { maxLanes = MAX_BUFF_LANES } = {}) {
  const fight = detail?.fight ?? {};
  const start = fight.startTime ?? null;
  const end = fight.endTime ?? null;
  if (start == null || end == null || end <= start) return [];
  const durationMs = end - start;

  const out = [];
  for (const aura of detail?.buffs?.auras ?? []) {
    const name = aura?.name;
    if (!name || IGNORED_ABILITIES.has(name)) continue;
    if (CONSUMABLE_RE.test(name)) continue; // flask/food/rune — not rotation

    // Self-applied only. An external raid buff (Bloodlust, Power Infusion, an
    // Augmentation's blessing) is someone else's play, not yours — it belongs in
    // the group-comp notes, not in your rotation timeline.
    const src = buffSources?.[name];
    if (!src || !(src.self > 0)) continue;

    const bands = clampBands(aura.bands ?? [], start, end);
    if (!bands.length) continue;

    const activeMs = bands.reduce((acc, b) => acc + (b.endMs - b.startMs), 0);
    const uptimePct = (100 * activeMs) / durationMs;
    if (uptimePct < MIN_UPTIME_PCT || uptimePct > PERMANENT_UPTIME_CEILING) continue;

    out.push({ name, uptimePct: round1(uptimePct), uses: aura.uses ?? bands.length, bands });
  }

  // most-present first, so the chart shows the buffs that actually shape the run
  out.sort((a, b) => b.uptimePct - a.uptimePct || a.name.localeCompare(b.name));
  return out.slice(0, maxLanes);
}

/**
 * Pick ONE shared lane set across two runs, so the two timelines are visually
 * comparable — the same buff sits on the same row in both, and a buff that only
 * one of them ever had still gets a (visibly empty) lane in the other. Mirrors
 * how buildTimeline() picks its shared cast lanes.
 */
export function sharedBuffLanes(mineWindows, otherWindows, { maxLanes = MAX_BUFF_LANES } = {}) {
  const combined = new Map(); // name -> summed uptime across both runs, for ranking only
  for (const w of [...mineWindows, ...otherWindows]) {
    combined.set(w.name, (combined.get(w.name) ?? 0) + w.uptimePct);
  }
  return [...combined.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxLanes)
    .map(([name]) => name);
}

/** Absolute report-clock bands -> fight-relative ms, clipped to the fight. */
function clampBands(bands, start, end) {
  const out = [];
  for (const b of bands) {
    const lo = Math.max(b.startTime, start);
    const hi = Math.min(b.endTime, end);
    if (hi > lo) out.push({ startMs: lo - start, endMs: hi - start });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const round1 = (v) => Math.round(v * 10) / 10;
