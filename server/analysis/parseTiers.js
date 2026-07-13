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
export function fitLine(points) {
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
 * @param {number} p.myBestPercent percentile at the level being compared here (bracket-locked)
 * @param {number} [p.overallBestPercent] the site's real "Best %" for this dungeon — highest
 *   level with any logged run, which may be a harder key than the one being compared. Never
 *   show a tier as a "target" if this already clears it, even if the level-locked percentile
 *   above hasn't (different brackets aren't comparable, but the site only shows one number).
 * @param {number} [p.overallBestLevel] the key level that overallBestPercent came from
 * @param {number} p.myDps
 * @param {{rankPercent:number, dps:number}[]} p.history my own logged runs at this exact key level
 * @param {object[]} p.gaps ranked gaps (compare.js shape: {title, severity, ...})
 * @param {number} p.honestyExplainedPct
 */
export function buildParsePlan({ myBestPercent, overallBestPercent, overallBestLevel, myDps, history, gaps, honestyExplainedPct, topParse = null }) {
  let points = (history ?? []).filter(
    (h) => typeof h.rankPercent === 'number' && typeof h.dps === 'number'
  );

  // With only one logged run at this level there is nothing to fit a line
  // through, and the tool used to just give up. But a SECOND real point is
  // already in hand: the #1 ranked parse of your spec at this exact key level,
  // which sits at ~the 100th percentile by definition. Your run plus the top run
  // is a line.
  //
  // It's a crude one — two points, and it assumes DPS rises linearly with
  // percentile between them, which it doesn't (the curve steepens near the top).
  // So it's marked `twoPoint` and the text says as much. A rough target beats no
  // target, as long as nobody is told it's precise.
  let twoPoint = false;
  if (points.length < 2 && topParse?.dps > 0 && typeof myBestPercent === 'number' && myDps > 0) {
    const topPercent = 100;
    if (topParse.dps > myDps && topPercent > myBestPercent) {
      points = [
        { rankPercent: myBestPercent, dps: myDps },
        { rankPercent: topPercent, dps: topParse.dps },
      ];
      twoPoint = true;
    }
  }

  const distinctPercents = new Set(points.map((p) => p.rankPercent)).size;

  // floor = whichever is higher: this level's own percentile, or the site's
  // real overall best (possibly from a harder key) — a lower-bracket number
  // must never claim a tier the player has already reached elsewhere
  const floor = Math.max(myBestPercent ?? 0, overallBestPercent ?? 0);
  const outrankedByOverall = (overallBestPercent ?? 0) > (myBestPercent ?? 0);

  const currentTier = tierFor(floor);
  const nextTiers = TIERS.filter((t) => t.min > floor).slice(0, MAX_TIERS_SHOWN);

  const overallNote = {
    overallBestPercent: typeof overallBestPercent === 'number' ? Math.round(overallBestPercent * 10) / 10 : null,
    overallBestLevel: overallBestLevel ?? null,
    outrankedByOverall,
  };

  if (!nextTiers.length) {
    return { currentTier: currentTier?.name ?? null, historyCount: points.length, insufficientData: false, atTopTier: true, tiers: [], twoPoint, ...overallNote };
  }
  if (distinctPercents < MIN_POINTS) {
    return { currentTier: currentTier?.name ?? null, historyCount: points.length, insufficientData: true, atTopTier: false, tiers: [], twoPoint, ...overallNote };
  }

  const { a, b } = fitLine(points);
  const minObserved = Math.min(...points.map((p) => p.rankPercent));
  const maxObserved = Math.max(...points.map((p) => p.rankPercent));

  // A non-positive slope means "more DPS ranks you lower", which is not a thing —
  // the points are too few or too noisy to carry a real relationship.
  if (!(b > 0)) {
    return { currentTier: currentTier?.name ?? null, historyCount: points.length, insufficientData: true, fitUnreliable: true, atTopTier: false, tiers: [], twoPoint, ...overallNote };
  }

  const sortedGaps = [...(gaps ?? [])].sort((x, y) => y.severity - x.severity);
  const totalGapSeverity = sortedGaps.reduce((s, g) => s + g.severity, 0);

  const tiers = nextTiers.map((tier) => {
    // Price each tier off the fitted SLOPE (what one percentile point costs in
    // DPS) but ANCHOR it at the run in front of you, not at the line's
    // noise-fitted intercept. Without the anchor the line can put a HIGHER tier
    // BELOW your current DPS — i.e. tell you to do less damage to rank up.
    const dpsDelta = b * (tier.min - floor);
    const estDps = myDps + dpsDelta;
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
    twoPoint,
    tiers,
    ...overallNote,
  };
}

const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Render buildParsePlan()'s output into one readable paragraph. */
export function describeParsePlan(plan) {
  if (!plan) return null;

  const overallPrefix = plan.outrankedByOverall
    ? `Your real Best % for this dungeon is already ${plan.overallBestPercent}% (at +${plan.overallBestLevel}) — ` +
      `higher than this level's own percentile, so tiers already covered by that aren't shown as targets here. `
    : '';

  if (plan.atTopTier) {
    return `${overallPrefix}Already at the top tier (pink) for this comparison — nothing higher to target here.`;
  }
  if (plan.insufficientData) {
    return (
      `${overallPrefix}Only ${plan.historyCount} of your own logged run${plan.historyCount === 1 ? '' : 's'} at this exact key level ` +
      `— not enough to fit a DPS-to-percentile line (need at least 2 at different percentiles). Log a few more runs ` +
      `at this level for a real number here; in the meantime use the DPS gap above the "compared against" line as ` +
      `your rough target.`
    );
  }

  // Two-point mode: your single run + the #1 parse at this level. Real data, but
  // a straight line between two points can't know the curve steepens near the top,
  // so say that plainly rather than dressing it up as a fit.
  if (plan.twoPoint) {
    const lines = plan.tiers.map((t) => {
      const sign = t.dpsDelta >= 0 ? '+' : '';
      return `${CAP(t.tier)} (${t.threshold}%+): about ${sign}${t.pctDeltaNeeded}% more DPS (~${sign}${(t.dpsDelta / 1000).toFixed(1)}k).`;
    });
    return (
      `${overallPrefix}You only have one logged run at this key level, so there's no line to fit through your own history. ` +
      `Instead this is drawn between two REAL points: your run, and the #1 ranked parse of your spec at this exact level. ` +
      `${lines.join(' ')} ` +
      `Straight line between two points — the real curve steepens near the top, so the high tiers are likely understated. ` +
      `Log another run at this level and it gets fitted properly.`
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
  return overallPrefix + lines.join(' ');
}
