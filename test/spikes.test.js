import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotationComposition, castOrder, bigramMatch, amplifierNamesOf } from '../server/analysis/spikes.js';

// Scourge Strike = a FILLER (spammed, so it reads as ordinary damage).
// Army of the Dead = a COOLDOWN (pressed once a minute, so it reads as an
// amplifier — that classification is now derived from cast FREQUENCY, not from a
// hardcoded per-class list, so the cast counts here have to be realistic).
// Mind Freeze = utility (no damage).
function makeDetail(castEvents, damageAbilities = [{ name: 'Scourge Strike', total: 1000, hits: 1 }]) {
  return {
    fight: { startTime: 0, endTime: 60000, keystoneTime: 60000, keystoneLevel: 20 },
    casts: { totalTimeMs: 60000, totalCasts: castEvents.length, abilities: [
      { name: 'Scourge Strike', guid: 1, casts: 40 }, // 40/min -> a filler
      { name: 'Army of the Dead', guid: 2, casts: 1 }, // 1/min -> a cooldown
      { name: 'Mind Freeze', guid: 3, casts: 2 },
    ] },
    buffs: { totalTimeMs: 60000, auras: [] },
    damage: { totalDamage: 1000, abilities: damageAbilities },
    deaths: { deaths: [] },
    castEvents,
    resourceEvents: [],
  };
}


test('rotationComposition: near-identical casts score high similarity (same rotation, confirmed)', () => {
  const ev = (n) => Array.from({ length: n }, (_, i) => ({ timestamp: 1000 + i * 500, abilityGameID: 1 }));
  const mine = makeDetail([...ev(10), { timestamp: 9000, abilityGameID: 2 }]); // 10 Scourge + 1 Army
  const other = makeDetail([...ev(11), { timestamp: 9000, abilityGameID: 2 }]); // 11 Scourge + 1 Army
  const rc = rotationComposition(mine, other);
  assert.ok(rc.similarityPct >= 95, `expected high composition similarity, got ${rc.similarityPct}`);
  // near-identical sequence too (both spam Scourge then Army) -> same rotation
  assert.ok(rc.sequencePct >= 85, `expected high sequence similarity, got ${rc.sequencePct}`);
  assert.equal(rc.sameRotation, true);
  assert.ok(rc.summary.includes('spell mix') && rc.summary.includes('cast order'));
  const ss = rc.rows.find((r) => r.name === 'Scourge Strike');
  assert.equal(ss.mine, 10);
  assert.equal(ss.them, 11);
  assert.equal(ss.kind, 'damage');
  const army = rc.rows.find((r) => r.name === 'Army of the Dead');
  assert.equal(army.kind, 'amp'); // amplifier, not util
});

test('castOrder returns the chronological cast sequence with kind tags, capped at limit', () => {
  const detail = makeDetail([
    { timestamp: 3000, abilityGameID: 1 }, // Scourge @3s (fight start = 0)
    { timestamp: 1000, abilityGameID: 2 }, // Army @1s — earliest
    { timestamp: 2000, abilityGameID: 3 }, // Mind Freeze @2s
  ]);
  detail.castEvents.sort((a, b) => a.timestamp - b.timestamp);
  const order = castOrder(detail, 10);
  assert.deepEqual(order.map((o) => o.name), ['Army of the Dead', 'Mind Freeze', 'Scourge Strike']);
  assert.equal(order[0].kind, 'amp'); // Army
  assert.equal(order[1].kind, 'util'); // Mind Freeze
  assert.equal(order[2].kind, 'damage'); // Scourge Strike
  assert.equal(order[0].tSec, 1);
});

test('castOrder respects the limit', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ timestamp: 1000 + i * 100, abilityGameID: 1 }));
  assert.equal(castOrder(makeDetail(many), 25).length, 25);
});

test('bigramMatch: order matters — same counts, different order scores well below 100', () => {
  // identical multiset {A,A,B,B} but opposite sequencing
  const a = ['A', 'B', 'A', 'B', 'A', 'B']; // alternating
  const b = ['A', 'A', 'A', 'B', 'B', 'B']; // clumped
  const sim = bigramMatch(a, b);
  assert.ok(sim < 60, `expected low order similarity, got ${sim}`);
  // identical sequence = 100
  assert.equal(Math.round(bigramMatch(a, a)), 100);
});

