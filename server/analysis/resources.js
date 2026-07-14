// Resource management, for every class — not just Death Knights.
//
// This was Death-Knight-only and hardcoded three ways: the event parser filtered
// to resourceChangeType 6 (Runic Power), metrics.js looked up 'Death Coil' and
// 'Epidemic' by literal name, and a `RP_SCALE = 10` constant existed purely
// because WCL reports Runic Power at 10x. None of that generalises.
//
// It doesn't need to. The log already states which resource an ability generated.
// So: keep every resource type, group the player's own gains by type, and take the
// dominant one — that IS the spec's primary resource, derived rather than declared.
// A Havoc DH yields Fury, a Paladin Holy Power, a Rogue Energy, with no per-class
// registry and nothing to update when a spec is reworked.
//
// The scale hack dies too. `wastePct = waste / (gain + waste)` is SCALE-INVARIANT:
// if WCL reports a resource at 10x, both numerator and denominator scale together
// and the percentage is unchanged. So the panel leads with the percentage, and
// shows raw totals in whatever units the log used rather than inventing a divisor
// we cannot verify per class.

// WoW power-type ids. Stable game data (the enum behind UnitPower), not
// patch-volatile talent knowledge — unlike a spec's abilities, these do not get
// reworked. An id we don't know is reported as "power type N": honest, and still
// usable, because every NUMBER below is derived from the log rather than the name.
const POWER_TYPES = {
  0: 'Mana',
  1: 'Rage',
  2: 'Focus',
  3: 'Energy',
  4: 'Combo Points',
  5: 'Runes',
  6: 'Runic Power',
  7: 'Soul Shards',
  8: 'Lunar Power',
  9: 'Holy Power',
  10: 'Alternate Power',
  11: 'Maelstrom',
  12: 'Chi',
  13: 'Insanity',
  16: 'Arcane Charges',
  17: 'Fury',
  18: 'Pain',
  19: 'Essence',
};

/** Display name for a WCL resourceChangeType. Unknown ids are named, not guessed. */
export const resourceName = (type) => POWER_TYPES[type] ?? (type != null ? `power type ${type}` : null);

/** True when we actually recognise the id — the UI can flag the rest as unverified. */
export const isKnownResource = (type) => Object.prototype.hasOwnProperty.call(POWER_TYPES, type);

/**
 * The player's primary resource and how much of it they threw away by capping.
 *
 * "Dominant" = the type they generated the most of. A spec can touch several
 * resources in one fight (a DK gains Runes AND Runic Power); the one carrying the
 * most generation is the one whose overcapping is a real rotational mistake.
 *
 * @param {{type:number, gain:number, waste:number}[]} resourceEvents from parseResourceEvents
 * @returns {{type, name, known, gain, waste, wastePct, events, others}|null}
 */
export function computeResource(resourceEvents = []) {
  if (!resourceEvents.length) return null;

  const byType = new Map();
  for (const e of resourceEvents) {
    if (e.type == null) continue;
    const acc = byType.get(e.type) ?? { type: e.type, gain: 0, waste: 0, events: 0 };
    acc.gain += e.gain;
    acc.waste += e.waste;
    acc.events += 1;
    byType.set(e.type, acc);
  }
  if (!byType.size) return null;

  const ranked = [...byType.values()].sort((a, b) => b.gain - a.gain || b.events - a.events);
  const main = ranked[0];

  return {
    ...main,
    name: resourceName(main.type),
    known: isKnownResource(main.type),
    // % of everything you could have generated that the cap ate. Scale-invariant,
    // so it needs no per-resource divisor and is comparable across classes.
    wastePct: main.gain + main.waste > 0 ? (100 * main.waste) / (main.gain + main.waste) : null,
    // the secondary pools (a DK's Runes alongside its Runic Power), kept so the UI
    // can show them without them ever being mistaken for the primary
    others: ranked.slice(1).map((r) => ({
      ...r,
      name: resourceName(r.type),
      known: isKnownResource(r.type),
      wastePct: r.gain + r.waste > 0 ? (100 * r.waste) / (r.gain + r.waste) : null,
    })),
  };
}

/**
 * Compare my resource waste against the one player I'm being measured against.
 * Only meaningful when both ran the same resource — which they do, since the
 * comparison is always same-class/same-spec.
 */
export function compareResource(mineEvents, theirEvents) {
  const mine = computeResource(mineEvents);
  const them = computeResource(theirEvents);
  if (!mine) return null;

  const sameResource = Boolean(them && them.type === mine.type);
  const diffPp = sameResource && mine.wastePct != null && them.wastePct != null ? mine.wastePct - them.wastePct : null;

  return {
    name: mine.name,
    known: mine.known,
    type: mine.type,
    mine: { gain: round(mine.gain), waste: round(mine.waste), wastePct: round1(mine.wastePct) },
    them: sameResource ? { gain: round(them.gain), waste: round(them.waste), wastePct: round1(them.wastePct) } : null,
    diffPp: round1(diffPp),
    others: mine.others.map((o) => ({ name: o.name, wastePct: round1(o.wastePct) })),
    note: describe(mine, sameResource ? them : null, diffPp),
  };
}

function describe(mine, them, diffPp) {
  if (mine.wastePct == null) return null;
  const unknown = mine.known ? '' : ` (this power type isn't one we recognise by name, but the numbers come from the log either way)`;
  const base = `You wasted ${round1(mine.wastePct)}% of the ${mine.name} you could have generated — it was capped when the gain landed${unknown}.`;
  if (!them || diffPp == null) return base;
  if (diffPp > 3) {
    return `${base} They waste only ${round1(them.wastePct)}%, so ${round1(diffPp)} percentage points of your generation is going nowhere theirs doesn't — spend before you cap.`;
  }
  if (diffPp < -3) {
    return `${base} That's actually tighter than their ${round1(them.wastePct)}% — overcapping isn't costing you here.`;
  }
  return `${base} They waste ${round1(them.wastePct)}%, so you're in line with them on this.`;
}

const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
