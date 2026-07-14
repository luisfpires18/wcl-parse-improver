import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsumables } from '../server/analysis/consumables.js';

const withAuras = (auras) => ({ buffs: { totalTimeMs: 100000, auras } });
const rowFor = (c, key) => c.rows.find((r) => r.key === key);

test('detects the consumables that actually leave a trace in the log', () => {
  const mine = withAuras([
    { name: 'Flask of the Shattered Sun', uptimeMs: 100000 },
    { name: 'Hearty Well Fed', uptimeMs: 100000 },
    { name: 'Crystallized Augment Rune', uptimeMs: 80000 },
    { name: 'Rune Mastery', uptimeMs: 50000 }, // a CLASS buff, not a consumable
  ]);
  const c = buildConsumables(mine, withAuras([]), 'TopDK');

  assert.equal(rowFor(c, 'flask').mine.name, 'Flask of the Shattered Sun');
  assert.equal(rowFor(c, 'food').mine.name, 'Hearty Well Fed');
  assert.equal(rowFor(c, 'rune').mine.name, 'Crystallized Augment Rune');

  // "Rune Mastery" is a Death Knight proc — it must not be mistaken for an
  // augment rune just because its name contains "Rune"
  assert.notEqual(rowFor(c, 'rune').mine.name, 'Rune Mastery');

  // Weapon oil applies no combat aura, so it is not in the log. We do not invent
  // a row for something we cannot see.
  assert.equal(rowFor(c, 'oil'), undefined);
});

// A potion is a burst you press, not a buff you maintain, so uptime % is the wrong
// question. All combat potions share one 5-minute cooldown and you may pre-pot, so
// the ceiling is 1 + one per 5 minutes of fight.
test('potions are counted against what the fight allowed, not shown as uptime', () => {
  const fight = (sec) => ({ fight: { startTime: 0, endTime: sec * 1000 } });
  const withPots = (sec, auras) => ({ ...fight(sec), buffs: { totalTimeMs: sec * 1000, auras } });

  // an 11-minute fight allows 1 + floor(660/300) = 3 potions
  const mine = withPots(660, [{ name: 'Potion of Recklessness', abilityIcon: 'inv_12_profession_alchemy_voidpotion_red.jpg', uptimeMs: 60000, uses: 2 }]);
  const them = withPots(660, [
    { name: 'Potion of Recklessness', abilityIcon: 'inv_12_profession_alchemy_voidpotion_red.jpg', uptimeMs: 60000, uses: 2 },
    { name: "Light's Potential", abilityIcon: 'inv_12_profession_alchemy_lightpotion_yellow.jpg', uptimeMs: 30000, uses: 1 },
  ]);
  const c = buildConsumables(mine, them, 'TopDK');

  assert.equal(c.potions.mine.used, 2);
  assert.equal(c.potions.mine.max, 3);
  assert.equal(c.potions.mine.missed, 1);
  assert.ok(c.notes.some((n) => /free burst you left unused/.test(n)));

  // This assertion used to say the opposite. "Light's Potential" IS a combat potion
  // — the name test simply couldn't see it, so a paladin who potted three times was
  // told they'd drunk nothing. The icon says potion; that's what we go on now.
  assert.equal(c.potions.them.used, 3, "Light's Potential counts, even though its name never says potion");
  assert.ok(c.potions.them.names.includes("Light's Potential"));
});

// The trap in matching on the icon: a FLASK's art is a potion bottle. The real icon
// for "Flask of the Shattered Sun" is inv_12_profession_alchemy_flask_sindoreipotion_red--
// — it contains "potion". Matching that counted the flask as a drink and reported
// "2 potions used, 1 possible", which is impossible on its face.
test('a flask has potion ART but is not a potion — it must not inflate the potion count', () => {
  const d = {
    fight: { startTime: 0, endTime: 300000 },
    buffs: {
      totalTimeMs: 300000,
      auras: [
        { name: 'Flask of the Shattered Sun', abilityIcon: 'inv_12_profession_alchemy_flask_sindoreipotion_red--.jpg', uptimeMs: 300000, uses: 1 },
        { name: "Light's Potential", abilityIcon: 'inv_12_profession_alchemy_lightpotion_yellow.jpg', uptimeMs: 30000, uses: 1 },
      ],
    },
  };
  const c = buildConsumables(d, d, 'X');
  assert.equal(c.potions.mine.used, 1, 'the flask is a flask; only the potion counts');
  assert.deepEqual(c.potions.mine.names, ["Light's Potential"]);
  assert.equal(rowFor(c, 'flask').mine.name, 'Flask of the Shattered Sun', 'and it still shows as the flask');
});

test('potions: different potion types share one cooldown, so they sum into one count', () => {
  const d = {
    fight: { startTime: 0, endTime: 600000 }, // 10 min -> 1 + 2 = 3 allowed
    buffs: {
      totalTimeMs: 600000,
      auras: [
        { name: 'Potion of Recklessness', uptimeMs: 30000, uses: 2 },
        { name: 'Potion of Unwavering Focus', uptimeMs: 30000, uses: 1 },
      ],
    },
  };
  const c = buildConsumables(d, d, 'X');
  assert.equal(c.potions.mine.used, 3, 'both potion types count against the same cooldown');
  assert.equal(c.potions.mine.max, 3);
  assert.equal(c.potions.mine.missed, 0);
  assert.deepEqual(c.potions.mine.names.sort(), ['Potion of Recklessness', 'Potion of Unwavering Focus']);
});

