// Parse the zoneRankings JSON scalar into a per-dungeon overview.
//
// Verified against real payloads (fixtures/zoneRankings-*.json):
// - For M+ zones WCL packs the keystone level into numeric fields with a
//   2e7 multiplier:
//     bestAmount  = keyLevel * 2e7 + realDPS          (dps metric)
//     fastestKill = realDurationMs - keyLevel * 2e7   (negative when packed)
// - metric "playerscore" (default): bestAmount = dungeon score points,
//   totalKills = all counted runs (matches the site's Runs column).
// - metric "dps" + byBracket:true + role:DPS: rankPercent / medianPercent are
//   percentiles among the character's own spec at the same keystone bracket.
// - The scalar has no report{code,fightID}; the best run's report is resolved
//   later via encounterRankings (Stage 2).
//
// Every field is treated as optional; fundamentally unexpected shapes are
// dumped to debug/ instead of crashing.
import { dumpDebug } from '../wcl/client.js';

const LEVEL_PACK = 2e7;

/** Decode a packed dps-metric ranking entry. */
export function decodeRanking(r) {
  const bestAmount = numOrNull(r?.bestAmount);
  const fastestKill = numOrNull(r?.fastestKill);
  let keyLevel = null;
  let dps = null;
  let durationMs = null;

  if (bestAmount !== null && bestAmount > 1e7) {
    keyLevel = Math.round(bestAmount / LEVEL_PACK);
    dps = bestAmount - keyLevel * LEVEL_PACK;
  } else {
    dps = bestAmount;
    keyLevel = numOrNull(r?.bestRank?.ilvl);
  }
  if (fastestKill !== null) {
    durationMs = fastestKill < 0 && keyLevel ? fastestKill + keyLevel * LEVEL_PACK : fastestKill;
    if (durationMs !== null && (durationMs <= 0 || durationMs > 6 * 3600_000)) durationMs = null;
  }
  return { keyLevel, dps, durationMs };
}

/** Parse one zoneRankings scalar into a list of per-dungeon entries. */
export function parseZoneRankings(zoneRankings) {
  if (!zoneRankings || typeof zoneRankings !== 'object') {
    dumpDebug('zoneRankings-not-object', { zoneRankings });
    return { meta: {}, rankings: [] };
  }
  const rankings = Array.isArray(zoneRankings.rankings) ? zoneRankings.rankings : null;
  if (!rankings) {
    dumpDebug('zoneRankings-no-rankings-array', zoneRankings);
    return { meta: metaOf(zoneRankings), rankings: [] };
  }
  return {
    meta: metaOf(zoneRankings),
    rankings: rankings
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        encounterID: r.encounter?.id ?? null,
        name: r.encounter?.name ?? '(unknown dungeon)',
        rankPercent: numOrNull(r.rankPercent),
        medianPercent: numOrNull(r.medianPercent),
        totalKills: numOrNull(r.totalKills),
        bestAmount: numOrNull(r.bestAmount),
        spec: r.spec ?? null,
        allStars: r.allStars && typeof r.allStars === 'object' ? r.allStars : null,
        decoded: decodeRanking(r),
      })),
  };
}

function metaOf(z) {
  return {
    metric: z.metric ?? null,
    partition: z.partition ?? null,
    bestPerformanceAverage: numOrNull(z.bestPerformanceAverage),
    medianPerformanceAverage: numOrNull(z.medianPerformanceAverage),
  };
}

/**
 * Merge a playerscore payload and a dps (byBracket, role DPS) payload into
 * the per-dungeon overview shown to the user.
 */
export function buildOverview(scoreZone, dpsZone) {
  const score = parseZoneRankings(scoreZone);
  const dps = parseZoneRankings(dpsZone);
  const byId = new Map();

  for (const s of score.rankings) {
    byId.set(s.encounterID, {
      encounterID: s.encounterID,
      name: s.name,
      // site "Runs" column matches playerscore totalKills
      runs: s.totalKills,
      points: s.bestAmount,
      scoreRank: numOrNull(s.allStars?.rank),
      keyLevel: null,
      durationMs: null,
      bestDps: null,
      bestPercent: null,
      medianPercent: null,
      loggedRuns: null,
      spec: s.spec,
    });
  }
  for (const d of dps.rankings) {
    const row = byId.get(d.encounterID) ?? {
      encounterID: d.encounterID,
      name: d.name,
      runs: null,
      points: null,
      scoreRank: null,
      spec: d.spec,
    };
    row.keyLevel = d.decoded.keyLevel;
    row.durationMs = d.decoded.durationMs;
    row.bestDps = d.decoded.dps;
    row.bestPercent = d.rankPercent;
    row.medianPercent = d.medianPercent;
    row.loggedRuns = d.totalKills;
    byId.set(d.encounterID, row);
  }

  return {
    overall: {
      bestPerformanceAverage: dps.meta.bestPerformanceAverage,
      medianPerformanceAverage: dps.meta.medianPerformanceAverage,
      scorePoints: sumPoints(scoreZone),
    },
    dungeons: [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
  };
}

function sumPoints(scoreZone) {
  const arr = Array.isArray(scoreZone?.allStars) ? scoreZone.allStars : [];
  const total = arr.reduce((acc, a) => acc + (numOrNull(a?.points) ?? 0), 0);
  return total || null;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Format ms as m:ss for display. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000); // WCL floors, matching the site display
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
