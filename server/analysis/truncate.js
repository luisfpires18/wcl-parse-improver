// Clip a run to a time window.
//
// Used to make a wipe comparable to a kill: a pull that took the boss from 100%
// to 62% is only ever compared against the slice of the kill that covers the
// same 100%→62% (see parse/bossHealth.js for how that cutoff is found). Both
// sides of the comparison must then be measured over their own window — hence
// this.

/** Clip a binned DPS series to `cutoffSec`. A null cutoff means "no cut". */
export function truncateSeries(series, cutoffSec) {
  if (cutoffSec == null || !series?.points) return series;
  return {
    ...series,
    points: series.points.filter((p) => p.tSec <= cutoffSec),
    durationMs: Math.min(series.durationMs ?? Infinity, cutoffSec * 1000),
  };
}

/**
 * Clip a run detail to `cutoffSec`. Cast events and deaths filter by time, but
 * the Casts TABLE is an aggregate over the WHOLE fight — so its per-ability
 * counts and its active time are REBUILT from the cast events that survive the
 * cut. Without that, a truncated run would silently keep the full fight's cast
 * counts, and every downstream per-minute rate (CPM, cooldown-lane selection,
 * rotation composition) would be computed against the wrong denominator.
 */
export function truncateDetail(detail, cutoffSec) {
  if (cutoffSec == null || !detail) return detail;
  const start = detail.fight?.startTime ?? 0;
  const cutAbs = start + cutoffSec * 1000;
  const castEvents = (detail.castEvents ?? []).filter((e) => e.timestamp <= cutAbs);

  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));
  const counts = new Map();
  for (const e of castEvents) {
    const n = nameOf.get(e.abilityGameID);
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const abilities = (detail.casts?.abilities ?? [])
    .map((a) => ({ ...a, casts: counts.get(a.name) ?? 0 }))
    .filter((a) => a.casts > 0);

  return {
    ...detail,
    fight: { ...detail.fight, endTime: Math.min(detail.fight?.endTime ?? cutAbs, cutAbs) },
    castEvents,
    casts: { totalTimeMs: Math.round(cutoffSec * 1000), totalCasts: castEvents.length, abilities },
    deaths: { deaths: (detail.deaths?.deaths ?? []).filter((d) => d.timestamp <= cutAbs) },
    buffs: truncateBuffs(detail.buffs, cutAbs, cutoffSec),
  };
}

/**
 * Clip aura bands to the window. Without this a truncated benchmark keeps the
 * buff bands of its FULL kill, so a buff lane would draw past the end of the
 * comparison window and the uptime would be measured against the wrong span —
 * silently claiming they held a buff during minutes we aren't even comparing.
 */
function truncateBuffs(buffs, cutAbs, cutoffSec) {
  if (!buffs?.auras) return buffs ?? { totalTimeMs: null, auras: [] };
  const auras = [];
  for (const a of buffs.auras) {
    const bands = (a.bands ?? [])
      .map((b) => ({ startTime: b.startTime, endTime: Math.min(b.endTime, cutAbs) }))
      .filter((b) => b.endTime > b.startTime && b.startTime <= cutAbs);
    if (!bands.length) continue; // the aura only existed after the cutoff
    auras.push({
      ...a,
      bands,
      uptimeMs: bands.reduce((acc, b) => acc + (b.endTime - b.startTime), 0),
      uses: bands.length,
    });
  }
  return { totalTimeMs: Math.round(cutoffSec * 1000), auras };
}

/** Clip a {tSec,...} point list (e.g. a boss-health curve) to the window. */
export const truncatePoints = (points, cutoffSec) =>
  cutoffSec == null ? points : (points ?? []).filter((p) => p.tSec <= cutoffSec);
