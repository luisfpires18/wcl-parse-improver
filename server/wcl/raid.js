// Assemble a raid progression report for one boss in one report — works whether
// or not the boss was killed. Wipes come straight from the report's fight list
// (no ranking has them); an optional benchmark is the top ranked kill of the
// same boss+difficulty. Parallels comparison.js for M+.
import {
  fetchReportFights,
  fetchRunDetail,
  fetchRaidBenchmark,
  fetchRaidRankings,
  fetchFightDeaths,
  fetchBossHealth,
  fetchDamageSeries,
  fetchMyEncounterRuns,
} from './api.js';
import { openerConsensus, cooldownUsage } from '../analysis/rotationConsensus.js';
import { buildProgression, attemptOutput } from '../analysis/raidProgress.js';
import { buildRaidParse } from '../analysis/raidParse.js';
import { rotationComposition, castOrder } from '../analysis/spikes.js';
import { buildAbilityTable, buildGaps } from '../analysis/compare.js';
import { buildConsumables } from '../analysis/consumables.js';
import { compareResource } from '../analysis/resources.js';
import { buildTimeline } from '../analysis/timeline.js';
import { truncateDetail, truncateSeries, truncatePoints } from '../analysis/truncate.js';
import { groupByEncounter, difficultyName } from '../parse/reportFights.js';
import { timeAtHealthPct } from '../parse/bossHealth.js';
import { assertCharacterInLog } from './logIdentity.js';
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
  classLabel = null,
  compareTo = null,
  refresh = false,
}) {
  code = reportCode(code);
  const report = await fetchReportFights({ code, encounterID, refresh });
  const fight = report.fights.find((f) => f.id === fightID);
  if (!fight) throw new Error(`Report ${code} has no fight ${fightID} on that boss`);

  // Before spending a single heavy call: is this log even the right character?
  // Analysing a Havoc log against an Unholy benchmark produces a full report in
  // which every number is meaningless, and nothing would say so.
  await assertCharacterInLog({ code, fightID, name, className, specName, classLabel, refresh });

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

  const bench = await fetchRaidBenchmark({ encounterID, className, specName, difficulty, compareTo, refresh });

  // The opponent picker: top 10 of the spec on this boss, plus the 5 kills whose
  // LENGTH most resembles this pull (a similar-length fight means a similar number
  // of cooldown cycles, so the comparison is more purely execution). Costs nothing
  // extra — the ranked page was already fetched to find the benchmark.
  const myDurMs = fight.durationMs ?? 0;
  const matchPct = (d) => (typeof d === 'number' && myDurMs > 0 ? Math.round(100 * Math.max(0, 1 - Math.abs(d - myDurMs) / myDurMs)) : 0);
  const ranked = (bench.entries ?? []).map((e, i) => ({
    name: e.name,
    dps: e.dps,
    durationMs: e.durationMs,
    rank: i + 1,
    matchPct: matchPct(e.durationMs),
  }));
  const top = ranked.slice(0, 10);
  const topNames = new Set(top.map((p) => p.name.toLowerCase()));
  const players = {
    top,
    similar: ranked
      .filter((p) => !topNames.has(p.name.toLowerCase()))
      .sort((a, b) => b.matchPct - a.matchPct)
      .slice(0, 5),
    selected: bench.name,
  };
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

  const rotation = rotationComposition(mineDetail, otherDetail);
  const myDps = output.fightDps;
  const theirDps = benchOutput.fightDps;

  // The SAME eight sections the M+ report has, from the same builders — a raid
  // pull was previously missing consumables, gaps and resource management
  // entirely, and had no opponent picker at all.
  return {
    // shared eight-section view model (see analysis/compare.js buildReport)
    headline: {
      title: fight.name,
      subtitle: `${difficultyName(difficulty)} · pull #${fight.id}${fight.kill ? ' (kill)' : ` (wipe at ${fight.pctRemaining}%)`}`,
      myDps: Math.round(myDps),
      theirDps: Math.round(theirDps),
      dpsGapPct: theirDps ? Math.round((1000 * (theirDps - myDps)) / theirDps) / 10 : null,
      otherLabel: bench.name,
    },
    compare: { ...players, level: difficulty },
    castOrder: { mine: castOrder(mineDetail), them: castOrder(otherDetail) },
    timeline,
    rotationMatch: { spellMixPct: rotation.similarityPct, castOrderPct: rotation.sequencePct },
    consumables: buildConsumables(mineDetail, otherDetail, bench.name, buffSources),
    parse,
    gaps: buildGaps(mineDetail, otherDetail, buffSources),
    resources: compareResource(mineDetail.resourceEvents ?? [], otherDetail.resourceEvents ?? []),
    // The per-ability DAMAGE half is a whole-fight aggregate — WCL gives no
    // per-window per-ability damage without replaying the event stream. On a
    // truncated (wipe) comparison it would pit your partial pull against their
    // FULL kill's damage, so it is omitted there rather than shown wrong. Cast
    // counts carry the same signal and ARE window-correct.
    abilities: cutoffSec == null ? buildAbilityTable(mineDetail, otherDetail, bench.name) : null,
    abilitiesOmittedReason:
      cutoffSec == null
        ? null
        : "Per-ability damage totals only exist for the whole fight, so they can't be cut to this window without comparing your partial pull against their full kill.",

    // --- raid-only extras ---
    code,
    fightID,
    pull: { id: fight.id, kill: fight.kill, pctRemaining: fight.pctRemaining, durationMs: fight.durationMs },
    output, // this pull's active DPS / CPM / deaths / death timing
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
  };
}

