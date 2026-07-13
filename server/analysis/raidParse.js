// "What did THIS pull parse, and what does the next colour cost?"
//
// The colour tiers (gray/green/blue/purple/orange/pink) and the least-squares
// DPS<->percentile fit are the M+ ones, reused verbatim from parseTiers.js —
// there is exactly one definition of what "blue" means in this project.
//
// The honest part is what a raid pull actually IS:
//
//   * A KILL that Warcraft Logs ranked has a REAL percentile. We match the pull
//     to its ranked entry by report code + fightID and use WCL's own number. No
//     estimate, no modelling.
//
//   * A WIPE has NO parse. Warcraft Logs ranks kills only — a wipe appears in no
//     ranking anywhere, and no amount of cleverness changes that. What we can do
//     is project: given the DPS↔percentile line fitted through your own ranked
//     kills on this boss, where would this pull's rate have landed? That is a
//     projection, it is labelled as one, and it comes with the caveat below.
//
// The caveat that matters: a short wipe's DPS is burst-inflated (it ends inside
// the opener with every cooldown up — see raidProgress.js), so its projected
// parse is flattering. We detect that from the data — comparing the pull's length
// against the length of your actual kills — and say so rather than letting you
// read a fake orange parse off a 30-second pull.
import { TIERS, tierFor, fitLine } from './parseTiers.js';
import { median } from './metrics.js';

const MIN_POINTS = 2; // can't fit a line through one point
const MAX_TIERS_SHOWN = 3;
// A pull much shorter than your real kills never left the opener, so its rate —
// and therefore its projected parse — is inflated.
const SHORT_PULL_FRACTION = 0.5;

/**
 * @param {object} p
 * @param {{rankPercent:number, dps:number, durationMs:number}[]} p.history your
 *   OWN ranked kills on this boss+difficulty (from encounterRankings)
 * @param {number} p.pullDps this pull's DPS, built the same way WCL builds
 *   `amount`: damage over fight duration
 * @param {number|null} p.pullRankPercent WCL's real percentile, when this pull is
 *   itself a ranked kill. Null for a wipe.
 * @param {number|null} p.pullDurationSec
 * @param {boolean} p.isKill
 */
export function buildRaidParse({ history = [], pullDps, pullRankPercent = null, pullDurationSec = null, isKill = false }) {
  const points = history.filter((h) => typeof h.rankPercent === 'number' && typeof h.dps === 'number');
  const distinctPercents = new Set(points.map((p) => p.rankPercent)).size;

  const base = {
    isKill,
    historyCount: points.length,
    ranked: pullRankPercent != null,
    pullDps: pullDps != null ? Math.round(pullDps) : null,
  };

  // Not enough of your own ranked kills to know what DPS a percentile costs on
  // this boss. Say so — don't invent a curve.
  if (distinctPercents < MIN_POINTS) {
    return {
      ...base,
      insufficientData: true,
      currentPercent: pullRankPercent != null ? round1(pullRankPercent) : null,
      currentTier: pullRankPercent != null ? tierFor(pullRankPercent)?.name ?? null : null,
      tiers: [],
      text: describeInsufficient(points.length, pullRankPercent),
    };
  }

  const { a, b } = fitLine(points); // dps = a + b*percentile

  // A non-positive slope means "more DPS ranks you LOWER", which is not a thing.
  // It means the points are too noisy/few to carry a real relationship — so say
  // that, rather than pricing the next colour off a line that runs backwards.
  if (!(b > 0)) {
    return {
      ...base,
      insufficientData: true,
      fitUnreliable: true,
      currentPercent: pullRankPercent != null ? round1(pullRankPercent) : null,
      currentTier: pullRankPercent != null ? tierFor(pullRankPercent)?.name ?? null : null,
      tiers: [],
      text: describeUnreliable(points.length, pullRankPercent),
    };
  }

  // Invert the same line to place a wipe: percentile = (dps - a) / b
  const projected = (pullDps - a) / b;
  const percent = pullRankPercent ?? clamp(projected, 0, 100);

  // Was this pull long enough for its DPS to mean anything? Compare it against
  // the length of your real kills — data, not a magic number.
  const killDurSec = median(points.map((h) => h.durationMs).filter((v) => typeof v === 'number')) / 1000;
  const burstInflated =
    !isKill && pullDurationSec != null && Number.isFinite(killDurSec) && pullDurationSec < SHORT_PULL_FRACTION * killDurSec;

  const currentTier = tierFor(percent);
  const nextTiers = TIERS.filter((t) => t.min > percent).slice(0, MAX_TIERS_SHOWN);

  // Price each tier from the fitted SLOPE (how much DPS one percentile point
  // costs) but ANCHOR it at where this pull actually landed — not at the line's
  // intercept. Anchoring matters: the raw line put "blue (50%)" BELOW a real 48.3%
  // kill's DPS, i.e. it told you to do less damage to rank higher. Anchored, the
  // ladder is always consistent with the pull in front of you and always rises.
  const dpsPerPercent = b;
  const tiers = nextTiers.map((t) => {
    const dpsDelta = dpsPerPercent * (t.min - percent);
    const needDps = pullDps + dpsDelta;
    return {
      tier: t.name,
      threshold: t.min,
      needDps: Math.round(needDps),
      dpsDelta: Math.round(dpsDelta),
      pctDeltaNeeded: pullDps ? round1((100 * dpsDelta) / pullDps) : null,
      // the fit only spans the percentiles you have actually parsed at; beyond
      // that it is a straight-line extrapolation, which is a weaker claim
      extrapolated: t.min > Math.max(...points.map((p) => p.rankPercent)),
    };
  });

  const result = {
    ...base,
    insufficientData: false,
    atTopTier: !nextTiers.length,
    currentPercent: round1(percent),
    currentTier: currentTier?.name ?? null,
    projected: pullRankPercent == null,
    burstInflated,
    killDurationSec: Number.isFinite(killDurSec) ? Math.round(killDurSec) : null,
    pullDurationSec,
    fit: { n: points.length, minPercent: round1(Math.min(...points.map((p) => p.rankPercent))), maxPercent: round1(Math.max(...points.map((p) => p.rankPercent))) },
    tiers,
  };
  result.text = describe(result);
  return result;
}

