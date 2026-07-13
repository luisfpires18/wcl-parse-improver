// Raid progression analysis — works on logs WITHOUT a kill.
//
// A wipe is never in any WCL ranking, so this reads the player's own attempts
// straight from a report and answers the two things that matter on progress:
//   1. Consistency — is your output steady pull to pull, or does it swing?
//   2. Benchmark — how does your steady output compare to a top kill of the
//      same boss+difficulty?
//
// Everything is normalised as ACTIVE DPS = damage ÷ engaged (casting) seconds,
// not raw damage. Raw totals are dominated by how long a pull lasted (a 40s
// wipe vs a 6-minute one), which says nothing about your play. Active DPS is a
// rate, so a short early wipe and a long attempt are directly comparable — and
// it's the same normaliser used to compare a wipe against a full-length kill,
// which is fairer than truncating the kill to the wipe's length (that would pit
// your opening burst against only their opening).
import { computeRunMetrics, median } from './metrics.js';
import { AMPLIFIERS } from './spikes.js';

const EARLY_DEATH_MARGIN_MS = 8000; // dying this far before the raid's median death = "early", not "with the wipe"

// --- burst inflation ---------------------------------------------------------
// Active DPS over a WHOLE pull is biased by how long the pull lasted. Burst
// cooldowns (Army, Dark Transformation, potion, trinkets) are front-loaded: a
// 30-second wipe is spent entirely inside the opener, so every one of them is up
// and none of them ever has to come off cooldown. A 4-minute pull amortises the
// same cooldowns across three droughts of filler. The short pull therefore wins
// on rate every time — not because it was played better, but because it ended
// before the rotation got hard.
//
// Left uncorrected this poisons everything downstream: `best` becomes whatever
// pull died fastest, `swing` inflates from the gap between a burst pull and a
// real one, and the consistency verdict reads "swingy" off an artefact.
//
// So a pull only enters the comparison if it lasted long enough to contain more
// than the opener. The floor is relative to the night's longest pull (never a
// magic constant) with an absolute floor so an all-short-pulls boss still has
// something to compare.
// Burst inflation is a smooth function of pull length, not a cliff, so any cutoff
// is a judgement call. These are tuned to drop pulls that end inside the opener
// (a ~30-60s wipe) while keeping genuine two-minute attempts, which are real
// rotation even if short. The floor is reported to the UI so it's never a secret.
const COMPARABLE_FRACTION = 0.4; // …of the longest pull
const COMPARABLE_MIN_SEC = 90; // absolute floor: below this you never leave the opener

/** Casts-per-minute of the burst amplifiers — the evidence of burst weighting. */
function amplifierCpm(metrics) {
  let cpm = 0;
  for (const [name, a] of metrics.abilities) {
    if (AMPLIFIERS.has(name)) cpm += a.cpm ?? 0;
  }
  return cpm;
}

/**
 * Per-attempt output line from a fight meta + the player's run detail, plus —
 * when the raid's deaths for this pull are supplied — WHEN the player died
 * relative to everyone else. On a wipe the whole raid dies, so a death is only a
 * personal problem if it lands well before the raid's; dying in the cascade is
 * the mechanic/enrage, not the player.
 */
export function attemptOutput(fight, detail, raidDeaths = null) {
  const m = computeRunMetrics(detail);
  const activeSec = (m.activeMs || 0) / 1000;
  const totalDamage = detail?.damage?.totalDamage ?? 0;
  const fightStart = detail?.fight?.startTime ?? fight?.startTime ?? null;
  const durMs = fight?.durationMs ?? m.fightDurMs ?? null;
  const durSec = durMs != null ? durMs / 1000 : null;

  const myDeathMs = m.deaths.map((d) => d.atMs).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b)[0] ?? null;
  const death = classifyDeath(myDeathMs, raidDeaths, fightStart, durMs, Boolean(fight?.kill));

  return {
    fightID: fight?.id ?? detail?.fightID ?? null,
    kill: Boolean(fight?.kill),
    pctRemaining: fight?.pctRemaining ?? null, // boss health % left at wipe (0 = kill)
    durationSec: durSec != null ? Math.round(durSec) : null,
    analysed: true,
    activeDps: activeSec > 0 ? totalDamage / activeSec : 0,
    // whole-fight-span DPS (includes downtime); a short wipe can inflate it, so
    // it sits alongside activeDps rather than driving the verdict.
    fightDps: durSec > 0 ? totalDamage / durSec : 0,
    cpm: m.totalCPM,
    // how hard this pull leaned on burst cooldowns per minute — high on a short
    // pull that never left the opener, low on a long one full of filler
    ampCpm: amplifierCpm(m),
    deaths: m.deaths.length,
    idlePct: m.downtime.idlePct,
    totalDamage,
    deathAtSec: myDeathMs != null ? Math.round(myDeathMs / 1000) : null,
    ...death,
  };
}

