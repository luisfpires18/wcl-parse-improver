// One concrete sentence per gap. Advice is derived from the data diff only —
// no hardcoded patch-specific rotation claims. Death advice deliberately
// skips timestamps/"go rewatch this" — dying is already obvious to the
// player; the useful part is the comparison to the cohort's death count.
export function adviceFor(gapItem) {
  switch (gapItem.category) {
    case 'deaths':
      return (
        `You died ${gapItem.mine}× this run vs the cohort's ${gapItem.cohort} — each death costs roughly ` +
        `20-30s of downtime (dead + running back), which also drags down your idle% and CPM below.`
      );
    case 'downtime':
      return (
        `You were idle ${gapItem.mine}% of the run vs their ${gapItem.cohort}% — close the biggest gaps ` +
        `(see downtime windows): always be casting something while moving between pulls.`
      );
    case 'cpm':
      return (
        `You averaged ${gapItem.mine} casts/min vs their ${gapItem.cohort} — that is pure GCD throughput; ` +
        `fewer rotation pauses and earlier pre-positioning close most of this.`
      );
    case 'ability':
      return (
        `Top players cast ${gapItem.name} at ${gapItem.cohort} vs your ${gapItem.mine}` +
        (gapItem.damageSharePct ? ` and it carries ~${gapItem.damageSharePct}% of their damage` : '') +
        `; press it closer to on-cooldown / weave it more often.`
      );
    case 'uptime':
      return (
        `Their median ${gapItem.name} uptime is ${gapItem.cohort} vs your ${gapItem.mine} ` +
        `(measured only while actively playing, idle/death windows excluded) — a genuine buff-management ` +
        `gap, not a downtime artifact; keep it rolling.`
      );
    case 'waste':
      return (
        `You lost ${gapItem.mine} of your potential Runic Power to overcapping (~${gapItem.wastedAmount} RP over the run) ` +
        `vs their ${gapItem.cohort} — spend Runic Power before it caps rather than holding it for a "better" moment; ` +
        `every point wasted is a Death Coil or Epidemic you didn't get to cast.`
      );
    case 'spender':
      return (
        `Your RP-spender mix differs notably from the cohort (${gapItem.mine} Epidemic share vs their ${gapItem.cohort}) — ` +
        `check whether you are choosing the right spender for the pull sizes in this dungeon.`
      );
    default:
      return '';
  }
}
