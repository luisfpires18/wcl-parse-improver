// What the top players of a spec AGREE on, on one boss.
//
// Ten separate cast lists teach you very little — you'd have to eyeball them and
// guess which presses are the rotation and which are that player's kill. So we
// reduce them to the two things that are actually learnable:
//
//   openerConsensus — slot by slot, what most of them press, and how many disagree.
//     Disagreement is reported, not hidden: "8/10 press Eye Beam 3rd" is a rule,
//     "4/10" is a coin flip and must not read like one.
//   cooldownUsage  — for each burst cooldown: how many of them use it at all, when
//     they first press it, and how many times over the fight.
//
// Both are derived purely from the runs. No spell list, no class knowledge.

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Slot-by-slot modal opener across several cast sequences.
 *
 * @param {Array<Array<{name:string,kind:string}>>} sequences one castOrder() per player
 * @param {number} [slots] how many presses deep to go
 * @returns {Array<{slot,name,kind,count,of,agreementPct,alts}>}
 */
export function openerConsensus(sequences, slots = 12) {
  const lists = (sequences ?? []).filter((s) => Array.isArray(s) && s.length);
  const out = [];
  if (!lists.length) return out;

  for (let i = 0; i < slots; i++) {
    const tally = new Map();
    let present = 0;
    for (const seq of lists) {
      const cast = seq[i];
      if (!cast?.name) continue;
      present++;
      const e = tally.get(cast.name) ?? { name: cast.name, kind: cast.kind, count: 0 };
      e.count++;
      tally.set(cast.name, e);
    }
    if (!present) break; // every sequence is shorter than this — stop, don't pad

    const ranked = [...tally.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const top = ranked[0];
    out.push({
      slot: i + 1,
      name: top.name,
      kind: top.kind,
      count: top.count,
      of: present,
      agreementPct: Math.round((100 * top.count) / present),
      // what the rest pressed instead — a 5/10 "consensus" is only honest if you
      // can see the other 5
      alts: ranked.slice(1, 3).map((r) => ({ name: r.name, count: r.count })),
    });
  }
  return out;
}

/**
 * How the field uses its burst cooldowns (kind === 'amp' — cooldown-frequency
 * damage abilities and potions, as classified by amplifierNamesOf).
 *
 * @param {Array<{name:string,castOrder:Array}>} players
 * @returns {Array<{name,players,of,usedByPct,medianFirstSec,medianUses}>}
 */
export function cooldownUsage(players) {
  const list = (players ?? []).filter((p) => Array.isArray(p.castOrder));
  const n = list.length;
  if (!n) return [];

  const byName = new Map();
  for (const p of list) {
    const amps = p.castOrder.filter((c) => c.kind === 'amp' && c.name);
    const seen = new Map(); // name -> casts by THIS player
    for (const c of amps) {
      if (!seen.has(c.name)) seen.set(c.name, []);
      seen.get(c.name).push(c);
    }
    for (const [name, casts] of seen) {
      const e = byName.get(name) ?? { name, players: 0, firstSecs: [], useCounts: [] };
      e.players++;
      e.firstSecs.push(Math.min(...casts.map((c) => c.tSec)));
      e.useCounts.push(casts.length);
      byName.set(name, e);
    }
  }

  return [...byName.values()]
    .map((e) => ({
      name: e.name,
      players: e.players,
      of: n,
      usedByPct: Math.round((100 * e.players) / n),
      medianFirstSec: Math.round(median(e.firstSecs) ?? 0),
      medianUses: Math.round(median(e.useCounts) ?? 0),
    }))
    // the cooldowns everyone presses first are the ones to learn first
    .sort((a, b) => b.players - a.players || a.medianFirstSec - b.medianFirstSec);
}
