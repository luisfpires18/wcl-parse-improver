// Translate ranked rotational gaps into a concrete DPS/percentile target for
// the next WCL parse color tier(s) — "exactly what do I need to hit blue/
// purple/orange". Tier thresholds match the WCL site convention exactly
// (same breakpoints as public/app.js's pctClass()) — a fixed site
// convention, not a guess.
//
// The DPS<->percentile relationship is estimated ONLY from the player's own
// logged runs at this exact key level (percentile is bracket-relative, so
// mixing levels would corrupt it) — never from a population-wide curve WCL
// doesn't expose. With fewer than 2 distinct data points there's nothing to
// fit a line through, so this says so plainly instead of inventing a number.
export const TIERS = [
  { name: 'gray', min: 0 },
  { name: 'green', min: 25 },
  { name: 'blue', min: 50 },
  { name: 'purple', min: 75 },
  { name: 'orange', min: 95 },
  { name: 'pink', min: 99 },
];

const MIN_POINTS = 2;
const MAX_TIERS_SHOWN = 3;

export function tierFor(pct) {
  if (typeof pct !== 'number') return null;
  let t = TIERS[0];
  for (const tier of TIERS) if (pct >= tier.min) t = tier;
  return t;
}

/** Least-squares line dps = a + b*rankPercent over {rankPercent, dps} points. */
function fitLine(points) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.rankPercent, 0) / n;
  const meanY = points.reduce((s, p) => s + p.dps, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.rankPercent - meanX) * (p.dps - meanY);
    den += (p.rankPercent - meanX) ** 2;
  }
  const b = den ? num / den : 0;
  const a = meanY - b * meanX;
  return { a, b };
}

/**
 * @param {object} p
 * @param {number} p.myBestPercent
 * @param {number} p.myDps
 * @param {{rankPercent:number, dps:number}[]} p.history my own logged runs at this exact key level
 * @param {object[]} p.gaps ranked gaps (compare.js shape: {title, severity, ...})
 * @param {number} p.honestyExplainedPct
 */
export function buildParsePlan({ myBestPercent, myDps, history, gaps, honestyExplainedPct }) {
  const points = (history ?? []).filter(
    (h) => typeof h.rankPercent === 'number' && typeof h.dps === 'number'
  );
  const distinctPercents = new Set(points.map((p) => p.rankPercent)).size;

  const currentTier = tierFor(myBestPercent);
  const nextTiers = TIERS.filter((t) => t.min > (myBestPercent ?? 0)).slice(0, MAX_TIERS_SHOWN);

  if (!nextTiers.length) {
    return { currentTier: currentTier?.name ?? null, historyCount: points.length, insufficientData: false, atTopTier: true, tiers: [] };
  }
  if (distinctPercents < MIN_POINTS) {
    return { currentTier: currentTier?.name ?? null, historyCount: points.length, insufficientData: true, atTopTier: false, tiers: [] };
  }

  const { a, b } = fitLine(points);
  const minObserved = Math.min(...points.map((p) => p.rankPercent));
  const maxObserved = Math.max(...points.map((p) => p.rankPercent));

  const sortedGaps = [...(gaps ?? [])].sort((x, y) => y.severity - x.severity);
  const totalGapSeverity = sortedGaps.reduce((s, g) => s + g.severity, 0);

  const tiers = nextTiers.map((tier) => {
    const estDps = a + b * tier.min;
    const dpsDelta = estDps - myDps;
    const pctDeltaNeeded = myDps ? (100 * dpsDelta) / myDps : null;
    const extrapolated = tier.min < minObserved || tier.min > maxObserved;

    let cumulative = 0;
    const coveringGaps = [];
    for (const g of sortedGaps) {
      if (pctDeltaNeeded != null && cumulative >= pctDeltaNeeded) break;
      cumulative += g.severity;
      coveringGaps.push(g.title);
    }
    const fullyCoveredByFlaggedGaps = pctDeltaNeeded != null && cumulative >= pctDeltaNeeded;

    return {
      tier: tier.name,
      threshold: tier.min,
      estDps: Math.round(estDps),
      dpsDelta: Math.round(dpsDelta),
      pctDeltaNeeded: pctDeltaNeeded != null ? Math.round(pctDeltaNeeded * 10) / 10 : null,
      extrapolated,
      coveringGaps,
      fullyCoveredByFlaggedGaps,
      cappedByHonesty: !fullyCoveredByFlaggedGaps && honestyExplainedPct != null && honestyExplainedPct < 95 && cumulative >= totalGapSeverity,
    };
  });

  return {
    currentTier: currentTier?.name ?? null,
    historyCount: points.length,
    insufficientData: false,
    atTopTier: false,
    regression: { minObserved, maxObserved, n: distinctPercents },
    tiers,
  };
}

const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Render buildParsePlan()'s output into one readable paragraph. */
export function describeParsePlan(plan) {
  if (!plan) return null;
  if (plan.atTopTier) {
    return `Already at the top tier (pink) for this comparison level — nothing higher to target here.`;
  }
  if (plan.insufficientData) {
    return (
      `Only ${plan.historyCount} of your own logged run${plan.historyCount === 1 ? '' : 's'} at this exact key level ` +
      `— not enough to fit a DPS-to-percentile line (need at least 2 at different percentiles). Log a few more runs ` +
      `at this level for a real number here; in the meantime use the DPS gap above the "compared against" line as ` +
      `your rough target.`
    );
  }

  const lines = plan.tiers.map((t) => {
    const conf = t.extrapolated
      ? ` (projected from only ${plan.historyCount} of your own logs at this level, none right at ${t.threshold}% — treat as a rough estimate, not exact)`
      : ` (interpolated from your own logs at this level)`;
    let coverage;
    if (!t.coveringGaps.length) {
      coverage = `None of today's flagged gaps add up to this much — it likely needs more than a rotation fix (gear, comp, routing).`;
    } else if (t.fullyCoveredByFlaggedGaps) {
      coverage = `Closing ${t.coveringGaps.join(', ')} should be enough on its own.`;
    } else {
      coverage = `Closing ${t.coveringGaps.join(', ')} gets you part way there — the rest is routing/comp/gear this analysis can't see.`;
    }
    const sign = t.dpsDelta >= 0 ? '+' : '';
    return (
      `${CAP(t.tier)} (${t.threshold}%+): need about ${sign}${t.pctDeltaNeeded}% more DPS (~${sign}${(t.dpsDelta / 1000).toFixed(1)}k)` +
      `${conf}. ${coverage}`
    );
  });
  return lines.join(' ');
}
