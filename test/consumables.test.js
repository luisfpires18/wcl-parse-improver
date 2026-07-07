import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsumables } from '../server/analysis/compare.js';

const withAuras = (auras) => ({ buffs: { totalTimeMs: 100000, auras } });

test('buildConsumables maps flask names to stats and flags a mismatch', () => {
  const mine = withAuras([
    { name: 'Flask of the Shattered Sun', uptimeMs: 100000 }, // crit
    { name: 'Hearty Well Fed', uptimeMs: 100000 },
    { name: 'Rune Mastery', uptimeMs: 50000 }, // class buff, not a consumable — ignored
  ]);
  const them = withAuras([
    { name: 'Flask of the Magisters', uptimeMs: 100000 }, // mastery
    { name: 'Hearty Well Fed', uptimeMs: 100000 },
  ]);
  const c = buildConsumables(mine, them, 'TopDK');
  assert.equal(c.flask.mine.name, 'Flask of the Shattered Sun');
  assert.equal(c.flask.myStat, 'Crit');
  assert.equal(c.flask.them.name, 'Flask of the Magisters');
  assert.equal(c.flask.theirStat, 'Mastery');
  assert.equal(c.flask.mine.pct, 100);
  assert.ok(c.food.mine && c.food.them);
  assert.ok(c.flaskNote.includes('Crit') && c.flaskNote.includes('Mastery'));
});

test('buildConsumables flags a missing flask', () => {
  const mine = withAuras([{ name: 'Hearty Well Fed', uptimeMs: 100000 }]); // no flask
  const them = withAuras([{ name: 'Flask of the Magisters', uptimeMs: 100000 }]);
  const c = buildConsumables(mine, them, 'TopDK');
  assert.equal(c.flask.mine, null);
  assert.ok(c.flaskNote.includes('no flask'));
});

test('buildConsumables: same flask, no note', () => {
  const a = withAuras([{ name: 'Flask of the Magisters', uptimeMs: 100000 }]);
  const c = buildConsumables(a, a, 'TopDK');
  assert.equal(c.flaskNote, null);
  assert.equal(c.flask.myStat, 'Mastery');
});

test('buildConsumables: unmapped flask has no stat but still shows', () => {
  const mine = withAuras([{ name: 'Flask of Mystery', uptimeMs: 100000 }]);
  const them = withAuras([{ name: 'Flask of Mystery', uptimeMs: 100000 }]);
  const c = buildConsumables(mine, them, 'X');
  assert.equal(c.flask.mine.name, 'Flask of Mystery');
  assert.equal(c.flask.myStat, null);
  assert.equal(c.flaskNote, null); // both same, no stats to differ
});
