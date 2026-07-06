// Assemble the full comparison bundle for one dungeon:
// my best run detail + top-N same-spec runs at the target keystone level.
import { fetchMyEncounterRuns, fetchTopRuns, fetchRunDetail } from './api.js';
import { summarizeBestLevel } from '../parse/encounterRankings.js';
import { dumpDebug } from './client.js';

/**
 * @param {object} p
 * @param {number} [p.levelOffset] 0 = same key level as my best run, 1/2 = higher brackets
 * @param {number} [p.cohortSize] top-N runs to compare against (default 5)
 */
export async function buildComparison({
  name,
  serverSlug,
  serverRegion,
  zoneID,
  encounterID,
  className = 'DeathKnight',
  specName = 'Unholy',
  cohortSize = 5,
  levelOffset = 0,
}) {
  const myRuns = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID });
  const summary = summarizeBestLevel(myRuns);
  if (!summary.bestRun?.report?.code) {
    throw new Error(`No logged best run with report found for encounter ${encounterID}`);
  }
  const targetLevel = summary.keyLevel + levelOffset;

  const top = await fetchTopRuns({ encounterID, zoneID, keyLevel: targetLevel, className, specName });
  const candidates = top.entries.filter((e) => e.name && e.report?.code && e.report?.fightID != null);

  const mineDetail = await fetchRunDetail({
    code: summary.bestRun.report.code,
    fightID: summary.bestRun.report.fightID,
    playerName: name,
  });

  const cohort = [];
  for (const entry of candidates) {
    if (cohort.length >= cohortSize) break;
    try {
      const detail = await fetchRunDetail({
        code: entry.report.code,
        fightID: entry.report.fightID,
        playerName: entry.name,
      });
      cohort.push({ meta: entry, detail });
    } catch (err) {
      // broken/hidden report — skip to the next candidate
      dumpDebug('cohort-run-skipped', { entry, error: String(err) });
    }
  }
  if (!cohort.length) {
    throw new Error(`No usable top runs fetched for encounter ${encounterID} at +${targetLevel}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    params: { name, serverSlug, serverRegion, zoneID, encounterID, className, specName, cohortSize, levelOffset },
    targetLevel,
    mine: {
      meta: {
        ...summary.bestRun,
        bestPercent: summary.bestPercent,
        medianPercent: summary.medianPercent,
        runsAtLevel: summary.runsAtLevel,
      },
      detail: mineDetail,
    },
    cohort,
  };
}
