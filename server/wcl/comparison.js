// Assemble the full comparison bundle for one dungeon:
// my run at (or closest to) a requested key level, vs the live top-5 WCL
// ranking at that level plus two fixed named reference players.
import { fetchMyEncounterRuns, fetchTopRuns, fetchRunDetail } from './api.js';
import { summarizeAtLevel, summarizeBestLevel, pickLevel } from '../parse/encounterRankings.js';
import { dumpDebug } from './client.js';

export const DEFAULT_LEVEL = 20;

// Fixed reference players (user-specified, not algorithm-picked). Always
// present in the cohort — pulled in as extras only when they're NOT
// already one of the top 5, so the cohort is 5 (both already there), 6
// (one already there) or 7 (neither there).
const NAMED_PLAYERS = [
  { label: 'CN top', name: '小雨煲煲', serverSlug: '格瑞姆巴托', serverRegion: 'CN' },
  { label: 'EU top', name: 'Waalpen', serverSlug: 'ragnaros', serverRegion: 'EU' },
];

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * @param {object} p
 * @param {number} [p.level] absolute keystone level to compare at (default 20).
 *   Both "mine" and the cohort try to match this exactly, falling back to
 *   whichever level each player actually has logged that's closest to it.
 * @param {string} [p.compareTo] player name — if given, the cohort is
 *   narrowed to just that one player after fetching, so every downstream
 *   stat (gaps, tables, timeline) becomes a focused 1:1 comparison instead
 *   of a median across the whole cohort.
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
  const myRuns = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID, refresh });
  const summary = summarizeAtLevel(myRuns, level);
  if (!summary.bestRun?.report?.code) {
    throw new Error(`No logged run near +${level} found for encounter ${encounterID}`);
  }
  const targetLevel = summary.keyLevel;
  // the site's real "Best %" for this dungeon — highest level with logged
  // runs, which may be a harder key than the one being compared here.
  // Percentile is bracket-relative, so this is NOT necessarily higher than
  // the level-locked summary above, but it's what actually gates invites and
  // must never be silently outranked by a lower-bracket number.
  const overallSummary = summarizeBestLevel(myRuns);

  const mineDetail = await fetchRunDetail({
    code: summary.bestRun.report.code,
    fightID: summary.bestRun.report.fightID,
    playerName: name,
    includeBuffSources: true,
  });

  const top = await fetchTopRuns({ encounterID, zoneID, keyLevel: targetLevel, className, specName, refresh });
  const top5 = top.entries.filter((e) => e.name && e.report?.code && e.report?.fightID != null).slice(0, 5);

  const rankedNames = new Set(top5.map((e) => norm(e.name)));
  const missingNamed = NAMED_PLAYERS.filter((p) => !rankedNames.has(norm(p.name)));

  const cohort = [];
  top5.forEach((entry, i) => {
    cohort.push({ entry, label: namedLabelFor(entry.name) ?? `Rank ${i + 1}` });
  });
  for (const p of missingNamed) cohort.push({ named: p, label: p.label });

  const results = [];
  for (const c of cohort) {
    try {
      const { meta, detail } = c.entry
        ? await fetchRankedPlayerRun(c.entry)
        : await fetchNamedPlayerRun({ ...c.named, encounterID, targetLevel, refresh });
      results.push({ meta, detail, label: c.label });
    } catch (err) {
      dumpDebug('cohort-run-skipped', { candidate: c, error: String(err) });
    }
  }
  if (!results.length) {
    throw new Error(`No usable comparison runs fetched for encounter ${encounterID} at +${targetLevel}`);
  }

  // "Parses similar to yours" (mirrors WCL's parse-search): the same ranked
  // page, minus the runs already in the base cohort, ranked by how close the
  // fight duration is to mine (≈ similar route). No detail fetched here —
  // these are dropdown options; a run's detail is pulled only when selected.
  const mineFight = mineDetail.fight;
  const myDurationMs = mineFight.keystoneTime ?? mineFight.endTime - mineFight.startTime;
  const cohortNameSet = new Set(results.map((r) => norm(r.meta.name)));
  const similarCandidates = top.entries
    .filter((e) => e.name && e.report?.code && e.report?.fightID != null && !cohortNameSet.has(norm(e.name)))
    .map((e) => ({
      name: e.name,
      dps: e.dps,
      durationMs: e.durationMs,
      keyLevel: e.keyLevel,
      report: e.report,
      matchPct: matchPercent(e.durationMs, myDurationMs),
    }))
    .sort((a, b) => b.matchPct - a.matchPct)
    .slice(0, 8);

  let finalCohort = results;
  if (compareTo) {
    const inCohort = results.filter((r) => norm(r.meta.name) === norm(compareTo));
    if (inCohort.length) {
      finalCohort = inCohort;
    } else {
      // a "similar parse" outside the base cohort — fetch just that one run now
      const cand = top.entries.find((e) => norm(e.name) === norm(compareTo) && e.report?.code);
      if (!cand) {
        throw new Error(`${compareTo} is not among the ranked runs for this dungeon/level`);
      }
      const { meta, detail } = await fetchRankedPlayerRun(cand);
      finalCohort = [{ meta, detail, label: 'Similar parse' }];
    }
  }

  // My own (rankPercent, dps) pairs at exactly this key level — percentile is
  // bracket-relative, so mixing levels would corrupt any DPS<->percentile
  // read. Used to project "how much DPS to reach the next parse tier" from
  // real logged data instead of guessing a population curve WCL never gives us.
  const historyAtLevel = myRuns.runs
    .filter((r) => r.keyLevel === targetLevel && typeof r.dps === 'number' && typeof r.rankPercent === 'number')
    .map((r) => ({ rankPercent: r.rankPercent, dps: r.dps }));

  return {
    generatedAt: new Date().toISOString(),
    params: { name, serverSlug, serverRegion, zoneID, encounterID, className, specName, level },
    targetLevel,
    compareTo,
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
    cohort: finalCohort,
    similarCandidates,
  };
}

