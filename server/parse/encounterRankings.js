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

/**
 * Like summarizeBestLevel but pinned to a specific level — falls back to
 * whichever logged level is numerically closest if that exact level was
 * never played (ties favor the harder key, never the highest ever).
 */
export function summarizeAtLevel(parsed, targetLevel) {
  const withReport = (parsed.runs ?? []).filter((r) => r.report?.code && r.report?.fightID != null);
  if (!withReport.length) {
    return { keyLevel: null, bestPercent: null, medianPercent: null, bestRun: null, runsAtLevel: 0 };
  }
  const keyLevel = pickLevel(withReport, targetLevel);
  const atLevel = withReport.filter((r) => r.keyLevel === keyLevel);
  const pcts = atLevel.map((r) => r.rankPercent).filter((v) => v !== null).sort((a, b) => a - b);
  return {
    keyLevel,
    bestPercent: pcts.length ? pcts[pcts.length - 1] : null,
    medianPercent: median(pcts),
    bestRun: [...atLevel].sort((a, b) => (b.rankPercent ?? 0) - (a.rankPercent ?? 0))[0] ?? null,
    runsAtLevel: atLevel.length,
  };
}

/** Exact level if logged; else the closest logged level (ties favor the harder key). */
export function pickLevel(runs, targetLevel) {
  const levels = [...new Set(runs.map((r) => r.keyLevel).filter((l) => l != null))];
  if (!levels.length) return null;
  if (levels.includes(targetLevel)) return targetLevel;
  levels.sort((a, b) => Math.abs(a - targetLevel) - Math.abs(b - targetLevel) || b - a);
  return levels[0];
}

export function median(sortedNums) {
  if (!sortedNums.length) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