/**
 * Analyse a raid boss WITHOUT a pasted log: resolve the character's own best
 * ranked kill on it, then run the normal pull analysis on that fight.
 *
 * This is what the raid view should have defaulted to all along. Pasting a report
 * URL is still needed for the one thing rankings cannot show — a WIPE — but you
 * shouldn't have to go hunting for a URL just to look at a boss you killed.
 */
export async function buildRaidBossReport({
  encounterID,
  difficulty = DEFAULT_RAID_DIFFICULTY,
  name,
  serverSlug,
  serverRegion,
  className,
  specName,
  classLabel = null,
  compareTo = null,
  refresh = false,
}) {
  // byBracket:false — a raid bracket is item level (see the note in api.js)
  const runs = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID, specName, byBracket: false, refresh });
  const kills = (runs.runs ?? []).filter((r) => r.report?.code && r.report?.fightID != null);
  if (!kills.length) {
    throw new Error(`No ranked kill of that boss logged for ${name} — paste a report to analyse a wipe instead.`);
  }
  // your best parse on the boss is the one worth looking at
  const best = [...kills].sort((a, b) => (b.rankPercent ?? 0) - (a.rankPercent ?? 0))[0];

  return buildRaidPull({
    code: best.report.code,
    fightID: best.report.fightID,
    encounterID,
    difficulty,
    name,
    serverSlug,
    serverRegion,
    className,
    specName,
    classLabel,
    compareTo,
    refresh,
  });
}

/**
 * "How is this boss played by this spec" — the rotations of the top N ranked
 * players, and nothing else.
 *
 * Deliberately NOT a comparison: there is no "you" here, no gaps, no parse. You
 * don't need a log, a kill, or even the character to have pulled the boss. It
 * exists to be read before you go in.
 *
 * Cost: the ranked page is one cached call; each player is a castsOnly detail
 * (~5 requests — no deaths, no resource stream). Ten players is roughly a
 * comparison report's worth of API, and every one of them is cached afterwards.
 */
export async function buildBossRotations({
  encounterID,
  difficulty = DEFAULT_RAID_DIFFICULTY,
  className,
  specName,
  topN = 10,
  refresh = false,
}) {
  const entries = await fetchRaidRankings({ encounterID, className, specName, difficulty, refresh });

  // One row per player: the same name can hold several ranked kills, and ten
  // copies of one player's rotation is not ten players' rotations.
  const seen = new Set();
  const picked = [];
  for (const e of entries) {
    const key = String(e.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(e);
    if (picked.length >= topN) break;
  }

  const players = [];
  const skipped = [];
  for (const [i, e] of picked.entries()) {
    try {
      const detail = await fetchRunDetail({
        code: e.report.code,
        fightID: e.report.fightID,
        playerName: e.name,
        castsOnly: true,
      });
      const order = castOrder(detail);
      const durationSec = Math.max(1, Math.round((detail.fight.endTime - detail.fight.startTime) / 1000));
      players.push({
        rank: i + 1,
        name: e.name,
        dps: Math.round(e.dps ?? 0),
        durationSec,
        cpm: Math.round((10 * 60 * order.length) / durationSec) / 10,
        report: e.report,
        boss: detail.fight.name ?? null,
        castOrder: order,
      });
    } catch (err) {
      // A ranked entry whose report was deleted or made private is a dead link.
      // Say which player dropped out rather than quietly showing eight of ten.
      dumpDebug('boss-rotation-skipped', { encounterID, name: e.name, error: String(err) });
      skipped.push({ name: e.name, reason: err?.message ?? String(err) });
    }
  }
  if (!players.length) {
    throw new Error(`Could not read a rotation from any ranked ${specName} kill of that boss.`);
  }

  return {
    encounterID,
    difficulty,
    difficultyName: difficultyName(difficulty),
    className,
    specName,
    boss: players.find((p) => p.boss)?.boss ?? null,
    players,
    opener: openerConsensus(players.map((p) => p.castOrder)),
    cooldowns: cooldownUsage(players),
    skipped,
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
  classLabel = null,
  benchmark = true,
  refresh = false,
  maxAttempts = 24,
}) {
  code = reportCode(code);
  const report = await fetchReportFights({ code, encounterID, refresh });

  // Reject the wrong log at the FIRST step — when the boss menu is built — rather
  // than letting someone pick a boss and a pull before finding out. Checked on any
  // fight in the report; the roster is the same throughout.
  const anyFight = report.fights[0];
  if (anyFight) {
    await assertCharacterInLog({ code, fightID: anyFight.id, name, className, specName, classLabel, refresh });
  }

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