test('rotationComposition: reports BOTH spell-mix and cast-order similarity; same mix + different order is not "same rotation"', () => {
  // both cast Scourge(1)+Mind Freeze(3) many times but in different orders
  const alt = [];
  const clump = [];
  for (let i = 0; i < 12; i++) {
    alt.push({ timestamp: 1000 + i * 1000, abilityGameID: i % 2 ? 1 : 3 }); // alternate
  }
  for (let i = 0; i < 6; i++) clump.push({ timestamp: 1000 + i * 1000, abilityGameID: 1 });
  for (let i = 0; i < 6; i++) clump.push({ timestamp: 8000 + i * 1000, abilityGameID: 3 });
  const rc = rotationComposition(makeDetail(alt), makeDetail(clump));
  assert.ok(rc.similarityPct >= 90, `composition should be high, got ${rc.similarityPct}`);
  assert.ok(rc.sequencePct < rc.similarityPct, 'cast-order similarity should be lower than composition');
  assert.equal(rc.sameRotation, false); // different sequencing => not the same rotation
  assert.ok(rc.summary.includes('spell mix') && rc.summary.includes('cast order'));
});

test('rotationComposition: divergent casts score low similarity (different rotation)', () => {
  // mine: all Scourge; theirs: all Mind Freeze (orthogonal vectors)
  const mine = makeDetail(Array.from({ length: 10 }, () => ({ timestamp: 1000, abilityGameID: 1 })));
  const other = makeDetail(Array.from({ length: 10 }, () => ({ timestamp: 1000, abilityGameID: 3 })));
  const rc = rotationComposition(mine, other);
  assert.ok(rc.similarityPct < 88, `expected low similarity, got ${rc.similarityPct}`);
  assert.equal(rc.sameRotation, false);
});

// Amplifiers used to be a hardcoded Death Knight name list, so a Havoc DH saw
// NOTHING highlighted in the cast order — not The Hunt, not even their potion.
// They're now derived from the run: any combat potion, plus any DAMAGING ability
// pressed at cooldown frequency.
const havoc = (casts) => ({
  fight: { startTime: 0, endTime: 300000 }, // 5 min
  casts: {
    totalTimeMs: 300000,
    totalCasts: 0,
    abilities: [
      { name: 'Chaos Strike', guid: 10, casts: 150 }, // 30/min -> filler
      { name: 'The Hunt', guid: 11, casts: 3 }, // 0.6/min -> cooldown
      { name: 'Eye Beam', guid: 12, casts: 5 }, // 1/min -> cooldown
      { name: 'Potion of Unwavering Focus', guid: 13, casts: 2 },
      { name: 'Disrupt', guid: 14, casts: 4 }, // utility: no damage
    ],
  },
  damage: {
    totalDamage: 1000,
    abilities: [
      { name: 'Chaos Strike', total: 600, hits: 1 },
      { name: 'The Hunt', total: 200, hits: 1 },
      { name: 'Eye Beam', total: 200, hits: 1 },
      { name: 'Potion of Unwavering Focus', total: 0, hits: 0 },
    ],
  },
  buffs: { totalTimeMs: 300000, auras: [] },
  deaths: { deaths: [] },
  castEvents: casts,
  resourceEvents: [],
});

test('amplifierNamesOf: a class with no hardcoded list still gets its cooldowns flagged', () => {
  const amps = amplifierNamesOf(havoc([]));
  assert.ok(amps.has('The Hunt'), 'a rarely-pressed damaging ability is a cooldown');
  assert.ok(amps.has('Eye Beam'));
  assert.ok(amps.has('Potion of Unwavering Focus'), 'a potion is a cooldown by definition');
  assert.ok(!amps.has('Chaos Strike'), 'a spammed filler is not an amplifier');
  assert.ok(!amps.has('Disrupt'), 'an interrupt deals no damage — utility');
});

test('castOrder: the potion shows as an amplifier, whatever class pressed it', () => {
  const d = havoc([
    { timestamp: 1000, abilityGameID: 13 }, // potion
    { timestamp: 2000, abilityGameID: 11 }, // The Hunt
    { timestamp: 3000, abilityGameID: 10 }, // Chaos Strike
    { timestamp: 4000, abilityGameID: 14 }, // Disrupt
  ]);
  const order = castOrder(d);
  assert.deepEqual(
    order.map((c) => [c.name, c.kind]),
    [
      ['Potion of Unwavering Focus', 'amp'],
      ['The Hunt', 'amp'],
      ['Chaos Strike', 'damage'],
      ['Disrupt', 'util'],
    ]
  );
});

test('castOrder: amp beats damage — a cooldown is not buried as an ordinary damage cast', () => {
  // The Hunt IS in the damage table; it must still read as a cooldown.
  const d = havoc([{ timestamp: 1000, abilityGameID: 11 }]);
  assert.equal(castOrder(d)[0].kind, 'amp');
});

