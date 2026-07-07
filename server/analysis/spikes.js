// Explain the DPS-over-time spikes: WHERE the comparison run out-bursts mine
// and WHICH cooldowns drove it. Entirely data-driven — a "burst cooldown" is
// identified because casting it is followed by a real DPS lift (not a
// hardcoded list), so defensives/interrupts (Anti-Magic Shell, Mind Freeze)
// fall out on their own and this survives patches.
import { computeRunMetrics, IGNORED_ABILITIES } from './metrics.js';

const COOLDOWN_CPM = 1.5; // cast <= this often = a cooldown (off the global CD gate)
const LIFT_WINDOW_SEC = 12; // damage window credited to a cooldown after its cast
const MIN_LIFT_RATIO = 1.3; // post-cast DPS >= 1.3x this run's average = a DAMAGE cooldown
const LOOKBACK_SEC = 15; // a spike is driven by cooldowns cast up to this long before it
const MAX_SPIKES = 4;
const MERGE_SEC = 25; // treat peaks within this window as the same spike

/** name -> [relSec,...] cast times for this run's cooldown-frequency abilities. */
function cooldownCastTimes(detail) {
  const metrics = computeRunMetrics(detail);
  const isCd = new Set();
  for (const [name, a] of metrics.abilities) {
    if (IGNORED_ABILITIES.has(name)) continue;
    if (a.cpm > 0 && a.cpm <= COOLDOWN_CPM) isCd.add(name);
  }
  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));
  const start = detail.fight?.startTime ?? 0;
  const byName = new Map();
  for (const ev of detail.castEvents ?? []) {
    const name = nameOf.get(ev.abilityGameID);
    if (!name || !isCd.has(name)) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push((ev.timestamp - start) / 1000);
  }
  return byName;
}

function binSecOf(series) {
  return (series.binMs ?? 5000) / 1000;
}
function dpsAtSec(series, sec) {
  const i = Math.floor(sec / binSecOf(series));
  return series.points[i]?.dps ?? 0;
}
function avgDps(series) {
  if (!series.points?.length) return 0;
  return series.points.reduce((s, p) => s + p.dps, 0) / series.points.length;
}

/**
 * Cooldowns whose casts are followed by elevated DPS — the run's actual burst
 * enablers. Returns Set of ability names (Army of the Dead, Dark
 * Transformation, Death and Decay, …), never defensives/interrupts.
 */
function burstCooldownNames(detail, series) {
  const avg = avgDps(series) || 1;
  const binSec = binSecOf(series);
  const nAfter = Math.max(1, Math.round(LIFT_WINDOW_SEC / binSec));
  const names = new Set();
  for (const [name, times] of cooldownCastTimes(detail)) {
    let liftSum = 0;
    for (const t of times) {
      let s = 0;
      for (let k = 0; k < nAfter; k++) s += dpsAtSec(series, t + k * binSec);
      liftSum += s / nAfter / avg;
    }
    if (times.length && liftSum / times.length >= MIN_LIFT_RATIO) names.add(name);
  }
  return names;
}

function isLocalPeak(points, i) {
  return points[i].dps >= (points[i - 1]?.dps ?? 0) && points[i].dps >= (points[i + 1]?.dps ?? 0);
}

/**
 * @returns {{ headline:string, spikes:object[], culprits:{name,missed}[] } | null}
 */
export function analyzeSpikes({ mineDetail, otherDetail, mineSeries, otherSeries }) {
  if (!mineSeries?.points?.length || !otherSeries?.points?.length) return null;

  const theirBurst = burstCooldownNames(otherDetail, otherSeries);
  const theirCasts = cooldownCastTimes(otherDetail);
  const myCasts = cooldownCastTimes(mineDetail);
  const binSec = binSecOf(otherSeries);

  const myByT = new Map(mineSeries.points.map((p) => [p.tSec, p.dps]));
  const gaps = otherSeries.points.map((p, i) => ({
    i,
    tSec: p.tSec,
    theirDps: p.dps,
    myDps: myByT.get(p.tSec) ?? 0,
    gap: p.dps - (myByT.get(p.tSec) ?? 0),
  }));

  // candidate spikes: theirs is a local peak and meaningfully ahead of mine
  const peaks = gaps
    .filter((g) => g.gap > 0 && isLocalPeak(otherSeries.points, g.i))
    .sort((a, b) => b.gap - a.gap);

  // keep the biggest, non-overlapping ones
  const chosen = [];
  for (const p of peaks) {
    if (chosen.some((c) => Math.abs(c.tSec - p.tSec) < MERGE_SEC)) continue;
    chosen.push(p);
    if (chosen.length >= MAX_SPIKES) break;
  }
  chosen.sort((a, b) => a.tSec - b.tSec);

  const inWindow = (times, tSec) => times.filter((t) => t >= tSec - LOOKBACK_SEC && t <= tSec + binSec);
  const missedCount = new Map();

  const spikes = chosen.map((sp) => {
    const theirsHere = [...theirBurst].filter((n) => inWindow(theirCasts.get(n) ?? [], sp.tSec).length);
    const mineHere = [...theirBurst].filter((n) => inWindow(myCasts.get(n) ?? [], sp.tSec).length);
    const missing = theirsHere.filter((n) => !mineHere.includes(n));
    for (const n of missing) missedCount.set(n, (missedCount.get(n) ?? 0) + 1);

    let note;
    if (missing.length) {
      note = `They fired ${listOf(missing)} into this pull; you didn't — that's the burst you're missing here.`;
    } else if (theirsHere.length && mineHere.length) {
      note = `You used the same cooldowns (${listOf(mineHere)}) but got less out of them — likely fewer targets hit or lower Festering stacks going in.`;
    } else {
      note = `No burst cooldown either side — this gap is target count / uptime, not a missed cooldown.`;
    }
    return {
      tSec: sp.tSec,
      atLabel: fmt(sp.tSec),
      theirDps: Math.round(sp.theirDps),
      myDps: Math.round(sp.myDps),
      gapDps: Math.round(sp.gap),
      theirCooldowns: theirsHere,
      myCooldowns: mineHere,
      missing,
      note,
    };
  });

  const culprits = [...missedCount.entries()]
    .map(([name, missed]) => ({ name, missed }))
    .sort((a, b) => b.missed - a.missed);

  const headline = culprits.length
    ? `Their damage spikes are burst windows built on ${listOf([...theirBurst].slice(0, 3))}. ` +
      `Across the ${spikes.length} biggest spikes you were missing ${listOf(culprits.slice(0, 3).map((c) => c.name))} — ` +
      `you weren't bursting on those pulls.`
    : theirBurst.size
      ? `Their spikes come from ${listOf([...theirBurst].slice(0, 3))}; you generally fired the same cooldowns, ` +
        `so the spike gap is target count / uptime rather than missed burst.`
      : `No clear burst-cooldown pattern separates the two runs' spikes.`;

  return { headline, spikes, culprits };
}

function listOf(arr) {
  if (!arr.length) return 'nothing';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')} and ${arr.at(-1)}`;
}
function fmt(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}
