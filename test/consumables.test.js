import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsumables } from '../server/analysis/consumables.js';

const withAuras = (auras) => ({ buffs: { totalTimeMs: 100000, auras } });
const rowFor = (c, key) => c.rows.find((r) => r.key === key);

test('detects all five consumable kinds, not just flask and food', () => {
  const mine = withAuras([
    { name: 'Flask of the Shattered Sun', uptimeMs: 100000 },
    { name: 'Hearty Well Fed', uptimeMs: 100000 },
    { name: 'Algari Mana Oil', uptimeMs: 90000 },
    { name: 'Crystallized Augment Rune', uptimeMs: 80000 },
    { name: 'Potion of Unwavering Focus', uptimeMs: 3000 },
    { name: 'Rune Mastery', uptimeMs: 50000 }, // a CLASS buff, not a consumable
  ]);
  const c = buildConsumables(mine, withAuras([]), 'TopDK');

  assert.equal(rowFor(c, 'flask').mine.name, 'Flask of the Shattered Sun');
  assert.equal(rowFor(c, 'food').mine.name, 'Hearty Well Fed');
  assert.equal(rowFor(c, 'oil').mine.name, 'Algari Mana Oil');
  assert.equal(rowFor(c, 'rune').mine.name, 'Crystallized Augment Rune');
  assert.equal(rowFor(c, 'potion').mine.name, 'Potion of Unwavering Focus');

  // "Rune Mastery" is a Death Knight proc — it must not be mistaken for an
  // augment rune just because its name contains "Rune"
  assert.notEqual(rowFor(c, 'rune').mine.name, 'Rune Mastery');
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
