// Rotation similarity + the literal cast sequence, and how each cast is
// classified for the reader.
//
// Every cast is one of three kinds:
//   damage — it appears in the DamageDone table
//   amp    — a cooldown or consumable: any potion, any TRINKET, or a DAMAGING
//            ability pressed at cooldown frequency (see amplifierNamesOf). Derived
//            from the run, never from a per-class list, so it works for a spec
//            nobody wrote one for. `amp` beats `damage`: a potion and a big
//            cooldown ARE damage, but reading them as ordinary damage casts buries
//            the thing you are actually scanning the list for.
//   util   — everything else (interrupts, movement)
import { IGNORED_ABILITIES } from './metrics.js';
import { isPotion } from './potions.js';
import { distributionMatch, bigramMatch } from '../../shared/rotationMatch.js';

// A named list of Death Knight cooldowns. Kept only because raidProgress.js uses
// it as the EVIDENCE for burst inflation on that spec — it is not how the cast
// views decide what's an amplifier any more (see amplifierNamesOf below), because
// a hardcoded DK list means a Demon Hunter sees nothing highlighted at all.
export const AMPLIFIERS = new Set([
  'Army of the Dead',
  'Raise Abomination',
  'Dark Transformation',
  'Apocalypse',
  'Unholy Assault',
  'Abomination Limb',
  'Empower Rune Weapon',
  'Summon Gargoyle',
  'Potion of Recklessness',
  'Potion of Unwavering Focus',
]);

// A DAMAGING ability you press rarely is a cooldown — that is what "rarely" means.
// This is the same frequency rule timeline.js already uses to pick its cooldown
// lanes (never a name), so The Hunt and Eye Beam light up for a Havoc DH exactly
// as Army and Apocalypse do for an Unholy DK, with no per-class list.
const AMP_CPM_CEILING = 1.5;

/**
 * The abilities that count as cooldowns/consumables in THIS run:
 *
 *   1. every potion — identified by its icon, so "Light's Potential" counts as
 *      surely as "Potion of Recklessness" (see potions.js);
 *   2. every DAMAGING ability pressed at cooldown frequency;
 *   3. every OTHER rare cast that applies a buff of its own name — which is what an
 *      on-use TRINKET looks like in a log. Algeth'ar Puzzle is cast once, deals no
 *      damage, and grants a stat buff called "Algeth'ar Puzzle"; under rules 1–2 it
 *      fell into grey "utility" and got buried in the cast list, even though the
 *      whole field presses it in the opener.
 *
 * All three are read off the run. There is no item list and no class list — which
 * is also why a rare DEFENSIVE that grants a self-buff (a Blur, a Darkness) lands
 * here too: nothing in a log distinguishes "this buff raises my damage" from "this
 * buff lowers theirs". The strip is labelled "cooldowns & consumables" rather than
 * "burst" for exactly that reason; over-showing a defensive is a far cheaper error
 * than hiding a trinket.
 */
export function amplifierNamesOf(detail) {
  const out = new Set();
  const dmg = damageNamesOf(detail);
  const activeMin = (detail?.casts?.totalTimeMs ?? 0) / 60000;
  // a buff whose name is a cast's name was applied BY that cast: trinket, potion,
  // or cooldown. External raid buffs can't collide — you never cast Battle Shout.
  const selfBuffNames = new Set((detail?.buffs?.auras ?? []).map((a) => a?.name).filter(Boolean));

  for (const a of detail?.casts?.abilities ?? []) {
    if (!a?.name || !a.casts) continue;
    if (isPotion(a)) {
      out.add(a.name); // a potion is a cooldown by definition
      continue;
    }
    if (AMPLIFIERS.has(a.name)) {
      out.add(a.name); // the sanctioned list, for the spec it was written for
      continue;
    }
    const cpm = activeMin > 0 ? a.casts / activeMin : 0;
    if (cpm > AMP_CPM_CEILING) continue; // pressed often => a filler, whatever it does
    if (dmg.has(a.name) || selfBuffNames.has(a.name)) out.add(a.name);
  }
  return out;
}

const BURST_LEAD_SEC = 20; // burst ramps over ~this long before the peak
const BURST_TAIL_SEC = 6;
const ALIGN_SEC = 30; // my burst on the same pull is within ±this of their peak
const MAX_WINDOWS = 3;
const MERGE_SEC = 30;
const START_GAP_SEC = 6; // only flag an opener-timing gap larger than this

const binSecOf = (s) => (s.binMs ?? 5000) / 1000;
const dpsAtSec = (s, sec) => s.points[Math.floor(sec / binSecOf(s))]?.dps ?? 0;

/** name -> [relSec,...] for all cast abilities. */
function castTimesByName(detail) {
  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));
  const start = detail.fight?.startTime ?? 0;
  const byName = new Map();
  for (const ev of detail.castEvents ?? []) {
    const name = nameOf.get(ev.abilityGameID);
    if (!name || IGNORED_ABILITIES.has(name)) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push((ev.timestamp - start) / 1000);
  }
  return byName;
}

