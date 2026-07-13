// Assemble a raid progression report for one boss in one report — works whether
// or not the boss was killed. Wipes come straight from the report's fight list
// (no ranking has them); an optional benchmark is the top ranked kill of the
// same boss+difficulty. Parallels comparison.js for M+.
import {
  fetchReportFights,
  fetchRunDetail,
  fetchRaidBenchmark,
  fetchFightDeaths,
  fetchBossHealth,
  fetchDamageSeries,
  fetchMyEncounterRuns,
} from './api.js';
import { buildProgression, attemptOutput } from '../analysis/raidProgress.js';
import { buildRaidParse } from '../analysis/raidParse.js';
import { rotationComposition, castOrder, analyzeSpikes } from '../analysis/spikes.js';
import { buildDamageDoneTable } from '../analysis/compare.js';
import { buildTimeline, buildTimelineInfo } from '../analysis/timeline.js';
import { truncateDetail, truncateSeries, truncatePoints } from '../analysis/truncate.js';
import { groupByEncounter, difficultyName } from '../parse/reportFights.js';
import { timeAtHealthPct } from '../parse/bossHealth.js';
import { dumpDebug } from './client.js';

export const DEFAULT_RAID_DIFFICULTY = 5; // Mythic

/**
 * One pull, charted against the top parser's kill — the raid equivalent of the
 * M+ DPS chart + rotation timeline.
 *
 * The comparison window is normalised by BOSS HEALTH, not by time. A wipe that
 * ended at 62% boss health is only ever compared against the slice of the kill
 * that took the boss from 100% to 62% — the same chunk of the fight, the same
 * phases, the same amount of boss killed. Comparing a 3-minute wipe against a
 * full 6-minute kill would otherwise pit your opener against their whole fight.
 */
