// Boss health over time, reconstructed from damage dealt to the boss.
//
// Warcraft Logs exposes no boss-HP field on any event stream (verified: damage
// and resource events on an NPC carry no hitPoints/maxHitPoints). So the curve
// is derived instead, and self-calibrated against a number WCL DOES give us:
// `fightPercentage` — the boss health % REMAINING when the fight ended.
//
//   damageDealt over the fight  ==  (100 - pctRemaining)% of the boss's max HP
//   => maxHP = totalDamage / ((100 - pctRemaining) / 100)
//
// That works for a wipe (ends at e.g. 62% left) exactly as it does for a kill
// (ends at ~0%), so a wipe's curve is real, not an extrapolation. Healing and
// absorbs on the boss make this an approximation, but it is anchored at both
// ends (100% at the pull, pctRemaining at the end) which is what the comparison
// window needs.
import { dumpDebug } from '../wcl/client.js';

/**
 * Sum a WCL graph payload's per-source series into one bin array.
 * Each series is { pointStart, pointInterval, data: number[] } — one entry per
 * damage source (each raider), all sharing the same bin grid.
 * @returns {{pointStart:number, pointInterval:number, bins:number[]}|null}
 */
export function sumGraphSeries(graph) {
  const data = graph?.data ?? graph;
  const series = Array.isArray(data?.series) ? data.series : null;
  if (!series || !series.length) {
    dumpDebug('boss-graph-no-series', { graph });
    return null;
  }
  let pointStart = null;
  let pointInterval = null;
  const bins = [];
  for (const s of series) {
    if (!Array.isArray(s?.data)) continue;
    if (pointStart == null && typeof s.pointStart === 'number') pointStart = s.pointStart;
    if (pointInterval == null && typeof s.pointInterval === 'number') pointInterval = s.pointInterval;
    s.data.forEach((v, i) => {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
      bins[i] = (bins[i] ?? 0) + n;
    });
  }
  if (pointStart == null || !pointInterval || !bins.length) {
    dumpDebug('boss-graph-unexpected-shape', { pointStart, pointInterval, len: bins.length });
    return null;
  }
  return { pointStart, pointInterval, bins };
}

/**
 * Boss health curve for one fight.
 * @param {object} p
 * @param {{pointStart:number, pointInterval:number, bins:number[]}} p.summed from sumGraphSeries
 * @param {number} p.fightStart absolute ms
 * @param {number} p.pctRemaining boss health % left when the fight ended (0 = kill)
 * @returns {{points:{tSec:number,pct:number}[], maxHP:number, totalDamage:number, endPct:number}|null}
 */
export function buildHealthCurve({ summed, fightStart, pctRemaining }) {
  if (!summed) return null;
  const { pointStart, pointInterval, bins } = summed;
  const totalDamage = bins.reduce((a, b) => a + b, 0);
  if (totalDamage <= 0) return null;

  const endPct = clampPct(pctRemaining ?? 0);
  const dealtFraction = (100 - endPct) / 100;
  // A fight that dealt no meaningful % (e.g. an instant reset) can't be calibrated.
  if (dealtFraction <= 0.001) return null;
  const maxHP = totalDamage / dealtFraction;

  const points = [{ tSec: Math.max(0, (pointStart - fightStart) / 1000), pct: 100 }];
  let cum = 0;
  bins.forEach((v, i) => {
    cum += v;
    const tMs = pointStart + (i + 1) * pointInterval - fightStart;
    points.push({ tSec: Math.max(0, tMs / 1000), pct: clampPct(100 * (1 - cum / maxHP)) });
  });
  return { points, maxHP, totalDamage, endPct };
}

/**
 * First time (sec) the boss dropped to `pct` health or below. Linearly
 * interpolated inside the bin it crosses in, so a 5s bin doesn't quantise the
 * cutoff. Returns null if the boss never got that low in this fight.
 */
export function timeAtHealthPct(curve, pct) {
  if (!curve?.points?.length || typeof pct !== 'number') return null;
  const pts = curve.points;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (b.pct <= pct) {
      const span = a.pct - b.pct;
      const frac = span > 0 ? (a.pct - pct) / span : 0;
      return a.tSec + frac * (b.tSec - a.tSec);
    }
  }
  return null;
}

/**
 * Pick the boss NPC among a report's enemy actors. The encounter's fight name is
 * the boss's display name, usually with a title appended ("Chimaerus" ->
 * "Chimaerus, the Undreamt God"), so the NPC whose name is contained in the
 * fight name wins (longest match, to beat an add sharing a prefix). Falls back to
 * the lowest-id real NPC and logs, rather than silently charting an add.
 */
export function resolveBossActor(npcActors, fightName) {
  const norm = (s) => String(s ?? '').toLowerCase().trim();
  const fight = norm(fightName);
  const real = (npcActors ?? []).filter((a) => a && typeof a.id === 'number' && a.id > 0 && a.name);
  if (!real.length) return null;

  const matches = real
    .filter((a) => fight && (fight.includes(norm(a.name)) || norm(a.name).includes(fight)))
    .sort((x, y) => norm(y.name).length - norm(x.name).length);
  if (matches.length) return matches[0];

  dumpDebug('boss-actor-name-unmatched', { fightName, npcs: real.slice(0, 20).map((a) => ({ id: a.id, name: a.name })) });
  return [...real].sort((x, y) => x.id - y.id)[0];
}

function clampPct(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, v));
}