const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function describeUnreliable(n, rankPercent) {
  const got = rankPercent != null ? `This kill parsed **${round1(rankPercent)}%**. ` : '';
  return (
    `${got}Your ${n} ranked kills on this boss don't line up into a usable DPS-to-percentile relationship ` +
    `(more DPS would have to mean a higher parse, and across these kills it doesn't — too few, too noisy, or gear moved ` +
    `underneath them). Rather than price the next colour off a line that runs backwards, this says nothing. ` +
    `A few more kills at similar gear will fix it.`
  );
}

function describeInsufficient(n, rankPercent) {
  const got = rankPercent != null ? `This pull parsed **${round1(rankPercent)}%**. ` : '';
  return (
    `${got}Only ${n} ranked kill${n === 1 ? '' : 's'} of your own on this boss — not enough to fit a DPS-to-percentile line ` +
    `(need at least 2 at different percentiles). Kill it a couple more times and this turns into a real DPS target per colour.`
  );
}

function describe(p) {
  const parts = [];

  if (p.projected) {
    parts.push(
      `This pull was a wipe, and Warcraft Logs never ranks wipes — so it has no real parse. ` +
        `Projected from the DPS-to-percentile line through your own ${p.fit.n} ranked kills on this boss, ` +
        `its ${fmtK(p.pullDps)} rate would land around **${p.currentPercent}% (${p.currentTier})**.`
    );
    if (p.burstInflated) {
      parts.push(
        `Treat that as flattering: the pull lasted ${p.pullDurationSec}s against ~${p.killDurationSec}s for your actual kills, ` +
          `so it ended inside your opener with every cooldown up. Short pulls always project high.`
      );
    }
  } else {
    parts.push(`This kill parsed **${p.currentPercent}% (${p.currentTier})** at ${fmtK(p.pullDps)} — Warcraft Logs' own number, not an estimate.`);
  }

  if (p.atTopTier) {
    parts.push('Already at the top colour (pink) — nothing above it.');
    return parts.join(' ');
  }

  for (const t of p.tiers) {
    const sign = t.dpsDelta >= 0 ? '+' : '';
    const conf = t.extrapolated
      ? ` (extrapolated — you have never parsed above ${p.fit.maxPercent}% here, so this is the line extended past your own data)`
      : '';
    parts.push(
      `**${CAP(t.tier)} (${t.threshold}%+)**: needs ~${fmtK(t.needDps)} DPS — ${sign}${t.pctDeltaNeeded}% more than this pull (${sign}${fmtK(Math.abs(t.dpsDelta))})${conf}.`
    );
  }
  return parts.join(' ');
}

const fmtK = (v) => (typeof v === 'number' ? `${(Math.abs(v) / 1000).toFixed(1)}k` : '—');
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
