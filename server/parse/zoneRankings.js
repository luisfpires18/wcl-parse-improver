// Parse the zoneRankings JSON scalar into a per-dungeon overview.
// The scalar's shape is not covered by the GraphQL schema, so treat every
// field as optional. On a fundamentally unexpected shape, dump the payload
// to debug/ and return what we can.
import { dumpDebug } from '../wcl/client.js';

/**
 * @param {object} zoneRankings raw zoneRankings scalar from the API
 * @returns {{ overall: object, dungeons: object[] }}
 */
export function parseZoneRankings(zoneRankings) {
  if (!zoneRankings || typeof zoneRankings !== 'object') {
    dumpDebug('zoneRankings-not-object', { zoneRankings });
    return { overall: {}, dungeons: [] };
  }

  const rankings = Array.isArray(zoneRankings.rankings) ? zoneRankings.rankings : null;
  if (!rankings) {
    dumpDebug('zoneRankings-no-rankings-array', zoneRankings);
    return { overall: overallOf(zoneRankings), dungeons: [] };
  }

  const dungeons = rankings
    .map((r) => parseRanking(r))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { overall: overallOf(zoneRankings), dungeons };
}

function overallOf(z) {
  return {
    bestPerformanceAverage: numOrNull(z.bestPerformanceAverage),
    medianPerformanceAverage: numOrNull(z.medianPerformanceAverage),
    // allStars points/rank if present (array per partition/spec)
    allStars: Array.isArray(z.allStars) ? z.allStars : undefined,
  };
}

function parseRanking(r) {
  if (!r || typeof r !== 'object') return null;
  const encounter = r.encounter ?? {};
  return {
    encounterID: encounter.id ?? null,
    name: encounter.name ?? '(unknown dungeon)',
    // For M+ zones bracketData carries the keystone level of the best run.
    keyLevel: numOrNull(r.bracketData),
    bestPercent: numOrNull(r.rankPercent),
    medianPercent: numOrNull(r.medianPercent),
    runs: numOrNull(r.totalKills),
    bestAmount: numOrNull(r.bestAmount),
    // fastestKill is in ms when present
    fastestKillMs: numOrNull(r.fastestKill),
    medal: r.medal ?? null,
    spec: r.spec ?? null,
    report: r.report
      ? { code: r.report.code ?? null, fightID: r.report.fightID ?? null }
      : null,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Format ms as m:ss for display. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
