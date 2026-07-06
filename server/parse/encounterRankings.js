// Parse the encounterRankings JSON scalar: every logged run of a character
// on one encounter, with per-bracket parse percentiles and report pointers.
// Shape verified against fixtures/encounterRankings-pit.json.
import { dumpDebug } from '../wcl/client.js';

export function parseEncounterRankings(scalar) {
  if (!scalar || typeof scalar !== 'object') {
    dumpDebug('encounterRankings-not-object', { scalar });
    return { totalKills: null, runs: [] };
  }
  const ranks = Array.isArray(scalar.ranks) ? scalar.ranks : [];
  if (!Array.isArray(scalar.ranks)) dumpDebug('encounterRankings-no-ranks', scalar);

  const runs = ranks
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      keyLevel: numOrNull(r.bracketData),
      rankPercent: numOrNull(r.rankPercent),
      dps: numOrNull(r.amount),
      durationMs: numOrNull(r.duration),
      startTime: numOrNull(r.startTime),
      score: numOrNull(r.score),
      medal: r.medal ?? null,
      affixes: Array.isArray(r.affixes) ? r.affixes : [],
      report: r.report
        ? { code: r.report.code ?? null, fightID: r.report.fightID ?? null }
        : null,
    }))
    // best runs first: highest key, then highest parse
    .sort((a, b) => (b.keyLevel ?? 0) - (a.keyLevel ?? 0) || (b.rankPercent ?? 0) - (a.rankPercent ?? 0));

  return { totalKills: numOrNull(scalar.totalKills), runs };
}

/**
 * Site-style per-dungeon summary: WCL's character page shows the highest key
 * level with logged runs; Best % / Median % are computed among the runs at
 * that level only. (Verified: Pit +21 single run -> 31/31 like the site.)
 */
export function summarizeBestLevel(parsed) {
  const { runs } = parsed;
  if (!runs.length) return { keyLevel: null, bestPercent: null, medianPercent: null, bestRun: null, runsAtLevel: 0 };
  const keyLevel = runs[0].keyLevel;
  const atLevel = runs.filter((r) => r.keyLevel === keyLevel);
  const pcts = atLevel.map((r) => r.rankPercent).filter((v) => v !== null).sort((a, b) => a - b);
  return {
    keyLevel,
    bestPercent: pcts.length ? pcts[pcts.length - 1] : null,
    medianPercent: median(pcts),
    bestRun: atLevel[0] ?? null,
    runsAtLevel: atLevel.length,
  };
}

export function median(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