/**
 * A pull we know exists but did not pull the detail for. Fight metadata (length,
 * kill, boss % left) is free — it comes with the report's fight list — so EVERY
 * pull of the night is listed and selectable, even when only a sample of them
 * got the per-pull API fetches. Without this a 50-pull night would hide pull #37
 * entirely and you could never ask for it.
 */
function unanalysedRow(fight) {
  return {
    fightID: fight?.id ?? null,
    kill: Boolean(fight?.kill),
    pctRemaining: fight?.pctRemaining ?? null,
    durationSec: fight?.durationMs != null ? Math.round(fight.durationMs / 1000) : null,
    analysed: false,
    activeDps: null,
    fightDps: null,
    cpm: null,
    ampCpm: null,
    deaths: null,
    idlePct: null,
    totalDamage: null,
    deathAtSec: null,
    deathTiming: null,
    diedBeforeRaidSec: null,
    diedNth: null,
    raidDeathCount: null,
  };
}

/**
 * Where a player's death sits in the pull:
 *   'survived'  — no death (or a kill)
 *   'with-wipe' — died in the raid's death cascade (~the wipe; not on the player)
 *   'early'     — died >8s before the raid's median death (real lost uptime)
 * `diedBeforeRaidSec` is how many seconds before the raid median you fell;
 * `diedNth` is your position in the death order (1 = first to die).
 */
function classifyDeath(myDeathMs, raidDeaths, fightStart, durMs, kill) {
  if (myDeathMs == null) return { deathTiming: 'survived', diedBeforeRaidSec: null, diedNth: null, raidDeathCount: null };
  const rels =
    Array.isArray(raidDeaths) && fightStart != null
      ? raidDeaths.map((d) => d.timestamp - fightStart).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b)
      : [];
  if (rels.length >= 2) {
    const raidMedian = median(rels);
    // rank counting myself: how many fell strictly before me, +1. Robust whether
    // or not my own death is present in the raid list (it is, in real data).
    const diedNth = rels.filter((t) => t < myDeathMs).length + 1;
    const beforeMs = raidMedian - myDeathMs;
    return {
      deathTiming: myDeathMs < raidMedian - EARLY_DEATH_MARGIN_MS ? 'early' : 'with-wipe',
      diedBeforeRaidSec: Math.round(beforeMs / 1000),
      diedNth,
      raidDeathCount: rels.length,
    };
  }
  // no raid-death data — fall back to the fight end as the wipe moment
  if (durMs != null) {
    const beforeEndMs = durMs - myDeathMs;
    return { deathTiming: beforeEndMs > 10000 && !kill ? 'early' : 'with-wipe', diedBeforeRaidSec: null, diedNth: null, raidDeathCount: null };
  }
  return { deathTiming: 'with-wipe', diedBeforeRaidSec: null, diedNth: null, raidDeathCount: null };
}

/**
 * @param {object} p
 * @param {{fight:object, detail:object}[]} p.attempts every logged pull (kills + wipes)
 * @param {{name:string, detail:object, difficultyName?:string}|null} [p.benchmark]
 *   a top ranked kill of the same boss+difficulty (kills only — wipes aren't ranked)
 */
