// Narrative summary, synthesized entirely from numbers already computed
// elsewhere in this file (gaps, timeline, honesty split). Nothing here comes
// from trained "correct rotation" knowledge — every claim traces back to a
// measured diff, so it survives patches the same way the rest of the tool does.
//
// Deliberately does not call out specific death timestamps or "go rewatch
// this pull" instructions — dying is already obvious to the player without a
// timestamp attached; the useful signal is the aggregate comparison (death
// count, idle%) against the cohort, not a pointer to the moment itself.

export function buildSummary({ headline, gaps, honesty }) {
  if (!gaps.length) {
    return {
      text: `No significant rotational gaps found for ${headline.dungeon} — this run tracks the cohort closely on every metric measured here.`,
      nextSteps: {
        recap: 'No measurable gaps found in this run.',
        actions: ['Queue with confidence — nothing measured here stands out against the cohort. Re-run this analysis on your next attempt to keep checking.'],
      },
    };
  }

  const sentences = [];
  const top = gaps[0];
  sentences.push(`The ${headline.dpsGapPct}% DPS gap in ${headline.dungeon} is led by ${describeGap(top)}.`);

  const rest = gaps.slice(1, 4).filter((g) => g.category !== top.category);
  if (rest.length) sentences.push(`After that: ${rest.map(describeGap).join('; ')}.`);

  sentences.push(
    `Rotational metrics (deaths, downtime, cast rate, ability/uptime diffs) account for an estimated ` +
      `${honesty.explainedPct}% of the DPS gap; the rest is routing, pull size, comp and funnel, which this report can't see.`
  );

  sentences.push(
    `Runic Power overcapping is measured directly from WCL's own resource events; individual Rune tracking ` +
      `isn't reliably exposed by the API and isn't included. Everything else above is cast-count and uptime based.`
  );

  return { text: sentences.join(' '), nextSteps: buildNextSteps({ headline, gaps, honesty }) };
}

/**
 * Final "what to do next attempt" checklist. Reuses the same gap.advice
 * sentences already shown above (no new claims), ordered by severity — the
 * one thing to read right before queuing the key again.
 */
function buildNextSteps({ headline, gaps, honesty }) {
  const actions = gaps.slice(0, 5).map((g) => g.advice);
  if (!actions.length) {
    actions.push('No further action needed — this run already tracks the cohort closely on every metric measured here.');
  }

  const recap =
    `${gaps.length} measurable gap${gaps.length === 1 ? '' : 's'} found in this run` +
    (headline.dpsGapPct != null
      ? `, together estimated to explain ~${honesty.explainedPct}% of the ${headline.dpsGapPct}% DPS gap vs the +${headline.cohortLevel} cohort.`
      : '.');

  return { recap, actions };
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
    case 'waste':
      return `Runic Power wasted to overcapping (${g.mine} vs ${g.cohort})`;
    default:
      return g.title;
  }
}