// A potion you cannot see is the whole complaint. Even if the cast event is
// missing or unnameable, the BUFF it applies is in the Buffs table with a band per
// use — that is proof it was drunk, and when. Works for the opponent exactly as
// for you: same tables, their log.
test('a potion with no cast event is still recovered, from the buff it applies', () => {
  const d = havoc([{ timestamp: 5000, abilityGameID: 10 }]); // only a Chaos Strike cast
  d.buffs = {
    totalTimeMs: 300000,
    auras: [
      { name: 'Potion of Recklessness', uptimeMs: 60000, uses: 2, bands: [{ startTime: 1000, endTime: 31000 }, { startTime: 200000, endTime: 230000 }] },
    ],
  };
  const order = castOrder(d);
  const pots = order.filter((c) => /^potion/i.test(c.name));
  assert.equal(pots.length, 2, 'both uses recovered from the buff bands');
  assert.deepEqual(pots.map((p) => p.tSec), [1, 200]);
  for (const p of pots) {
    assert.equal(p.kind, 'amp');
    assert.equal(p.fromBuff, true, 'flagged as derived, not invented');
  }
  // and it lands in chronological order alongside the real casts
  assert.deepEqual(order.map((c) => c.tSec), [1, 5, 200]);
});

test('a potion that DOES have a cast event is not counted twice', () => {
  // guid 13 is Potion of Unwavering Focus — the buff must be the SAME potion, or
  // they are genuinely two different drinks
  const d = havoc([{ timestamp: 1200, abilityGameID: 13 }]); // the potion cast
  d.buffs = {
    totalTimeMs: 300000,
    auras: [{ name: 'Potion of Unwavering Focus', uptimeMs: 30000, uses: 1, bands: [{ startTime: 1000, endTime: 31000 }] }],
  };
  const pots = castOrder(d).filter((c) => /^potion/i.test(c.name));
  assert.equal(pots.length, 1, 'the buff band and the cast are the same use');
  assert.ok(!pots[0].fromBuff, 'the real cast wins; the buff is only a backstop');
});

test('two DIFFERENT potions at the same moment are both kept', () => {
  const d = havoc([{ timestamp: 1200, abilityGameID: 13 }]); // Unwavering Focus cast
  d.buffs = {
    totalTimeMs: 300000,
    auras: [{ name: 'Potion of Recklessness', uptimeMs: 30000, uses: 1, bands: [{ startTime: 1000, endTime: 31000 }] }],
  };
  const pots = castOrder(d).filter((c) => /^potion/i.test(c.name));
  assert.equal(pots.length, 2, 'different potions are different uses, not a duplicate');
});

// The cast EVENT stream carries more events than there were presses: the same cast
// is often logged under a second ability id. Naming those off masterData would look
// like a fix and silently double the count.
// Two things the old rules could not see, both taken from a real Chimaerus log:
//
//   "Light's Potential" is a combat potion the whole field drinks, but the name test
//   was /^potion of/ — so it was never an amplifier and never counted as a potion.
//   Every potion's ICON carries the word, whatever the item is called.
//
//   An on-use TRINKET (Algeth'ar Puzzle) is cast once, deals no damage, and grants a
//   buff of its own name. Under "damaging + rare" it fell into grey utility and was
//   buried in the cast list, even though the top parsers press it in the opener.
const withItems = (casts) => ({
  fight: { startTime: 0, endTime: 300000 },
  casts: {
    totalTimeMs: 300000,
    totalCasts: 0,
    abilities: [
      { name: 'Chaos Strike', guid: 10, casts: 150, abilityIcon: 'ability_demonhunter_chaosstrike.jpg' },
      // a potion whose NAME says nothing — only the icon does
      { name: "Light's Potential", guid: 20, casts: 1, abilityIcon: 'inv_12_profession_alchemy_lightpotion_yellow.jpg' },
      // an on-use trinket: no damage, grants a same-named buff
      { name: "Algeth'ar Puzzle", guid: 21, casts: 1, abilityIcon: 'inv_misc_enggizmos_18.jpg' },
      // a rare defensive, also buff-granting — it lands in the strip too, knowingly
      { name: 'Blur', guid: 22, casts: 2, abilityIcon: 'ability_demonhunter_blur.jpg' },
      { name: 'Disrupt', guid: 23, casts: 4, abilityIcon: 'ability_demonhunter_disrupt.jpg' }, // no damage, no buff
    ],
  },
  damage: { totalDamage: 1000, abilities: [{ name: 'Chaos Strike', total: 1000, hits: 1 }] },
  buffs: {
    totalTimeMs: 300000,
    auras: [
      { name: "Light's Potential", guid: 20, abilityIcon: 'inv_12_profession_alchemy_lightpotion_yellow.jpg', uptimeMs: 30000, uses: 1, bands: [{ startTime: 100, endTime: 30100 }] },
      { name: "Algeth'ar Puzzle", guid: 21, abilityIcon: 'inv_misc_enggizmos_18.jpg', uptimeMs: 40000, uses: 2, bands: [] },
      { name: 'Blur', guid: 22, abilityIcon: 'ability_demonhunter_blur.jpg', uptimeMs: 12000, uses: 2, bands: [] },
      // a flask is NOT a potion — even though its ART is a potion bottle
      { name: 'Flask of the Shattered Sun', guid: 30, abilityIcon: 'inv_12_profession_alchemy_flask_sindoreipotion_red--.jpg', uptimeMs: 300000, uses: 1, bands: [{ startTime: 0, endTime: 300000 }] },
      // someone else's raid buff: never cast by me, so it can't be mistaken for one
      { name: 'Battle Shout', guid: 31, abilityIcon: 'ability_warrior_battleshout.jpg', uptimeMs: 300000, uses: 2, bands: [] },
    ],
  },
  deaths: { deaths: [] },
  castEvents: casts,
  resourceEvents: [],
});

