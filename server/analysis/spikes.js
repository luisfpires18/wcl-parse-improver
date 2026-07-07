// Explain WHY the comparison run out-damages mine in its burst windows when
// we run the SAME rotation. Two honest signals:
//
//   1. Engagement start — the first DAMAGE cast of each run. Starting a pull
//      late is pure lost uptime.
//   2. Burst cast density — inside each burst window, the count of DAMAGE
//      casts (Scourge Strike, Graveyard, Putrefy, …, from the DamageDone
//      table) and which AMPLIFIERS fired. Same cooldowns but fewer damage
//      casts = the real gap.
//
// A DAMAGE ability = one that appears in the DamageDone table (deals damage)
// → its casts are the "dmg count". AMPLIFIERS use the named damage-cooldown
// list the project spec sanctioned (Army of the Dead, Dark Transformation,
// Apocalypse, …, + damage potions) — a fixed, reliable set, so utility
// (Mind Freeze, Icebound, Death Charge, Blinding Sleet) never leaks in.
// Windows align to EACH run's own burst peak (not the same clock time), so a
// few seconds of routing offset never reads as "you did nothing".
import { IGNORED_ABILITIES } from './metrics.js';

// Known Unholy DK / general damage cooldowns + damage potions (spec-sanctioned
// named list). Not a rotation guess — just "these are the burst amplifiers".
const AMPLIFIERS = new Set([
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
 * exactly where the composition differs. Cosine similarity of the whole-run
 * cast-count vectors (>= ~0.9 = same rotation) plus a per-ability table of
 * count + cast-share for each side. Damage-ability rows are marked so the UI
 * can separate "they press X more" from "you spend globals on defensives".
 */
export function rotationComposition(mineDetail, otherDetail) {
  const my = castCountsByName(mineDetail);
  const their = castCountsByName(otherDetail);
  const dmg = new Set([...damageNamesOf(mineDetail), ...damageNamesOf(otherDetail)]);
  const names = [...new Set([...my.keys(), ...their.keys()])];
  const myTotal = [...my.values()].reduce((a, b) => a + b, 0) || 1;
  const theirTotal = [...their.values()].reduce((a, b) => a + b, 0) || 1;

  let dot = 0;
  let nm = 0;
  let nt = 0;
  for (const n of names) {
    const a = my.get(n) ?? 0;
    const b = their.get(n) ?? 0;
    dot += a * b;
    nm += a * a;
    nt += b * b;
  }
  const cos = nm && nt ? dot / (Math.sqrt(nm) * Math.sqrt(nt)) : 0;
  const similarityPct = Math.round(cos * 100);

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
        kind: dmg.has(name) ? 'damage' : AMPLIFIERS.has(name) ? 'amp' : 'util',
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
  const summary =
    `Cast composition is ${similarityPct}% similar — ${similarityPct >= 88 ? 'the same rotation, confirmed from the logs' : 'the rotations differ, see the table'}.` +
    (bits.length ? ` Biggest differences: ${listOf(bits)}.` : '');

  return { similarityPct, sameRotation: similarityPct >= 88, summary, rows };
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

/**
 * Ordered cast sequence for the whole run — the literal spell-cast order,
 * so the UI can show the rotation flow for any window the user brushes on
 * the DPS chart. Each entry tags kind (damage / amp / util) for colouring.
 * Capped at `limit` only as a payload safety bound (a run is ~1300 casts).
 */
export function castOrder(detail, limit = 4000) {
  const nameOf = new Map((detail.casts?.abilities ?? []).map((a) => [a.guid, a.name]));
  const dmg = damageNamesOf(detail);
  const start = detail.fight?.startTime ?? 0;
  const out = [];
  for (const ev of detail.castEvents ?? []) {
    const name = nameOf.get(ev.abilityGameID);
    if (!name || IGNORED_ABILITIES.has(name)) continue;
    out.push({
      tSec: Math.round(((ev.timestamp - start) / 1000) * 10) / 10,
      name,
      kind: dmg.has(name) ? 'damage' : AMPLIFIERS.has(name) ? 'amp' : 'util',
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function analyzeSpikes({ mineDetail, otherDetail, mineSeries, otherSeries }) {
  if (!mineSeries?.points?.length || !otherSeries?.points?.length) return null;

  const dmgNames = new Set([...damageNamesOf(mineDetail), ...damageNamesOf(otherDetail)]);
  const myCasts = castTimesByName(mineDetail);
  const theirCasts = castTimesByName(otherDetail);
  const myAmps = new Set([...myCasts.keys()].filter((n) => AMPLIFIERS.has(n)));
  const theirAmps = new Set([...theirCasts.keys()].filter((n) => AMPLIFIERS.has(n)));

  // engagement start = first damage cast
  const myStart = firstDamageCastSec(myCasts, dmgNames);
  const theirStart = firstDamageCastSec(theirCasts, dmgNames);
  let openerNote = null;
  if (myStart != null && theirStart != null && myStart - theirStart > START_GAP_SEC) {
    openerNote =
      `You land your first damaging cast at ${fmt(myStart)} vs their ${fmt(theirStart)} — ` +
      `~${Math.round(myStart - theirStart)}s of lost uptime at the pull start. Pre-pull with Outbreak/Festering ` +
      `Strike and hit the pack the instant it's in range.`;
  }

  // their biggest burst peaks
  const peaks = otherSeries.points
    .map((p, i) => ({ i, tSec: p.tSec, dps: p.dps }))
    .filter((p) => isPeak(otherSeries.points, p.i))
    .sort((a, b) => b.dps - a.dps);
  const chosen = [];
  for (const p of peaks) {
    if (chosen.some((c) => Math.abs(c.tSec - p.tSec) < MERGE_SEC)) continue;
    chosen.push(p);
    if (chosen.length >= MAX_WINDOWS) break;
  }
  chosen.sort((a, b) => a.tSec - b.tSec);

  const perBurstCasts = [];
  const windows = chosen.map((sp) => {
    // my burst on the same pull = my highest bin within ±ALIGN_SEC of their peak
    let myPeakSec = sp.tSec;
    let best = -1;
    for (const p of mineSeries.points) {
      if (Math.abs(p.tSec - sp.tSec) <= ALIGN_SEC && p.dps > best) {
        best = p.dps;
        myPeakSec = p.tSec;
      }
    }
    const theirLo = sp.tSec - BURST_LEAD_SEC;
    const theirHi = sp.tSec + BURST_TAIL_SEC;
    const myLo = myPeakSec - BURST_LEAD_SEC;
    const myHi = myPeakSec + BURST_TAIL_SEC;

    const castDiffs = [];
    let myTotal = 0;
    let theirTotal = 0;
    for (const name of dmgNames) {
      const mineN = countIn(myCasts.get(name), myLo, myHi);
      const themN = countIn(theirCasts.get(name), theirLo, theirHi);
      if (mineN === 0 && themN === 0) continue;
      myTotal += mineN;
      theirTotal += themN;
      castDiffs.push({ name, mine: mineN, them: themN, diff: themN - mineN });
    }
    castDiffs.sort((a, b) => b.them - a.them || b.diff - a.diff);
    perBurstCasts.push({ mine: myTotal, them: theirTotal });

    const theirAmpsHere = [...theirAmps].filter((n) => countIn(theirCasts.get(n), theirLo, theirHi));
    const myAmpsHere = [...myAmps].filter((n) => countIn(myCasts.get(n), myLo, myHi));
    const missingAmps = theirAmpsHere.filter((n) => !myAmpsHere.includes(n));

    // note: lead with amps if genuinely missing, else the biggest cast gaps
    const bigGaps = castDiffs.filter((d) => d.diff >= 2).slice(0, 3);
    let note;
    if (missingAmps.length) {
      note = `They fired ${listOf(missingAmps)} here and you didn't — that's a full burst window without your amplifiers.`;
    } else if (bigGaps.length) {
      note =
        `Same amplifiers, but they landed more damage casts in the window: ` +
        `${bigGaps.map((d) => `${d.name} ${d.them} vs your ${d.mine}`).join(', ')}. ` +
        `${theirTotal} vs your ${myTotal} damage casts total — they weave more into the same burst (fewer GCD gaps).`;
    } else {
      note = `Cast composition is close here (${theirTotal} vs your ${myTotal} damage casts) — this window's gap is target count or pet timing, not your buttons.`;
    }
    return {
      tSec: sp.tSec,
      atLabel: fmt(sp.tSec),
      theirDps: Math.round(sp.dps),
      myDps: Math.round(best >= 0 ? best : dpsAtSec(mineSeries, sp.tSec)),
      gapDps: Math.round(sp.dps - (best >= 0 ? best : dpsAtSec(mineSeries, sp.tSec))),
      theirAmps: theirAmpsHere,
      myAmps: myAmpsHere,
      castDiffs: castDiffs.slice(0, 8),
      myCastTotal: myTotal,
      theirCastTotal: theirTotal,
      note,
    };
  });

  // rotation similarity — proven from cast composition, not assumed
  const rotation = rotationComposition(mineDetail, otherDetail);
  // literal cast-order sequences from the pull start (learn their flow)
  rotation.order = { mine: castOrder(mineDetail), them: castOrder(otherDetail) };

  // headline builds on the confirmed similarity + measured gaps
  const avgMine = perBurstCasts.reduce((a, b) => a + b.mine, 0) / (perBurstCasts.length || 1);
  const avgThem = perBurstCasts.reduce((a, b) => a + b.them, 0) / (perBurstCasts.length || 1);
  const parts = [];
  if (openerNote) parts.push(`you engage pulls later`);
  if (avgThem - avgMine >= 2) parts.push(`they fit more damage casts into each burst (${Math.round(avgThem)} vs your ${Math.round(avgMine)})`);
  const headline = rotation.sameRotation
    ? `${rotation.summary}${parts.length ? ` So with the same rotation, the gap is ${listOf(parts)} — uptime and cast density, not missing cooldowns.` : ''}`
    : rotation.summary;

  return { headline, rotation, openerNote, windows };
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
