// Assemble the comparison bundle for one dungeon: my run at (or closest to) a
// requested key level, vs ONE other player at that same level.
//
// This used to fetch full detail for a 5-7 player "cohort" and take the median of
// everything. That was expensive (~7 API calls per player) and, worse, dishonest:
// the moment you picked someone from the dropdown the cohort narrowed to that one
// player, so every "cohort median" silently became that single player's number
// while still being labelled a median.
//
// Every section of the report compares against one player, so we fetch one player.
// The ranked page (one cheap, cached call) gives the whole dropdown; only the
// SELECTED opponent's run is ever pulled in full.
import { fetchMyEncounterRuns, fetchTopRuns, fetchRunDetail } from './api.js';
import { summarizeAtLevel, summarizeBestLevel } from '../parse/encounterRankings.js';
import { dumpDebug } from './client.js';

export const DEFAULT_LEVEL = 20;

const TOP_N = 10; // top players of the class/spec shown in the dropdown
const SIMILAR_N = 5; // …plus this many parses closest to my own run

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @param {number} [p.level] absolute keystone level to compare at (default 20).
 *   Both sides try to match it exactly, falling back to whichever level each
 *   player actually has logged that's closest.
 * @param {string} [p.compareTo] player name to compare against. When omitted, the
 *   closest-duration parse is picked (a similar route means the DPS gap is more
 *   purely execution).
 */
export async function buildComparison({
  name,
  serverSlug,
  serverRegion,
  zoneID,
  encounterID,
  className = 'DeathKnight',
  specName = 'Unholy',
  level = DEFAULT_LEVEL,
  compareTo = null,
  refresh = false,
}) {
  const myRuns = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID, specName, refresh });
  const summary = summarizeAtLevel(myRuns, level);
  if (!summary.bestRun?.report?.code) {
    throw new Error(`No logged run near +${level} found for encounter ${encounterID}`);
  }
  const targetLevel = summary.keyLevel;
  // the site's real "Best %" for this dungeon — highest level with logged runs,
  // which may be a harder key than the one being compared here. Percentile is
  // bracket-relative, so this is NOT necessarily higher than the level-locked
  // number above, but it's what actually gates invites.
  const overallSummary = summarizeBestLevel(myRuns);

  const mineDetail = await fetchRunDetail({
    code: summary.bestRun.report.code,
    fightID: summary.bestRun.report.fightID,
    playerName: name,
    server: serverSlug, // disambiguate if the log has two same-named toons
    className,
    includeBuffSources: true,
  });

  // One cheap, cached call. Everything in the dropdown comes from here; no run
  // detail is fetched for anyone except the one finally selected.
  const top = await fetchTopRuns({ encounterID, zoneID, keyLevel: targetLevel, className, specName, refresh });
  const ranked = top.entries.filter((e) => e.name && e.report?.code && e.report?.fightID != null);
  if (!ranked.length) {
    throw new Error(`No ranked runs found for encounter ${encounterID} at +${targetLevel}`);
  }

  const mineFight = mineDetail.fight;
  const myDurationMs = mineFight.keystoneTime ?? mineFight.endTime - mineFight.startTime;

  const withMatch = ranked.map((e, i) => ({
    name: e.name,
    dps: e.dps,
    durationMs: e.durationMs,
    keyLevel: e.keyLevel,
    report: e.report,
    rank: i + 1,
    matchPct: matchPercent(e.durationMs, myDurationMs),
  }));

  // Two groups for the picker: the best players of the spec, and the runs whose
  // route most resembles mine (similar duration => similar pull count, so the DPS
  // gap is more purely execution and less "they skipped half the dungeon").
  const topPlayers = withMatch.slice(0, TOP_N);
  const topNames = new Set(topPlayers.map((p) => norm(p.name)));
  const similarPlayers = withMatch
    .filter((p) => !topNames.has(norm(p.name)))
    .sort((a, b) => b.matchPct - a.matchPct)
    .slice(0, SIMILAR_N);

  // Default opponent: the closest route to mine, out of everyone ranked.
  let selected = [...withMatch].sort((a, b) => b.matchPct - a.matchPct)[0];

  if (compareTo) {
    // Never substitute silently. This used to fall back to the closest-route
    // player when the requested one wasn't on the ranked page for this key level,
    // so you could pick one player and be shown another's casts — and then
    // reasonably conclude their cooldowns "weren't showing".
    const found = withMatch.find((p) => norm(p.name) === norm(compareTo));
    if (!found) {
      dumpDebug('compareTo-not-ranked', { compareTo, encounterID, targetLevel });
      const err = new Error(
        `${compareTo} has no ranked +${targetLevel} run on this dungeon, so there's nothing to compare against. ` +
          `Pick someone from the list.`
      );
      err.status = 400;
      throw err;
    }
    selected = found;
  }

  const otherDetail = await fetchRunDetail({
    code: selected.report.code,
    fightID: selected.report.fightID,
    playerName: selected.name,
  });

  // My own (rankPercent, dps) pairs at exactly this key level — percentile is
  // bracket-relative, so mixing levels would corrupt any DPS<->percentile read.
  // Used to project "how much DPS to reach the next parse tier" from real logged
  // data instead of guessing a population curve WCL never exposes.
  const historyAtLevel = myRuns.runs
    .filter((r) => r.keyLevel === targetLevel && typeof r.dps === 'number' && typeof r.rankPercent === 'number')
    .map((r) => ({ rankPercent: r.rankPercent, dps: r.dps }));

  return {
    generatedAt: new Date().toISOString(),
    params: { name, serverSlug, serverRegion, zoneID, encounterID, className, specName, level },
    targetLevel,
    mine: {
      meta: {
        ...summary.bestRun,
        bestPercent: summary.bestPercent,
        medianPercent: summary.medianPercent,
        runsAtLevel: summary.runsAtLevel,
        overallBestPercent: overallSummary.bestPercent,
        overallBestLevel: overallSummary.keyLevel,
      },
      detail: mineDetail,
      historyAtLevel,
    },
    // the ONE player every section is measured against
    other: { meta: selected, detail: otherDetail },
    // the picker
    players: { top: topPlayers, similar: similarPlayers, selected: selected.name },
  };
}

/** Route-similarity % from fight-duration closeness (rankings are all same level). */
function matchPercent(dur, myMs) {
  if (typeof dur !== 'number' || typeof myMs !== 'number' || myMs <= 0) return 0;
  return Math.round(100 * Math.max(0, 1 - Math.abs(dur - myMs) / myMs));
}
