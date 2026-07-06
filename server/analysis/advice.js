// One concrete sentence per gap. Advice is derived from the data diff only —
// no hardcoded patch-specific rotation claims.
import { formatDuration } from '../parse/zoneRankings.js';

export function adviceFor(gapItem, bundle) {
  const lvl = bundle.targetLevel;
  switch (gapItem.category) {
    case 'deaths': {
      const times = (gapItem.deathTimes ?? [])
        .filter((t) => t != null)
        .map((t) => formatDuration(t))
        .join(', ');
      return (
        `You died ${gapItem.mine}× (top players: ${gapItem.cohort}) — each death costs the run 20-30s of your uptime` +
        (times ? `; deaths at ${times} into the fight` : '') +
        `. Review those moments first: survivability beats rotation at +${lvl}.`
      );
    }
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
        `Top players get ${gapItem.cohort} of this vs your ${gapItem.mine}` +
        (gapItem.damageSharePct ? ` and it carries ~${gapItem.damageSharePct}% of their damage` : '') +
        `; press it closer to on-cooldown / weave it more often.`
      );
    case 'uptime':
      return `Their median uptime is ${gapItem.cohort} vs your ${gapItem.mine} — keep this effect rolling; the difference is free damage.`;
    case 'spender':
      return (
        `Your RP-spender mix differs notably from the cohort (${gapItem.mine} Epidemic share vs their ${gapItem.cohort}) — ` +
        `check whether you are choosing the right spender for the pull sizes in this dungeon.`
      );
    default:
      return '';
  }
}