export async function buildRaidPull({
  code,
  encounterID,
  difficulty = DEFAULT_RAID_DIFFICULTY,
  fightID,
  name,
  serverSlug,
  serverRegion,
  className = 'DeathKnight',
  specName = 'Unholy',
  refresh = false,
}) {
  code = reportCode(code);
  const report = await fetchReportFights({ code, encounterID, refresh });
  const fight = report.fights.find((f) => f.id === fightID);
  if (!fight) throw new Error(`Report ${code} has no fight ${fightID} on that boss`);

  // includeBuffSources: classifies each aura as self-applied or external. Needed
  // to draw YOUR buff windows (procs, cooldowns) without dragging in raid buffs.
  // Fetched once for mine and reused for the benchmark — whether a spec can
  // self-apply an aura is a property of the ability, not of one run.
  const mineDetail = await fetchRunDetail({
    code,
    fightID,
    playerName: name,
    server: serverSlug,
    className,
    includeBuffSources: true,
  });
  const mineSeries = await fetchDamageSeries({ code, fightID, playerName: name, server: serverSlug, className });
  const myHealth = await fetchBossHealth({ code, fightID, refresh });

  const bench = await fetchRaidBenchmark({ encounterID, className, specName, difficulty, refresh });
  const otherSeriesFull = await fetchDamageSeries({
    code: bench.detail.code,
    fightID: bench.detail.fightID,
    playerName: bench.name,
  });
  const theirHealth = await fetchBossHealth({ code: bench.detail.code, fightID: bench.detail.fightID, refresh });

  // Where MY pull stopped, in boss health. A kill ends at ~0 and needs no cut.
  const cutoffPct = fight.kill ? 0 : myHealth?.endPct ?? fight.pctRemaining ?? null;
  // …and when THEIR kill reached that same boss health.
  const cutoffSec = cutoffPct != null && cutoffPct > 0.5 && theirHealth ? timeAtHealthPct(theirHealth, cutoffPct) : null;

  const otherDetail = truncateDetail(bench.detail, cutoffSec);
  const otherSeries = truncateSeries(otherSeriesFull, cutoffSec);

  // Self-vs-external aura classification, reused for both runs (same spec).
  // Drives the buff bar lanes on the rotation timeline.
  const buffSources = mineDetail.buffSources ?? {};

  const spikeAnalysis = analyzeSpikes({ mineDetail, otherDetail, mineSeries, otherSeries });
  const timeline = buildTimeline(mineDetail, otherDetail, buffSources);
  if (timeline) timeline.otherRoleLabel = 'top parser';

  // THIS pull's own output — so the verdict can talk about the pull you picked
  // instead of only the night's average. Works for pulls outside the analysed
  // sample too, since we've just fetched this one's detail in full.
  let raidDeaths = null;
  try {
    const byFight = await fetchFightDeaths({ code, fightIDs: [fightID], refresh });
    raidDeaths = byFight.get(fightID) ?? [];
  } catch (err) {
    dumpDebug('raid-pull-deaths-failed', { code, fightID, error: String(err) });
  }
  const output = attemptOutput(fight, mineDetail, raidDeaths);
  // the benchmark's rate over the SAME window, so the gap is apples-to-apples
  const benchOutput = attemptOutput({ kill: true }, otherDetail);

  // Parse colour for THIS pull, and the DPS each next colour costs. The
  // DPS<->percentile line is fitted through the player's OWN ranked kills on this
  // boss — a kill matched to its ranked entry gets WCL's real percentile; a wipe
  // (never ranked, anywhere) gets an explicitly-labelled projection.
  let parse = null;
  try {
    // byBracket:false — a raid bracket is ITEM LEVEL, and each kill sits in a
    // different one as you gear up, so bracketed percentiles are not comparable
    // to each other. We want the plain population percentile.
    const runs = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID, specName, byBracket: false, refresh });
    const history = (runs.runs ?? []).filter((r) => r.rankPercent != null && r.dps != null);
    const rankedSelf = history.find((r) => r.report?.code === code && r.report?.fightID === fightID);
    parse = buildRaidParse({
      history,
      // for a ranked kill use WCL's own amount; otherwise our whole-fight rate,
      // built the same way (damage over fight duration)
      pullDps: rankedSelf?.dps ?? output.fightDps,
      pullRankPercent: rankedSelf?.rankPercent ?? null,
      pullDurationSec: output.durationSec,
      isKill: fight.kill,
    });
  } catch (err) {
    dumpDebug('raid-parse-failed', { code, fightID, encounterID, error: String(err) });
  }

  // Rotation vs the top parser FOR THIS PULL, over the fair boss-health window.
  // Cast counts, spell mix and cast order are all rebuilt from the cast events
  // inside the window, so they're correct on a truncated benchmark.
  const rotation = rotationComposition(mineDetail, otherDetail);
  // each cast carries the buffs that were up when it landed — so the cast-order
  // columns can show "The Hunt [Inertia]" for them and a bare "The Hunt" for you
  rotation.order = { mine: castOrder(mineDetail), them: castOrder(otherDetail) };
  const comparison = {
    against: bench.name,
    difficultyName: bench.difficultyName,
    myPullId: fight.id,
    myPullKill: fight.kill,
    rotation,
    // The DamageDone TABLE is a whole-fight aggregate — WCL gives no per-window
    // per-ability damage without replaying the event stream. So on a truncated
    // (wipe) comparison it would silently pit your partial pull against their
    // FULL kill's damage. Omitted there rather than shown wrong; cast counts
    // above carry the same signal and are window-correct.
    damageDone: cutoffSec == null ? buildDamageDoneTable(mineDetail, otherDetail) : null,
    damageDoneOmittedReason:
      cutoffSec == null ? null : 'Per-ability damage totals only exist for the whole fight, so they cannot be cut to this window without comparing your partial pull against their full kill. Cast counts below are window-correct.',
  };

  return {
    code,
    fightID,
    boss: fight.name,
    difficultyName: difficultyName(difficulty),
    comparison,
    pull: { id: fight.id, kill: fight.kill, pctRemaining: fight.pctRemaining, durationMs: fight.durationMs },
    output, // this pull's active DPS / CPM / deaths / death timing
    parse, // this pull's colour + what the next colours cost
    benchmarkOutput: { name: bench.name, activeDps: benchOutput.activeDps },
    mine: mineSeries,
    other: otherSeries,
    otherLabel: bench.name,
    // the window this comparison is honest over
    window: {
      cutoffPct: cutoffPct != null ? Math.round(cutoffPct * 100) / 100 : null,
      theirCutoffSec: cutoffSec != null ? Math.round(cutoffSec) : null,
      theirFullSec: Math.round((otherSeriesFull.durationMs ?? 0) / 1000),
      truncated: cutoffSec != null,
    },
    bossHealth: { mine: myHealth, them: theirHealth ? { ...theirHealth, points: truncatePoints(theirHealth.points, cutoffSec) } : null },
    spikeAnalysis,
    timeline,
    timelineInfo: buildTimelineInfo(timeline),
  };
}