const damageNamesOf = (detail) =>
  new Set((detail.damage?.abilities ?? []).filter((a) => a.total > 0).map((a) => a.name));

/** First DAMAGE-ability cast time (sec) — precise engagement start. */
function firstDamageCastSec(casts, dmgNames) {
  let first = Infinity;
  for (const [name, times] of casts) {
    if (!dmgNames.has(name)) continue;
    for (const t of times) if (t < first) first = t;
  }
  return Number.isFinite(first) ? first : null;
}

const countIn = (times, lo, hi) => (times ?? []).filter((t) => t >= lo && t <= hi).length;
const isPeak = (pts, i) => pts[i].dps >= (pts[i - 1]?.dps ?? 0) && pts[i].dps >= (pts[i + 1]?.dps ?? 0);

/**
 * Confirm from cast data whether the two runs use the same rotation, and show
 * exactly where the composition differs.
 *
 * Both numbers are total-variation MATCH of normalized cast distributions,
 * NOT cosine. Cosine of raw cast-count vectors is magnitude-dominated and
 * scale-invariant, so any two runs of the same spec pin near 99% (the shared
 * core buttons swamp everything) — a useless, dishonestly-high number. TV
 * match = 100·(1 − ½Σ|pᵢ−qᵢ|) reads instead as "the share of casts that land
 * on the same button in the same proportion", so it drops honestly when the
 * proportions differ even though the same buttons are pressed. Plus a
 * per-ability table of count + cast-share for each side; damage-ability rows
 * are marked so the UI can separate "they press X more" from "you spend
 * globals on defensives".
 */
export function rotationComposition(mineDetail, otherDetail) {
  const my = castCountsByName(mineDetail);
  const their = castCountsByName(otherDetail);
  const dmg = new Set([...damageNamesOf(mineDetail), ...damageNamesOf(otherDetail)]);
  const amps = new Set([...amplifierNamesOf(mineDetail), ...amplifierNamesOf(otherDetail)]);
  const names = [...new Set([...my.keys(), ...their.keys()])];
  const myTotal = [...my.values()].reduce((a, b) => a + b, 0) || 1;
  const theirTotal = [...their.values()].reduce((a, b) => a + b, 0) || 1;

  // composition (spell mix) — order-blind, proportion-aware
  const similarityPct = Math.round(distributionMatch(my, their));

  // ORDER matters: TV match of cast-transition (bigram) distributions. Two runs
  // with the same spell mix but different sequencing score high above, low here.
  const mySeq = orderedCastNames(mineDetail);
  const theirSeq = orderedCastNames(otherDetail);
  const sequencePct = Math.round(bigramMatch(mySeq, theirSeq));
  const myTopTrans = topTransition(mySeq);
  const theirTopTrans = topTransition(theirSeq);

  const rows = names
    .map((name) => {
      const mine = my.get(name) ?? 0;
      const them = their.get(name) ?? 0;
      return {
        name,
        mine,
        them,
        minePct: Math.round((1000 * mine) / myTotal) / 10,
        themPct: Math.round((1000 * them) / theirTotal) / 10,
        diffPp: Math.round((1000 * (mine / myTotal - them / theirTotal))) / 10,
        kind: amps.has(name) ? 'amp' : dmg.has(name) ? 'damage' : 'util',
      };
    })
    .sort((a, b) => b.them - a.them);

  // headline diffs: the damage ability they press most-more, and the biggest
  // block of globals I spend that they don't (defensives / over-casts)
  const theyPressMore = rows
    .filter((r) => r.kind === 'damage' && r.them - r.mine >= 10)
    .sort((a, b) => b.them - b.mine - (a.them - a.mine))[0];
  const iSpendOn = rows
    .filter((r) => r.mine - r.them >= 8)
    .sort((a, b) => b.mine - b.them - (a.mine - a.them));

  const bits = [];
  if (theyPressMore) bits.push(`they cast ${theyPressMore.name} far more (${theyPressMore.them} vs your ${theyPressMore.mine})`);
  if (iSpendOn.length) {
    const top = iSpendOn.slice(0, 3).map((r) => `${r.name} ${r.mine}${r.them ? `/${r.them}` : ''}`);
    bits.push(`you spend more globals on ${listOf(top)}${iSpendOn.some((r) => r.kind !== 'damage') ? ' (some non-damage)' : ''}`);
  }

  // two honest numbers: spell mix (composition, order-blind) and cast order
  // (transitions, order-sensitive). The second is lower when sequencing differs.
  const orderBit =
    myTopTrans && theirTopTrans && myTopTrans !== theirTopTrans
      ? ` Their most common sequence is ${theirTopTrans}; yours is ${myTopTrans}.`
      : '';
  const summary =
    `Rotation match: ${similarityPct}% spell mix (which buttons, in what proportion) and ` +
    `${sequencePct}% cast order (the sequence you press them in).` +
    (similarityPct - sequencePct >= 10 ? ' You press the same buttons but sequence them differently.' : '') +
    orderBit +
    (bits.length ? ` On counts: ${listOf(bits)}.` : '');

  return {
    similarityPct,
    sequencePct,
    // "same rotation" needs both: same spell mix AND similar sequencing.
    // Thresholds are on the TV-match scale (top players vs a competent player
    // of the same spec land ~84-93 mix, ~64-75 order), not the old cosine
    // scale where everything sat at 97-100.
    sameRotation: similarityPct >= 80 && sequencePct >= 65,
    summary,
    rows,
    myTopTransition: myTopTrans,
    theirTopTransition: theirTopTrans,
  };
}

