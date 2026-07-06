// Narrative summary, synthesized entirely from numbers already computed
// elsewhere in this file (gaps, timeline, honesty split). Nothing here comes
// from trained "correct rotation" knowledge — every claim traces back to a
// measured diff, so it survives patches the same way the rest of the tool does.
import { formatDuration } from '../parse/zoneRankings.js';

// idle windows/deaths this close together are treated as one incident on the
// timeline. 45s is deliberately tight: two zero-cast gaps within 45s of each
// other are almost certainly the same wipe-recovery moment (dodge a
// mechanic, run back, resume); looser thresholds (tried up to 90s against
// real data) started chaining unrelated lulls minutes apart into one fake
// "incident" and made the advice ("look at this one pull") false.
const CLUSTER_GAP_MS = 45_000;

export function buildSummary({ headline, gaps, timeline, honesty }) {
  if (!gaps.length) {
    return {
      text: `No significant rotational gaps found for ${headline.dungeon} — this run tracks the cohort closely on every metric measured here.`,
    };
  }

  const sentences = [];
  const top = gaps[0];
  sentences.push(`The ${headline.dpsGapPct}% DPS gap in ${headline.dungeon} is led by ${describeGap(top)}.`);

  const cluster = timeline ? biggestCluster(timeline.mine) : null;
  if (cluster) {
    const totalIdleMs = timeline.mine.idleWindows.reduce((acc, w) => acc + w.durMs, 0);
    const idleShare = totalIdleMs ? round1((100 * cluster.idleMs) / totalIdleMs) : null;
    sentences.push(
      `Most of the lost time is concentrated around ${formatDuration(cluster.startMs)}-${formatDuration(cluster.endMs)}` +
        ` (${cluster.deaths} death${cluster.deaths === 1 ? '' : 's'}, ${(cluster.idleMs / 1000).toFixed(0)}s idle right there` +
        (idleShare ? `, ${idleShare}% of the whole run's downtime` : '') +
        `) — look at what happened on that specific pull before touching anything else.`
    );
  }

  const rest = gaps.slice(1, 4).filter((g) => g.category !== top.category);
  if (rest.length) sentences.push(`After that: ${rest.map(describeGap).join('; ')}.`);

  sentences.push(
    `Rotational metrics (deaths, downtime, cast rate, ability/uptime diffs) account for an estimated ` +
      `${honesty.explainedPct}% of the DPS gap; the rest is routing, pull size, comp and funnel, which this report can't see.`
  );

  sentences.push(
    `This does not analyze rune/Runic Power waste (capped resources, spender timing) — that needs event-level ` +
      `resource data this tool doesn't pull yet (see v2 roadmap). The gaps above are cast-count and uptime based only.`
  );

  return { text: sentences.join(' ') };
}

function describeGap(g) {
  switch (g.category) {
    case 'deaths':
      return `${g.mine} death${g.mine === 1 ? '' : 's'} (cohort ${g.cohort})`;
    case 'downtime':
      return `${g.mine}% idle time vs their ${g.cohort}%`;
    case 'cpm':
      return `total cast rate (${g.mine} vs ${g.cohort} CPM)`;
    case 'ability':
      return `${g.title.replace(' usage', '')} (${g.mine} vs ${g.cohort})`;
    case 'uptime':
      return `${g.title.replace(' (active time)', '')} (${g.mine} vs ${g.cohort})`;
    case 'spender':
      return `RP-spender mix (${g.mine} vs ${g.cohort} Epidemic share)`;
    default:
      return g.title;
  }
}

/** Group idle windows + deaths that occur within CLUSTER_GAP_MS of each other; return the worst cluster. */
function biggestCluster(mineTimeline) {
  const events = [
    ...mineTimeline.idleWindows.map((w) => ({ start: w.startMs, end: w.startMs + w.durMs, idleMs: w.durMs, death: false })),
    ...mineTimeline.deaths.map((d) => ({ start: d.atMs, end: d.atMs, idleMs: 0, death: true })),
  ].sort((a, b) => a.start - b.start);
  if (!events.length) return null;

  const clusters = [];
  let cur = { startMs: events[0].start, endMs: events[0].end, idleMs: events[0].idleMs, deaths: events[0].death ? 1 : 0 };
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (e.start - cur.endMs <= CLUSTER_GAP_MS) {
      cur.endMs = Math.max(cur.endMs, e.end);
      cur.idleMs += e.idleMs;
      cur.deaths += e.death ? 1 : 0;
    } else {
      clusters.push(cur);
      cur = { startMs: e.start, endMs: e.end, idleMs: e.idleMs, deaths: e.death ? 1 : 0 };
    }
  }
  clusters.push(cur);

  const significant = clusters.filter((c) => c.deaths > 0 || c.idleMs > 20000);
  if (!significant.length) return null;
  significant.sort((a, b) => b.idleMs + b.deaths * 20000 - (a.idleMs + a.deaths * 20000));
  return significant[0];
}

function round1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
}
