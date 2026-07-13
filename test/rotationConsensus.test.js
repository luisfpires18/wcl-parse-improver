import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openerConsensus, cooldownUsage } from '../server/analysis/rotationConsensus.js';

const seq = (...names) => names.map((n, i) => ({ tSec: i, name: n, kind: n === 'Meta' ? 'amp' : 'damage' }));

test('openerConsensus: the shared opener emerges, and the players who disagree are shown', () => {
  const players = [
    seq('Sigil', 'Meta', 'Blade'),
    seq('Sigil', 'Meta', 'Blade'),
    seq('Sigil', 'Meta', 'Chaos'),
    seq('Immolation', 'Meta', 'Blade'), // opens differently
  ];
  const opener = openerConsensus(players, 3);

  assert.equal(opener[0].name, 'Sigil');
  assert.equal(opener[0].count, 3);
  assert.equal(opener[0].of, 4);
  assert.equal(opener[0].agreementPct, 75);
  // the odd one out is reported, not swallowed
  assert.deepEqual(opener[0].alts, [{ name: 'Immolation', count: 1 }]);

  // unanimous slot
  assert.equal(opener[1].name, 'Meta');
  assert.equal(opener[1].agreementPct, 100);
  assert.equal(opener[1].kind, 'amp');
  assert.deepEqual(opener[1].alts, []);

  // a genuinely split slot must LOOK split
  assert.equal(opener[2].name, 'Blade');
  assert.equal(opener[2].agreementPct, 75);
});

test('openerConsensus: a slot only counts the players who actually got that deep', () => {
  const players = [seq('A', 'B', 'C', 'D'), seq('A', 'B'), seq('A', 'B')];
  const opener = openerConsensus(players, 6);
  assert.equal(opener[1].of, 3);
  assert.equal(opener[2].of, 1, 'only one player has a 3rd cast — say so rather than implying 1/3 agreement');
  assert.equal(opener[2].agreementPct, 100);
  assert.equal(opener.length, 4, 'stops at the longest sequence, never pads empty slots');
});

test('openerConsensus: no sequences => no rows (not a fabricated opener)', () => {
  assert.deepEqual(openerConsensus([]), []);
  assert.deepEqual(openerConsensus([[], []]), []);
});

test('cooldownUsage: how many of them press it, when first, how often', () => {
  const amp = (name, tSec) => ({ name, tSec, kind: 'amp' });
  const filler = (tSec) => ({ name: 'Chaos Strike', tSec, kind: 'damage' });
  const players = [
    { name: 'A', castOrder: [amp('Potion', 0.1), filler(1), amp('The Hunt', 5), amp('The Hunt', 100)] },
    { name: 'B', castOrder: [amp('Potion', 0.2), amp('The Hunt', 9), amp('The Hunt', 110), amp('The Hunt', 200)] },
    { name: 'C', castOrder: [amp('The Hunt', 7), filler(8)] }, // no potion
    { name: 'D', castOrder: [amp('The Hunt', 7)] },
  ];
  const cds = cooldownUsage(players);

  const hunt = cds.find((c) => c.name === 'The Hunt');
  assert.equal(hunt.players, 4);
  assert.equal(hunt.of, 4);
  assert.equal(hunt.usedByPct, 100);
  assert.equal(hunt.medianFirstSec, 7, 'median of [5,9,7,7]');
  assert.equal(hunt.medianUses, 2, 'median of [2,3,1,1] = 1.5 -> 2');

  const pot = cds.find((c) => c.name === 'Potion');
  assert.equal(pot.players, 2);
  assert.equal(pot.usedByPct, 50, 'half the field skipped it — that IS the finding');
  assert.equal(pot.medianFirstSec, 0);

  // most-used first: The Hunt (4/4) before Potion (2/4)
  assert.deepEqual(cds.map((c) => c.name), ['The Hunt', 'Potion']);
  // fillers are never listed as cooldowns
  assert.ok(!cds.some((c) => c.name === 'Chaos Strike'));
});

test('cooldownUsage: one player pressing a cooldown twice is still ONE player', () => {
  const players = [{ name: 'A', castOrder: [{ name: 'Meta', tSec: 3, kind: 'amp' }, { name: 'Meta', tSec: 90, kind: 'amp' }] }];
  const [meta] = cooldownUsage(players);
  assert.equal(meta.players, 1);
  assert.equal(meta.medianUses, 2);
  assert.equal(meta.usedByPct, 100);
});
