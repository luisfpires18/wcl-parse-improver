// Rotation timeline: WHEN casts, idle windows and deaths happened during the
// fight, for my run vs one comparison run.
//
// Lane selection is frequency-based, never name-based: an ability qualifies
// as a "cooldown lane" purely because it's cast far less often than a GCD
// spender/builder (<= 1.5 casts/min — off-GCD cooldowns are gated by their
// own CD, not the global cooldown). This survives ability reworks across
// patches; nothing here is a hardcoded rotation.
import { computeRunMetrics, IGNORED_ABILITIES } from './metrics.js';

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

function runView(detail, laneNames) {
  const fight = detail.fight ?? {};
  const start = fight.startTime ?? 0;
  const end = fight.endTime ?? start;
  const metrics = computeRunMetrics(detail);
  const events = castTimestampsByName(detail);

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
    lanes: laneNames.map((name) => ({
      name,
      casts: (events.get(name) ?? []).map((t) => t - start),
    })),
  };
}

/**
 * Two-run rotation timeline with a shared lane set (same abilities, same
 * order, same color slot in both runs) so the two are visually comparable.
 */
export function buildTimeline(mineDetail, otherDetail) {
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

  return {
    laneNames,
    mine: runView(mineDetail, laneNames),
    other: runView(otherDetail, laneNames),
  };
}

const LANE_REL_DIFF_THRESHOLD = 0.35; // 35% fewer/more casts per minute
const LANE_ABS_CPM_THRESHOLD = 0.15; // ignore noise on already-rare cooldowns
const NEVER_USED_OTHER_MIN = 3; // "never used it" only flagged if they used it a meaningful number of times

/**
 * Spot-check the two timeline runs for the kind of gap that's usually a real
 * habit rather than dungeon routing: a cooldown lane you barely touch while
 * they lean on it, or one you never pressed at all. Routing/pull-count
 * differences are real and this can't separate them out — the thresholds
 * are deliberately conservative so only large, repeated gaps surface.
 */
export function analyzeTimeline(timeline) {
  if (!timeline) return null;
  const { mine, other, laneNames } = timeline;

  const laneNotes = [];
  for (const name of laneNames) {
    const mineLane = mine.lanes.find((l) => l.name === name);
    const otherLane = other.lanes.find((l) => l.name === name);
    const mineCount = mineLane?.casts.length ?? 0;
    const otherCount = otherLane?.casts.length ?? 0;
    const mineCpm = mineCount / (mine.durationMs / 60000);
    const otherCpm = otherCount / (other.durationMs / 60000);

    if (mineCount === 0 && otherCount >= NEVER_USED_OTHER_MIN) {
      laneNotes.push({ name, mineCount, otherCount, mineCpm: 0, otherCpm: round1(otherCpm), neverUsed: true });
      continue;
    }
    if (otherCpm <= 0) continue;
    const relDiff = (otherCpm - mineCpm) / otherCpm; // positive = mine behind
    if (Math.abs(relDiff) >= LANE_REL_DIFF_THRESHOLD && Math.abs(otherCpm - mineCpm) >= LANE_ABS_CPM_THRESHOLD) {
      laneNotes.push({
        name,
        mineCount,
        otherCount,
        mineCpm: round1(mineCpm),
        otherCpm: round1(otherCpm),
        relDiffPct: round1(relDiff * 100),
        neverUsed: false,
      });
    }
  }
  laneNotes.sort((a, b) => (b.neverUsed ? 1 : Math.abs(b.relDiffPct ?? 0)) - (a.neverUsed ? 1 : Math.abs(a.relDiffPct ?? 0)));

  const idlePct = (view) => (100 * view.idleWindows.reduce((acc, w) => acc + w.durMs, 0)) / view.durationMs;

  return {
    mineIdlePct: round1(idlePct(mine)),
    otherIdlePct: round1(idlePct(other)),
    mineDeaths: mine.deaths.length,
    otherDeaths: other.deaths.length,
    laneNotes,
  };
}

/** analyzeTimeline() plus a rendered explanation, for the timeline section's info box. */
export function buildTimelineInfo(timeline) {
  const info = analyzeTimeline(timeline);
  if (!info) return null;

  const sentences = [];
  const idleDiff = info.mineIdlePct - info.otherIdlePct;
  if (Math.abs(idleDiff) >= 3) {
    sentences.push(
      idleDiff > 0
        ? `You were idle more of this fight (${info.mineIdlePct}% vs their ${info.otherIdlePct}%) — some of that is ` +
          `routing/pull-count differences between the two runs, but a gap this size is also worth a look.`
        : `You were actually idle less here (${info.mineIdlePct}% vs their ${info.otherIdlePct}%) — nothing wrong on that front.`
    );
  }
  if (info.mineDeaths !== info.otherDeaths) {
    sentences.push(`Deaths on this specific comparison: you ${info.mineDeaths}, them ${info.otherDeaths}.`);
  }

  if (info.laneNotes.length) {
    const parts = info.laneNotes.map((n) =>
      n.neverUsed
        ? `${n.name} (you never cast it this run, they used it ${n.otherCount}×)`
        : `${n.name} (${n.mineCpm} vs their ${n.otherCpm} CPM)`
    );
    sentences.push(
      `Cooldown lanes that stand out beyond normal routing noise: ${parts.join('; ')}. A gap this large in a ` +
        `cooldown-gated ability usually points to a real habit rather than routing — though utility casts ` +
        `(interrupts, grips, positioning) can still legitimately vary by route, so weigh those less.`
    );
  } else {
    sentences.push(
      'No cooldown lane stands out beyond normal routing/pull noise in this comparison — differences here look like route, not habit.'
    );
  }

  return { ...info, text: sentences.join(' ') };
}

function round1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
}
