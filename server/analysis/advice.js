// One concrete sentence per gap. Advice is derived from the data diff only —
// no hardcoded patch-specific rotation claims. Death advice deliberately
// skips timestamps/"go rewatch this" — dying is already obvious to the
// player; the useful part is the comparison to the cohort's death count.
//
// ABILITY_MECHANIC_NOTE covers two abilities (Graveyard, Necrotic Coil) the
// player flagged as looking like unexplained filler in the cast data.
// Verified via web search (Warcraft Wiki / Method.gg / Maxroll, 2026-07-07),
// not guessed: the Forbidden Knowledge talent transforms Epidemic/Death Coil
// into these for 30s after Army of the Dead. Necrotic Coil genuinely cleaves
// (up to 3 targets at full damage, unlike single-target Death Coil), so
// these are real distinct abilities with their own breakpoints.
const ABILITY_MECHANIC_NOTE = {
  Graveyard: 'Epidemic transformed by Forbidden Knowledge during a 30s Army of the Dead window, used at 5+ targets',
  'Necrotic Coil': 'Death Coil transformed by Forbidden Knowledge during a 30s Army of the Dead window, cleaves up to 3 targets',
};

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
    case 'ability': {
      const note = ABILITY_MECHANIC_NOTE[gapItem.name];
      return (
        `Top players cast ${gapItem.name}${note ? ` (${note})` : ''} at ${gapItem.cohort} vs your ${gapItem.mine}` +
        (gapItem.damageSharePct ? ` and it carries ~${gapItem.damageSharePct}% of their damage` : '') +
        `; press it closer to on-cooldown / weave it more often.`
      );
    }
    case 'uptime':
      return (
        `Their median ${gapItem.name} uptime is ${gapItem.cohort} vs your ${gapItem.mine} ` +
        `(measured only while actively playing, idle/death windows excluded) — a genuine buff-management ` +
        `gap, not a downtime artifact; keep it rolling.`
      );
    case 'waste': {
      // the resource is whatever the log said this spec generates — no class here
      const res = gapItem.resource ?? 'resource';
      return (
        `You lost ${gapItem.mine} of your potential ${res} to overcapping (~${gapItem.wastedAmount} over the run) ` +
        `vs their ${gapItem.cohort} — spend it before it caps rather than holding it for a "better" moment. ` +
        `Every point wasted is a cast you never got to make.`
      );
    }
    default:
      return '';
  }
}