/** Route-similarity % from fight-duration closeness (rankings are all same level). */
function matchPercent(dur, myMs) {
  if (typeof dur !== 'number' || typeof myMs !== 'number' || myMs <= 0) return 0;
  return Math.round(100 * Math.max(0, 1 - Math.abs(dur - myMs) / myMs));
}

function namedLabelFor(name) {
  const hit = NAMED_PLAYERS.find((p) => norm(p.name) === norm(name));
  return hit ? hit.label : null;
}

async function fetchRankedPlayerRun(entry) {
  const detail = await fetchRunDetail({ code: entry.report.code, fightID: entry.report.fightID, playerName: entry.name });
  return { meta: entry, detail };
}

/** Fetch a specific named player's run closest to targetLevel on this encounter. */
async function fetchNamedPlayerRun({ name, serverSlug, serverRegion, encounterID, targetLevel, refresh = false }) {
  const { runs } = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID, refresh });
  const withReport = runs.filter((r) => r.report?.code && r.report?.fightID != null);
  if (!withReport.length) throw new Error(`No usable run for ${name} on encounter ${encounterID}`);
  const pickedLevel = pickLevel(withReport, targetLevel);
  const pick = withReport
    .filter((r) => r.keyLevel === pickedLevel)
    .sort((a, b) => (b.rankPercent ?? 0) - (a.rankPercent ?? 0))[0];

  const meta = {
    name,
    keyLevel: pick.keyLevel,
    dps: pick.dps,
    durationMs: pick.durationMs,
    score: pick.score,
    medal: pick.medal,
    affixes: pick.affixes,
    report: pick.report,
  };
  const detail = await fetchRunDetail({ code: pick.report.code, fightID: pick.report.fightID, playerName: name });
  return { meta, detail };
}
