// Section 4 — Consumables & party buffs. Everything you or your group *applied*
// to you before the pull, as opposed to what you pressed during it.
//
// Two halves, and only one of them needs names:
//
//   CONSUMABLES (flask, food, oil, rune, potion) are matched by name pattern.
//   That is acceptable here and nowhere else: consumable naming is a stable
//   convention ("Flask of…", "…Well Fed", "…Rune"), not patch-volatile talent
//   knowledge. compare.js already keyed flask/food detection off exactly this.
//
//   PARTY BUFFS need no names at all. An aura is someone else's if the log says
//   someone else applied it — classifyBuffSources() counts every apply/remove
//   event by sourceID, so `foreign > 0 && self === 0` identifies Blessing of the
//   Bronze, Battle Shout, Arcane Intellect or whatever next patch renames them to,
//   without a list. This was already computed; it just used to be buried in a panel
//   called "Group comp / talent differences (not actionable)" that nobody read.

// Ordered: the first pattern that matches an aura claims it, so "Flask of the
// Shattered Sun" can't also be counted as a potion.
const CONSUMABLE_KINDS = [
  { key: 'flask', label: 'Flask', re: /flask|phial/i },
  { key: 'food', label: 'Food', re: /well fed/i },
  { key: 'oil', label: 'Weapon oil', re: /\boil\b|sharpening stone|weightstone/i },
  { key: 'rune', label: 'Augment rune', re: /rune of|augment rune|void-touched|draconic augment/i },
  { key: 'potion', label: 'Potion', re: /^potion of|elixir/i },
];

// Which secondary stat a flask grants. Display-only sugar — an unmapped flask
// still shows its name, it just doesn't get a stat label.
const FLASK_STAT = {
  'Flask of the Shattered Sun': 'Crit',
  'Flask of the Magisters': 'Mastery',
  'Flask of Tempered Swiftness': 'Haste',
  'Flask of Tempered Versatility': 'Versatility',
  'Flask of Alchemical Chaos': 'Rotating stats',
};

/** Highest-uptime aura matching a pattern, with its uptime % of the fight. */
function findAura(detail, re) {
  const total = detail?.buffs?.totalTimeMs || 1;
  const a = (detail?.buffs?.auras ?? [])
    .filter((x) => x?.name && re.test(x.name))
    .sort((p, q) => q.uptimeMs - p.uptimeMs)[0];
  return a ? { name: a.name, pct: Math.round((100 * a.uptimeMs) / total) } : null;
}

const consumablesOf = (detail) => {
  const out = {};
  for (const kind of CONSUMABLE_KINDS) out[kind.key] = findAura(detail, kind.re);
  return out;
};

// A groupmate's buff only counts as a "party buff" if they KEPT it on you. Without
// this the list is 23 entries long and mostly stray heal ticks — a real run came
// back with Regrowth at 0% and Enveloping Mist at 1% sitting next to Blessing of
// the Bronze. The buffs a group plans around (Bronze, Battle Shout, Arcane
// Intellect, an Augmentation's Ebon Might/Prescience) are up for a large part of
// the fight by design; a one-off heal-over-time is not.
//
// This is an uptime rule, not a list of buff names — so it keeps working for buffs
// that do not exist yet.
const MIN_PARTY_BUFF_UPTIME_PCT = 20;
const MAX_PARTY_BUFFS = 10;

/**
 * Party buffs: auras applied to me by SOMEONE ELSE. Derived from real apply/remove
 * events, never from a hardcoded list of raid buffs.
 *
 * @param {object} detail the run whose auras we're listing
 * @param {Record<string,{self:number,foreign:number}>} buffSources from classifyBuffSources
 */
function partyBuffsOf(detail, buffSources) {
  if (!buffSources) return [];
  const total = detail?.buffs?.totalTimeMs || 1;
  const out = [];
  for (const aura of detail?.buffs?.auras ?? []) {
    const src = buffSources[aura?.name];
    // applied by a groupmate, never by me => someone else's buff
    if (!src || !(src.foreign > 0 && src.self === 0)) continue;
    const pct = Math.round((100 * aura.uptimeMs) / total);
    if (pct < MIN_PARTY_BUFF_UPTIME_PCT) continue; // a stray tick, not a buff you plan around
    out.push({ name: aura.name, pct });
  }
  return out.sort((a, b) => b.pct - a.pct).slice(0, MAX_PARTY_BUFFS);
}

/**
 * @param {object} mineDetail
 * @param {object} otherDetail the ONE player being compared against
 * @param {string} otherName
 * @param {object} buffSources self-vs-external classification (computed for "mine";
 *   both sides are the same spec, so it applies to both)
 * @param {string|null} statPriorityNote optional spec stat-priority hint
 */
export function buildConsumables(mineDetail, otherDetail, otherName, buffSources = null, statPriorityNote = null) {
  const mine = consumablesOf(mineDetail);
  const them = consumablesOf(otherDetail);

  const statOf = (f) => (f ? FLASK_STAT[f.name] ?? null : null);
  const myStat = statOf(mine.flask);
  const theirStat = statOf(them.flask);

  const rows = CONSUMABLE_KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    mine: mine[k.key],
    them: them[k.key],
    // you brought nothing and they did — free stats left on the table
    missing: Boolean(!mine[k.key] && them[k.key]),
  }));

  const notes = [];
  if (mine.flask && them.flask && myStat && theirStat && myStat !== theirStat) {
    notes.push(
      `You run the ${myStat} flask (${mine.flask.name}); they run the ${theirStat} flask (${them.flask.name}).` +
        (statPriorityNote ? ` ${statPriorityNote}` : " Match the flask to your spec's stat priority.")
    );
  }
  const missing = rows.filter((r) => r.missing);
  if (missing.length) {
    notes.push(
      `They had ${missing.map((r) => `${r.label.toLowerCase()} (${r.them.name})`).join(', ')} and you didn't — free stats you're not taking.`
    );
  }

  const myParty = partyBuffsOf(mineDetail, buffSources);
  const theirParty = partyBuffsOf(otherDetail, buffSources);
  const mineNames = new Set(myParty.map((b) => b.name));
  // buffs their group gave them that yours didn't give you. Not your play — but it
  // is a real slice of the DPS gap, and knowing that stops you hunting for a
  // rotation mistake that was never there.
  const theyHadIDidnt = theirParty.filter((b) => !mineNames.has(b.name));

  return {
    otherLabel: otherName,
    rows,
    partyBuffs: { mine: myParty, them: theirParty, theyHadIDidnt },
    notes,
  };
}