export function buildProgression({ attempts = [], allFights = null, benchmark = null } = {}) {
  // Rows cover EVERY pull of the boss, not just the sampled ones we fetched
  // detail for — so any pull of a 50-pull night can be picked and analysed on
  // demand. Unfetched pulls carry their free fight metadata and `analysed:false`.
  const detailById = new Map(attempts.filter((a) => a?.fight?.id != null).map((a) => [a.fight.id, a]));
  const fights = allFights?.length ? allFights : attempts.map((a) => a.fight);
  const rows = fights
    .map((f) => {
      const a = detailById.get(f?.id);
      return a ? attemptOutput(a.fight, a.detail, a.raidDeaths) : unanalysedRow(f);
    })
    .sort((a, b) => (a.fightID ?? 0) - (b.fightID ?? 0));

  // Comparability floor: a pull must be long enough to be more than an opener.
  // Relative to the night's longest pull, so it adapts to the boss rather than
  // hardcoding what "long" means. See the burst-inflation note at the top.
  const longestSec = Math.max(0, ...rows.map((r) => r.durationSec ?? 0));
  const canScore = (r) => Boolean(r.analysed && r.activeDps > 0 && r.durationSec != null);
  const applyFloor = (floor) => {
    for (const r of rows) {
      r.comparable = canScore(r) && r.durationSec >= floor;
      // an analysed pull that's simply too short to judge — its DPS is real, but
      // it's burst-weighted and must not set the bar for the others
      r.burstWeighted = canScore(r) && !r.comparable;
    }
    return rows.filter((r) => r.comparable);
  };

  let floorSec = Math.max(COMPARABLE_MIN_SEC, Math.round(COMPARABLE_FRACTION * longestSec));
  let scored = applyFloor(floorSec);
  // A boss where every pull is short (early prog: the raid dies at 90% every
  // time) would otherwise have NOTHING to compare. Fall back to the relative
  // floor alone so the longer half of a short night can still be read — and say
  // so, because those numbers are shakier.
  let floorRelaxed = false;
  if (scored.length < 2 && rows.filter(canScore).length >= 2) {
    floorSec = Math.round(COMPARABLE_FRACTION * longestSec);
    scored = applyFloor(floorSec);
    floorRelaxed = true;
  }
  const dps = scored.map((r) => r.activeDps);
  const mean = avg(dps);
  const sd = stdev(dps, mean);
  const cvPct = mean ? (100 * sd) / mean : null;
  const best = dps.length ? Math.max(...dps) : null;
  const worst = dps.length ? Math.min(...dps) : null;
  const swingPct = best ? (100 * (best - worst)) / best : null;

  // death timing over scored wipes only (a 10s reset isn't a "death" worth judging)
  const scoredWipes = scored.filter((r) => !r.kill && r.deathTiming !== 'survived');
  const early = scoredWipes.filter((r) => r.deathTiming === 'early');
  const withWipe = scoredWipes.filter((r) => r.deathTiming === 'with-wipe');
  const survivedWipes = scored.filter((r) => !r.kill && r.deathTiming === 'survived').length;
  const deathTiming = {
    scoredWipes: scoredWipes.length,
    earlyDeaths: early.length,
    withWipeDeaths: withWipe.length,
    survivedWipes,
    avgEarlyBySec: round1(avg(early.map((r) => r.diedBeforeRaidSec).filter((v) => v != null))),
    haveRaidData: rows.some((r) => r.raidDeathCount != null),
  };

  // Evidence for the exclusion, measured rather than asserted: the burst pulls
  // really do fire amplifiers at a far higher rate than the long ones.
  const burst = rows.filter((r) => r.burstWeighted);
  const burstNote = burstEvidence(burst, scored, floorSec);

  const consistency = {
    pulls: rows.length, // every pull of the boss
    analysedPulls: rows.filter((r) => r.analysed).length, // …of which these have full metrics
    scoredPulls: dps.length, // …of which these were long enough to compare
    comparableFloorSec: floorSec,
    comparableFloorRelaxed: floorRelaxed,
    burstWeightedPulls: burst.length,
    burstNote,
    killed: rows.some((r) => r.kill),
    bestProgressPctRemaining: minOrNull(rows.map((r) => r.pctRemaining)),
    meanActiveDps: round(mean),
    bestActiveDps: round(best),
    worstActiveDps: round(worst),
    cvPct: round1(cvPct),
    swingPct: round1(swingPct),
    avgDeaths: round1(avg(scored.map((r) => r.deaths))),
    avgIdlePct: round1(avg(scored.map((r) => r.idlePct).filter((v) => v != null))),
    deathTiming,
    verdict: consistencyVerdict(cvPct, dps.length),
  };

  let bench = null;
  if (benchmark?.detail) {
    const b = attemptOutput({ kill: true }, benchmark.detail);
    bench = {
      name: benchmark.name ?? null,
      difficultyName: benchmark.difficultyName ?? null,
      killActiveDps: round(b.activeDps),
      // positive = the kill out-damages you; how far your MEAN and BEST sit below it
      gapToMeanPct: pctGap(b.activeDps, mean),
      gapToBestPct: pctGap(b.activeDps, best),
    };
  }

  return { rows, consistency, benchmark: bench, text: describe(consistency, bench) };
}

/** CV bands: tight play barely moves pull to pull; big swings are the signal. */
function consistencyVerdict(cvPct, n) {
  if (cvPct == null || n < 2) return 'not-enough-data';
  if (cvPct < 6) return 'tight';
  if (cvPct < 12) return 'moderate';
  return 'swingy';
}