/** Extract a WCL report code from a raw code or a full report URL. */
export function reportCode(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/reports\/([a-zA-Z0-9]{16})/) || s.match(/^([a-zA-Z0-9]{16})$/);
  return m ? m[1] : s;
}

// Fetching a fight's detail is several API calls, so cap how many attempts we
// pull. The longest pulls carry the most signal (a 10s reset tells us nothing),
// so rank by duration, take the top N, then restore chronological order.
function pickAttempts(fights, max) {
  return [...fights]
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, max)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/**
 * @param {object} p
 * @param {string} p.code report code or URL
 * @param {number} [p.encounterID] boss to analyse; omit to just list the report's bosses
 * @param {number} [p.difficulty] raid difficulty id (default Mythic)
 * @param {boolean} [p.benchmark] fetch the top ranked kill to compare against
 */
export async function buildRaidReport({
  code,
  encounterID = null,
  difficulty = DEFAULT_RAID_DIFFICULTY,
  name,
  serverSlug,
  className = 'DeathKnight',
  specName = 'Unholy',
  benchmark = true,
  refresh = false,
  maxAttempts = 24,
}) {
  code = reportCode(code);
  const report = await fetchReportFights({ code, encounterID, refresh });

  // Boss menu for the whole report (so the UI can offer a picker even before a
  // boss is chosen). Difficulty is NOT filtered here — the menu shows every mode
  // pulled, each as its own row.
  const bosses = groupByEncounter(report.fights).map((g) => ({
    encounterID: g.encounterID,
    name: g.name,
    difficulty: g.difficulty,
    difficultyName: g.difficultyName,
    pulls: g.pulls,
    kills: g.kills,
    bestPctRemaining: g.bestPctRemaining,
  }));

  const base = { code, title: report.title, zone: report.zone, bosses };
  if (!encounterID) return base; // menu-only request

  let attempts = report.fights.filter((f) => f.encounterID === encounterID);
  if (difficulty != null) attempts = attempts.filter((f) => f.difficulty === difficulty);
  if (!attempts.length) {
    throw new Error(
      `No ${difficultyName(difficulty) ?? ''} attempts on that boss in report ${code}. Check the difficulty.`
    );
  }
  const bossName = attempts[0].name;

  const chosen = pickAttempts(attempts, maxAttempts);
  // LITE fetch per pull (tables only, no event pagination) so a whole night's
  // pulls fit in the API budget — the heavy full fetch is reserved for the one
  // pull we compare to a top parser below.
  const fetched = [];
  for (const f of chosen) {
    try {
      const detail = await fetchRunDetail({ code, fightID: f.id, playerName: name, server: serverSlug, className, lite: true });
      fetched.push({ fight: f, detail });
    } catch (err) {
      dumpDebug('raid-attempt-skipped', { code, fightID: f.id, name, error: String(err) });
    }
  }
  if (!fetched.length) {
    throw new Error(`Could not read ${name}'s casts on any attempt in ${code} — is ${name} in this log?`);
  }

  // Whole-raid death cascade for every analysed pull in ONE call — lets us tell
  // "you died early" from "you went down with the raid".
  try {
    const deathsByFight = await fetchFightDeaths({ code, fightIDs: fetched.map((a) => a.fight.id), refresh });
    for (const a of fetched) a.raidDeaths = deathsByFight.get(a.fight.id) ?? [];
  } catch (err) {
    dumpDebug('raid-deaths-failed', { code, error: String(err) });
  }

  let bench = null;
  if (benchmark) {
    try {
      bench = await fetchRaidBenchmark({ encounterID, className, specName, difficulty, refresh });
    } catch (err) {
      dumpDebug('raid-benchmark-failed', { encounterID, difficulty, specName, error: String(err) });
    }
  }

  // `allFights` makes every pull of the boss a row — including ones we didn't
  // fetch detail for — so any of them can be clicked and analysed on demand.
  // The rotation-vs-top-parser comparison is NOT built here: it belongs to a
  // specific pull, and picking one for you would just be a generic answer. It
  // lives in buildRaidPull(), against whichever pull you select.
  const progression = buildProgression({ attempts: fetched, allFights: attempts, benchmark: bench });

  return {
    ...base,
    encounterID,
    difficulty,
    difficultyName: difficultyName(difficulty),
    boss: bossName,
    attemptsFetched: fetched.length,
    attemptsTotal: attempts.length,
    benchmark: bench ? { name: bench.name, difficultyName: bench.difficultyName, dps: bench.dps } : null,
    progression,
  };
}
