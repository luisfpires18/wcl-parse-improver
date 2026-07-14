// Rotation timeline: WHEN casts, idle windows and deaths happened during the
// fight, for my run vs one comparison run.
//
// Lane selection is frequency-based, never name-based: an ability qualifies
// as a "cooldown lane" purely because it's cast far less often than a GCD
// spender/builder (<= 1.5 casts/min — off-GCD cooldowns are gated by their
// own CD, not the global cooldown). This survives ability reworks across
// patches; nothing here is a hardcoded rotation.
import { computeRunMetrics, IGNORED_ABILITIES } from './metrics.js';
import { selectBuffWindows, sharedBuffLanes } from './buffWindows.js';

const MAX_LANES = 8; // categorical color ceiling
const COOLDOWN_CPM_CEILING = 1.5;

function abilityGuidNameMap(detail) {
  const map = new Map();
  for (const a of detail.casts?.abilities ?? []) map.set(a.guid, a.name);
  return map;
}

function castTimestampsByName(detail) {
  const nameOf = abilityGuidNameMap(detail);
  const byName = new Map();
  for (const ev of detail.castEvents ?? []) {
    const name = nameOf.get(ev.abilityGameID);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(ev.timestamp);
  }
  return byName;
}

function runView(detail, laneNames, buffLaneNames = [], buffWindows = []) {
  const fight = detail.fight ?? {};
  const start = fight.startTime ?? 0;
  const end = fight.endTime ?? start;
  const metrics = computeRunMetrics(detail);
  const events = castTimestampsByName(detail);
  const windowByName = new Map(buffWindows.map((w) => [w.name, w]));

  return {
    label: detail.player?.name ?? '?',
    durationMs: Math.max(0, end - start),
    idleWindows: (metrics.downtime.allWindows ?? []).map((w) => ({
      startMs: w.startAbsMs - start,
      durMs: w.durMs,
    })),
    deaths: (detail.deaths?.deaths ?? [])
      .filter((d) => typeof d.timestamp === 'number')
      .map((d) => ({ atMs: d.timestamp - start })),
    // Buff WINDOWS, drawn as bars — the only view that can see a buff which is
    // never cast (a proc). Empty bands when this run never had the buff, which is
    // itself the finding: they held it, you didn't.
    buffLanes: buffLaneNames.map((name) => ({
      name,
      bands: windowByName.get(name)?.bands ?? [],
    })),
    lanes: laneNames.map((name) => ({
      name,
      casts: (events.get(name) ?? []).map((t) => t - start),
    })),
  };
}

/**
 * Two-run rotation timeline with a shared lane set (same abilities, same
 * order, same color slot in both runs) so the two are visually comparable.
 *
 * `buffSources` (from classifyBuffSources, computed once for "mine") additionally
 * yields shared BUFF lanes — the self-applied, impermanent buffs of each run,
 * drawn as bars. Omit it and the timeline behaves exactly as before.
 */
export function buildTimeline(mineDetail, otherDetail, buffSources = null) {
  const mineMetrics = computeRunMetrics(mineDetail);
  const otherMetrics = computeRunMetrics(otherDetail);

  // A lane must be low-frequency in BOTH runs — an ability that's a spammed
  // filler for one player and a rare cooldown for the other (e.g. a spender
  // cast at a different rate) would otherwise show as a dense smear next to
  // sparse ticks, defeating the point of a cooldown timeline.
  const allNames = new Set([
    ...(mineDetail.casts?.abilities ?? []).map((a) => a.name),
    ...(otherDetail.casts?.abilities ?? []).map((a) => a.name),
  ]);
  const combinedCasts = new Map(); // name -> mine.casts + other.casts, for ranking only
  for (const name of allNames) {
    if (IGNORED_ABILITIES.has(name)) continue;
    const myCpm = mineMetrics.abilities.get(name)?.cpm ?? 0;
    const otherCpm = otherMetrics.abilities.get(name)?.cpm ?? 0;
    const myCasts = mineMetrics.abilities.get(name)?.casts ?? 0;
    const otherCasts = otherMetrics.abilities.get(name)?.casts ?? 0;
    if (myCasts + otherCasts === 0) continue;
    // present-but-zero in one run is fine (e.g. a CD they held); absent-and-
    // spammed in the other is not — only gate on the run(s) that used it
    if (myCasts > 0 && myCpm > COOLDOWN_CPM_CEILING) continue;
    if (otherCasts > 0 && otherCpm > COOLDOWN_CPM_CEILING) continue;
    combinedCasts.set(name, myCasts + otherCasts);
  }
  const laneNames = [...combinedCasts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LANES)
    .map(([name]) => name);

  const mineBuffs = buffSources ? selectBuffWindows(mineDetail, buffSources) : [];
  const otherBuffs = buffSources ? selectBuffWindows(otherDetail, buffSources) : [];
  const buffLaneNames = buffSources ? sharedBuffLanes(mineBuffs, otherBuffs) : [];

  return {
    laneNames,
    buffLaneNames,
    mine: runView(mineDetail, laneNames, buffLaneNames, mineBuffs),
    other: runView(otherDetail, laneNames, buffLaneNames, otherBuffs),
  };
}

function round1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
}