test("a potion is identified by its icon, so Light's Potential counts like any other", () => {
  const amps = amplifierNamesOf(withItems([]));
  assert.ok(amps.has("Light's Potential"), 'the icon says potion even though the name does not');
  // a flask's icon ALSO says potion (its art is a Sin'dorei potion bottle) — it is
  // still not a drink, and must never be pinned as one
  assert.ok(!amps.has('Flask of the Shattered Sun'), 'a flask is maintained, not pressed');
});

test('a flask is never recovered as a potion use from its buff band', () => {
  const order = castOrder(withItems([{ timestamp: 2000, abilityGameID: 10 }]));
  assert.ok(!order.some((c) => c.name === 'Flask of the Shattered Sun'), 'a flask is not a cast, and not a drink');
});

test('an on-use trinket is a cooldown: a rare cast that grants a buff of its own name', () => {
  const amps = amplifierNamesOf(withItems([]));
  assert.ok(amps.has("Algeth'ar Puzzle"), 'no damage, but it is plainly a pressed cooldown');
  assert.ok(!amps.has('Disrupt'), 'an interrupt grants no buff and deals no damage — still utility');
  assert.ok(!amps.has('Chaos Strike'), 'a spammed filler is never a cooldown');
  assert.ok(!amps.has('Battle Shout'), "a groupmate's buff is not something I cast");
});

test('the buff-granting rule is generous by design: a rare defensive lands in the strip too', () => {
  // Stated rather than hidden: nothing in a log distinguishes "this buff raises my
  // damage" from "this buff lowers theirs". Over-showing Blur beats burying a trinket.
  assert.ok(amplifierNamesOf(withItems([])).has('Blur'));
});

test('the trinket and the potion appear in cast order as amplifiers, in sequence', () => {
  const order = castOrder(
    withItems([
      { timestamp: 100, abilityGameID: 20 }, // Light's Potential
      { timestamp: 1000, abilityGameID: 21 }, // Algeth'ar Puzzle
      { timestamp: 2000, abilityGameID: 10 }, // Chaos Strike
    ])
  );
  assert.deepEqual(
    order.map((c) => [c.name, c.kind]),
    [
      ["Light's Potential", 'amp'],
      ["Algeth'ar Puzzle", 'amp'],
      ['Chaos Strike', 'damage'],
    ]
  );
});

test("a potion with no cast event is recovered from its buff by icon, not by name", () => {
  const order = castOrder(withItems([{ timestamp: 2000, abilityGameID: 10 }])); // only a filler cast
  const pot = order.find((c) => c.name === "Light's Potential");
  assert.ok(pot, 'the buff band proves it was drunk');
  assert.equal(pot.kind, 'amp');
  assert.equal(pot.fromBuff, true);
});

test('an event whose ability is not in the Casts table is NOT invented into a cast', () => {
  const d = havoc([
    { timestamp: 1000, abilityGameID: 11 }, // The Hunt — in the table
    { timestamp: 1000, abilityGameID: 999 }, // the same press, second id — not in the table
  ]);
  const hunts = castOrder(d).filter((c) => c.name === 'The Hunt');
  assert.equal(hunts.length, 1, 'one press, not two');
});
