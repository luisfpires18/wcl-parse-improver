// Assemble the full comparison bundle for one dungeon:
// my best run detail + a small, specific comparison set — rank 1 in the
// live WCL rankings, plus two named reference players (fixed, not
// algorithm-picked) — deduped so the same person never counts twice.
import { fetchMyEncounterRuns, fetchTopRuns, fetchRunDetail } from './api.js';
import { summarizeBestLevel } from '../parse/encounterRankings.js';
import { dumpDebug } from './client.js';

// Fixed reference players (user-specified, not algorithm-picked). Compared
// against on every dungeon regardless of the generic rank-1 result, so the
// cohort is always these two (or fewer, if one happens to BE rank 1) plus
// whichever rank-1 player is distinct from both.
const NAMED_PLAYERS = [
  { label: 'CN top', name: '小雨煲煲', serverSlug: '格瑞姆巴托', serverRegion: 'CN' },
  { label: 'EU top', name: 'Waalpen', serverSlug: 'ragnaros', serverRegion: 'EU' },
];

/**
 * @param {object} p
 * @param {number} [p.levelOffset] 0 = same key level as my best run, 1/2 = higher brackets
 */
export async function buildComparison({
  name,
  serverSlug,
  serverRegion,
  zoneID,
  encounterID,
  className = 'DeathKnight',
  specName = 'Unholy',
  levelOffset = 0,
}) {
  const myRuns = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID });
  const summary = summarizeBestLevel(myRuns);
  if (!summary.bestRun?.report?.code) {
    throw new Error(`No logged best run with report found for encounter ${encounterID}`);
  }
  const targetLevel = summary.keyLevel + levelOffset;

  const mineDetail = await fetchRunDetail({
    code: summary.bestRun.report.code,
    fightID: summary.bestRun.report.fightID,
    playerName: name,
    includeBuffSources: true,
  });

  const top = await fetchTopRuns({ encounterID, zoneID, keyLevel: targetLevel, className, specName });
  const rank1 = top.entries.find((e) => e.name && e.report?.code && e.report?.fightID != null);

  const candidates = [];
  if (rank1) candidates.push({ label: 'Rank 1', name: rank1.name, fromRankings: rank1 });
  for (const p of NAMED_PLAYERS) candidates.push(p);

  // dedupe by name — if rank 1 IS one of the named players, only fetch once
  const deduped = [];
  const seenNames = new Set();
  for (const c of candidates) {
    const key = c.name.trim().toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    deduped.push(c);
  }

  const cohort = [];
  for (const c of deduped) {
    try {
      const { meta, detail } = c.fromRankings
        ? await fetchRankedPlayerRun(c.fromRankings)
        : await fetchNamedPlayerRun({ ...c, encounterID, targetLevel });
      cohort.push({ meta, detail, label: c.label });
    } catch (err) {
      dumpDebug('cohort-run-skipped', { candidate: c, error: String(err) });
    }
  }
  if (!cohort.length) {
    throw new Error(`No usable comparison runs fetched for encounter ${encounterID} at +${targetLevel}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    params: { name, serverSlug, serverRegion, zoneID, encounterID, className, specName, levelOffset },
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

async function fetchRankedPlayerRun(entry) {
  const detail = await fetchRunDetail({ code: entry.report.code, fightID: entry.report.fightID, playerName: entry.name });
  return { meta: entry, detail };
}

/** Fetch a specific named player's best available run on this encounter, matched to targetLevel where possible. */
async function fetchNamedPlayerRun({ name, serverSlug, serverRegion, encounterID, targetLevel }) {
  const { runs } = await fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID });
  const pick = pickComparableRun(runs, targetLevel);
  if (!pick?.report?.code) {
    throw new Error(`No usable run for ${name} on encounter ${encounterID}`);
  }
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

/**
 * Prefer a run at the exact target level (best parse among those). If they
 * never logged that level, pick whichever level they DID log that's
 * closest to it — not their highest ever (a player who only pushes +23s
 * has no +21 logged at all; their closest comparable run is a +22, not
 * their hardest +24).
 */
function pickComparableRun(runs, targetLevel) {
  if (!runs?.length) return null;
  const withReport = runs.filter((r) => r.report?.code && r.report?.fightID != null);
  if (!withReport.length) return null;
  const atLevel = withReport.filter((r) => r.keyLevel === targetLevel);
  if (atLevel.length) return atLevel.sort((a, b) => (b.rankPercent ?? 0) - (a.rankPercent ?? 0))[0];
  return [...withReport].sort((a, b) => {
    const da = Math.abs((a.keyLevel ?? 0) - targetLevel);
    const db = Math.abs((b.keyLevel ?? 0) - targetLevel);
    return da - db || (b.keyLevel ?? 0) - (a.keyLevel ?? 0); // ties favor the harder key
  })[0];
}