function describe(c, bench) {
  const parts = [];
  if (c.scoredPulls < 2) {
    parts.push(
      c.scoredPulls === 1
        ? `Only one pull here is long enough to compare (${c.comparableFloorSec}s+) — need at least two to read output consistency.`
        : `No pull here is long enough to compare (${c.comparableFloorSec}s+); short pulls never leave the opener, so their DPS says nothing about your rotation.`
    );
  } else {
    const swing = c.swingPct != null ? ` (best-to-worst swing ${c.swingPct}%)` : '';
    if (c.verdict === 'tight') {
      parts.push(`Your active DPS is steady across ${c.scoredPulls} pulls${swing} — output is not your problem here; the wipes are mechanics/positioning, not damage.`);
    } else if (c.verdict === 'moderate') {
      parts.push(`Your active DPS varies a fair amount across ${c.scoredPulls} pulls${swing} — some pulls you play clean, some you don't. Chasing the worst pulls up to your best is free progress.`);
    } else {
      parts.push(`Your active DPS swings a lot pull to pull${swing} — your best pull shows the ceiling; the low ones are dragging the raid's DPS check. Consistency, not peak, is the fix.`);
    }
    parts.push(deathSentence(c.deathTiming));
  }
  if (c.burstNote) parts.push(c.burstNote);
  if (c.comparableFloorRelaxed) {
    parts.push(
      `Every pull on this boss is short, so the bar was lowered to ${c.comparableFloorSec}s just to have something to compare — treat these numbers as rough.`
    );
  }
  if (bench) {
    if (bench.gapToBestPct != null && bench.gapToBestPct <= 3) {
      parts.push(`Your best pull already matches ${bench.name}'s ${bench.difficultyName ?? ''} kill output — you have the damage to clear; make the mean pull look like your best.`);
    } else if (bench.gapToMeanPct != null) {
      parts.push(`Benchmark: ${bench.name}'s kill runs ~${bench.killActiveDps.toLocaleString()} active DPS; you're ${bench.gapToMeanPct}% under it on your mean pull, ${bench.gapToBestPct}% on your best.`);
    }
  }
  return parts.join(' ');
}

/**
 * Prove the burst inflation from the pulls themselves rather than asserting it:
 * compare the amplifier cast rate of the excluded short pulls against the long
 * ones. If the short pulls really are all-opener, their amp CPM is much higher.
 */
function burstEvidence(burst, scored, floorSec) {
  if (!burst.length) return null;
  const burstAmp = median(burst.map((r) => r.ampCpm).filter((v) => v != null));
  const longAmp = median(scored.map((r) => r.ampCpm).filter((v) => v != null));
  const ids = burst.map((r) => `#${r.fightID}`).join(', ');
  const rate =
    burstAmp != null && longAmp != null && longAmp > 0
      ? ` They fire burst cooldowns at ${round1(burstAmp)}/min against ${round1(longAmp)}/min on your long pulls — they never leave the opener, so their DPS is inflated by definition.`
      : '';
  return (
    `${burst.length} pull${burst.length === 1 ? '' : 's'} (${ids}) ended under ${floorSec}s and ${burst.length === 1 ? 'is' : 'are'} excluded from the numbers above.${rate}`
  );
}

/** Death-timing sentence — the "you die every wipe" nuance: early vs with the raid. */
function deathSentence(dt) {
  if (!dt || dt.scoredWipes === 0) return '';
  if (dt.earlyDeaths === 0) {
    return dt.haveRaidData
      ? `On every wipe you went down with the raid, not before it — your deaths are the mechanic/enrage, not your play.`
      : `You died on the wipes but no earlier than the pull ended — deaths look like the wipe itself, not a personal mistake.`;
  }
  const early = dt.avgEarlyBySec != null ? ` (~${dt.avgEarlyBySec}s before the raid)` : '';
  const rest = dt.withWipeDeaths > 0 ? ` The other ${dt.withWipeDeaths} you went down with the raid — those aren't on you.` : '';
  return `On ${dt.earlyDeaths} of ${dt.scoredWipes} wipes you died EARLY${early} — that's real lost uptime and DPS you can win back.${rest}`;
}

const pctGap = (ref, mine) => (ref && mine != null ? round1((100 * (ref - mine)) / ref) : null);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function stdev(a, mean) {
  if (!a.length || mean == null) return 0;
  return Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
}
const minOrNull = (a) => {
  const nums = a.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.min(...nums) : null;
};
const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