test('flags a mismatched flask stat', () => {
  const mine = withAuras([{ name: 'Flask of the Shattered Sun', uptimeMs: 100000 }]); // Crit
  const them = withAuras([{ name: 'Flask of the Magisters', uptimeMs: 100000 }]); // Mastery
  const c = buildConsumables(mine, them, 'TopDK');
  assert.ok(c.notes.some((n) => n.includes('Crit') && n.includes('Mastery')));
});

test('flags consumables they brought and you did not', () => {
  const mine = withAuras([{ name: 'Flask of the Magisters', uptimeMs: 100000 }]);
  const them = withAuras([
    { name: 'Flask of the Magisters', uptimeMs: 100000 },
    { name: 'Hearty Well Fed', uptimeMs: 100000 },
  ]);
  const c = buildConsumables(mine, them, 'TopDK');
  assert.equal(rowFor(c, 'food').missing, true);
  assert.equal(rowFor(c, 'flask').missing, false);
  assert.ok(c.notes.some((n) => /free stats/i.test(n)));
});

test('identical consumables produce no notes', () => {
  const a = withAuras([
    { name: 'Flask of the Magisters', uptimeMs: 100000 },
    { name: 'Hearty Well Fed', uptimeMs: 100000 },
  ]);
  assert.deepEqual(buildConsumables(a, a, 'TopDK').notes, []);
});

// Party buffs need NO hardcoded buff list. An aura is someone else's iff the log
// says someone else applied it and you never did.
test('party buffs come from apply/remove sourceIDs, not a hardcoded buff list', () => {
  const auras = [
    { name: 'Blessing of the Bronze', uptimeMs: 95000 }, // given by a groupmate
    { name: 'Battle Shout', uptimeMs: 90000 }, // given by a groupmate
    { name: 'Dark Transformation', uptimeMs: 40000 }, // MY own cooldown
    { name: 'Flask of the Magisters', uptimeMs: 100000 }, // my consumable
  ];
  const buffSources = {
    'Blessing of the Bronze': { self: 0, foreign: 3 },
    'Battle Shout': { self: 0, foreign: 2 },
    'Dark Transformation': { self: 8, foreign: 0 },
    'Flask of the Magisters': { self: 1, foreign: 0 },
  };

  // they got both raid buffs; I only got the Bronze
  const mine = withAuras(auras.filter((a) => a.name !== 'Battle Shout'));
  const them = withAuras(auras);
  const c = buildConsumables(mine, them, 'TopDK', buffSources);

  assert.deepEqual(c.partyBuffs.mine.map((b) => b.name), ['Blessing of the Bronze']);
  assert.deepEqual(c.partyBuffs.them.map((b) => b.name), ['Blessing of the Bronze', 'Battle Shout']);
  // the finding: their group had a buff yours didn't — a real DPS gap that is NOT rotation
  assert.deepEqual(c.partyBuffs.theyHadIDidnt.map((b) => b.name), ['Battle Shout']);

  // my own cooldown is not a "party buff", and neither is my flask
  const allParty = [...c.partyBuffs.mine, ...c.partyBuffs.them].map((b) => b.name);
  assert.ok(!allParty.includes('Dark Transformation'));
  assert.ok(!allParty.includes('Flask of the Magisters'));
});

// A real run came back with 23 "party buffs" — Blessing of the Bronze at 99%
// alongside Regrowth at 0% and Enveloping Mist at 1%. A groupmate's stray heal tick
// is not a buff you plan around. Filtered by UPTIME, not by a list of buff names,
// so it keeps working for buffs that don't exist yet.
test('a stray heal tick from a groupmate is not a "party buff"', () => {
  const auras = [
    { name: 'Blessing of the Bronze', uptimeMs: 99000 }, // 99% — a real raid buff
    { name: 'Ebon Might', uptimeMs: 81000 }, // 81% — an Augmentation buff
    { name: 'Regrowth', uptimeMs: 400 }, // 0% — a stray HoT tick
    { name: 'Enveloping Mist', uptimeMs: 1000 }, // 1% — ditto
  ];
  const buffSources = Object.fromEntries(auras.map((a) => [a.name, { self: 0, foreign: 2 }]));
  const c = buildConsumables(withAuras(auras), withAuras(auras), 'X', buffSources);
  assert.deepEqual(c.partyBuffs.mine.map((b) => b.name), ['Blessing of the Bronze', 'Ebon Might']);
});

test('no buffSources: consumables still work, party buffs are simply empty', () => {
  const a = withAuras([{ name: 'Flask of the Magisters', uptimeMs: 100000 }]);
  const c = buildConsumables(a, a, 'X');
  assert.equal(rowFor(c, 'flask').mine.name, 'Flask of the Magisters');
  assert.deepEqual(c.partyBuffs.mine, []);
  assert.deepEqual(c.partyBuffs.theyHadIDidnt, []);
});