function castCountsByName(detail) {
  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));
  const c = new Map();
  for (const ev of detail.castEvents ?? []) {
    const n = nameOf.get(ev.abilityGameID);
    if (!n || IGNORED_ABILITIES.has(n)) continue;
    c.set(n, (c.get(n) ?? 0) + 1);
  }
  return c;
}

/** Ordered list of cast ability names (excluding cosmetic), for sequence analysis. */
function orderedCastNames(detail) {
  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));
  const out = [];
  for (const ev of detail.castEvents ?? []) {
    const n = nameOf.get(ev.abilityGameID);
    if (n && !IGNORED_ABILITIES.has(n)) out.push(n);
  }
  return out;
}

// distributionMatch / bigramMatch live in shared/ because the browser computes
// the same two numbers for a brushed chart window — re-exported so existing
// importers (and tests) keep their entry point.
export { distributionMatch, bigramMatch } from '../../shared/rotationMatch.js';

/** The most common "A → B" transition in a cast sequence, phrased. */
function topTransition(seq) {
  const m = new Map();
  for (let i = 0; i + 1 < seq.length; i++) {
    const k = `${seq[i]} → ${seq[i + 1]}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const top = [...m.entries()].sort((x, y) => y[1] - x[1])[0];
  return top ? top[0] : null;
}

/**
 * Ordered cast sequence for the whole run — the literal spell-cast order,
 * so the UI can show the rotation flow for any window the user brushes on
 * the DPS chart. Each entry tags kind (damage / amp / util) for colouring.
 * Capped at `limit` only as a payload safety bound (a run is ~1300 casts).
 */
export function castOrder(detail, limit = 4000) {
  // Only abilities in the Casts TABLE count. The cast EVENT stream carries more
  // events than there were presses (2575 events against a table total of 1489 on a
  // real log) because the same press is often logged twice under a second ability
  // id — The Hunt appears as both 370965 and 370966, 24 casts each, for 24 actual
  // presses. Naming those extra events off masterData would look like a fix and
  // silently double the count. The table is the authority on what was pressed.
  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));

  const dmg = damageNamesOf(detail);
  const amps = amplifierNamesOf(detail);
  const start = detail.fight?.startTime ?? 0;

  const out = [];
  for (const ev of detail.castEvents ?? []) {
    const name = nameOf.get(ev.abilityGameID);
    if (!name || IGNORED_ABILITIES.has(name)) continue;
    out.push({
      tSec: Math.round(((ev.timestamp - start) / 1000) * 10) / 10,
      // amp wins over damage: a potion and a big cooldown ARE damage, but reading
      // them as ordinary damage casts buries the thing you actually want to find
      kind: amps.has(name) ? 'amp' : dmg.has(name) ? 'damage' : 'util',
      name,
    });
    if (out.length >= limit) break;
  }

  // BACKSTOP: a potion you cannot see is the whole complaint. Even if its cast
  // event is missing or unnameable, the BUFF it applies is in the Buffs table with
  // a band per use — that is proof it was drunk, and when. Merge any potion use
  // that the cast stream didn't already account for, so a potion can never be lost
  // to a gap in the cast data. Works for the opponent exactly as for you: it is
  // their log, same tables.
  for (const use of potionUsesFromBuffs(detail)) {
    const already = out.some((c) => c.name === use.name && Math.abs(c.tSec - use.tSec) <= 2);
    if (!already) out.push({ ...use, kind: 'amp', fromBuff: true });
  }

  return out.sort((a, b) => a.tSec - b.tSec);
}

/**
 * When each potion was drunk, read from the aura it applies rather than from a
 * cast. The band start IS the moment it was used.
 */
function potionUsesFromBuffs(detail) {
  const start = detail.fight?.startTime ?? 0;
  const end = detail.fight?.endTime ?? Infinity;
  const out = [];
  for (const aura of detail.buffs?.auras ?? []) {
    if (!isPotion(aura)) continue;
    for (const b of aura.bands ?? []) {
      if (b.startTime < start || b.startTime > end) continue;
      out.push({ name: aura.name, tSec: Math.round(((b.startTime - start) / 1000) * 10) / 10 });
    }
  }
  return out;
}

function listOf(arr) {
  if (!arr.length) return 'nothing';
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')} and ${arr.at(-1)}`;
}
function fmt(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}
