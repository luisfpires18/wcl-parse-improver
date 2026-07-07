import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binDamageEvents, parseDamageTable } from '../server/parse/tables.js';
import { pickSimilarIndex, buildDamageDoneTable } from '../server/analysis/compare.js';

test('binDamageEvents buckets amounts into per-bin DPS', () => {
  const fight = { startTime: 1000, endTime: 1000 + 15000 }; // 15s, 3 bins of 5s
  const pages = [
    {
      data: [
        { type: 'damage', timestamp: 1000, amount: 5000 }, // bin 0
        { type: 'damage', timestamp: 3000, amount: 5000 }, // bin 0
        { type: 'damage', timestamp: 6000, amount: 10000 }, // bin 1 (t=5000)
        { type: 'damage', timestamp: 14999, amount: 5000 }, // bin 2 (t=13999)
        { type: 'begincast', timestamp: 2000, amount: 999 }, // ignored (not damage)
        { type: 'damage', timestamp: 2000, amount: 0 }, // ignored (0 amount)
      ],
    },
  ];
  const { points, totalDamage, binMs } = binDamageEvents(pages, fight, 5000);
  assert.equal(binMs, 5000);
  assert.equal(totalDamage, 25000);
  assert.equal(points.length, 3);
  assert.deepEqual(points[0], { tSec: 0, dps: 2000 }); // 10000 dmg / 5s
  assert.deepEqual(points[1], { tSec: 5, dps: 2000 }); // 10000 / 5s
  assert.deepEqual(points[2], { tSec: 10, dps: 1000 }); // 5000 / 5s
});

test('binDamageEvents handles degenerate fights and empty pages', () => {
  assert.deepEqual(binDamageEvents([], { startTime: 0, endTime: 0 }).points, []);
  assert.deepEqual(binDamageEvents([], null).points, []);
  assert.deepEqual(binDamageEvents([{ data: [] }], { startTime: 0, endTime: 10000 }).points.length, 2);
});

test('binDamageEvents clamps an end-boundary event into the last bin', () => {
  const { points } = binDamageEvents(
    [{ data: [{ type: 'damage', timestamp: 10000, amount: 1000 }] }],
    { startTime: 0, endTime: 10000 },
    5000
  );
  assert.equal(points.length, 2);
  assert.equal(points[1].dps, 200); // 1000 / 5s, clamped into last bin
});

test('parseDamageTable keeps hitCount as hits', () => {
  const table = {
    data: {
      totalTime: 60000,
      entries: [{ name: 'X', guid: 1, total: 1000, hitCount: 42, composite: false }],
    },
  };
  const parsed = parseDamageTable(table);
  assert.equal(parsed.abilities[0].hits, 42);
});

test('pickSimilarIndex picks the closest-duration run at the same level', () => {
  const cohort = [
    { detail: { fight: { keystoneTime: 1400000, keystoneLevel: 21 } } }, // 23:20 speedrun
    { detail: { fight: { keystoneTime: 1580000, keystoneLevel: 21 } } }, // 26:20 — closest to mine
    { detail: { fight: { keystoneTime: 1600000, keystoneLevel: 21 } } },
  ];
  assert.equal(pickSimilarIndex(cohort, 1586000, 21), 1);
});

test('pickSimilarIndex prefers same level over closer duration', () => {
  const cohort = [
    { detail: { fight: { keystoneTime: 1585000, keystoneLevel: 22 } } }, // closer time but wrong level
    { detail: { fight: { keystoneTime: 1500000, keystoneLevel: 21 } } }, // farther time, right level
  ];
  assert.equal(pickSimilarIndex(cohort, 1586000, 21), 1);
});

test('pickSimilarIndex is safe on empty/unknown input', () => {
  assert.equal(pickSimilarIndex([], 1000, 21), 0);
  assert.equal(pickSimilarIndex([{ detail: {} }], null, 21), 0);
});

test('buildDamageDoneTable joins damage + casts, sorted by my damage', () => {
  const mineDetail = {
    fight: { keystoneTime: 60000 },
    player: { name: 'Me' },
    damage: { totalDamage: 3000, abilities: [
      { name: 'Big', total: 2000, hits: 10 },
      { name: 'Small', total: 1000, hits: 5 },
    ] },
    casts: { abilities: [{ name: 'Big', casts: 4 }, { name: 'Small', casts: 8 }] },
  };
  const otherDetail = {
    fight: { keystoneTime: 60000 },
    player: { name: 'Them' },
    damage: { totalDamage: 2500, abilities: [{ name: 'Big', total: 2500, hits: 12 }] },
    casts: { abilities: [{ name: 'Big', casts: 6 }] },
  };
  const t = buildDamageDoneTable(mineDetail, otherDetail);
  assert.equal(t.otherLabel, 'Them');
  assert.equal(t.rows[0].name, 'Big'); // sorted by my damage
  assert.equal(t.rows[0].myCasts, 4);
  assert.equal(t.rows[0].myDps, Math.round(2000 / 60)); // 60000ms = 60s, rounded
  assert.equal(t.rows[0].theirHits, 12);
  assert.equal(t.rows[1].name, 'Small');
  assert.equal(t.rows[1].theirAmount, 0); // they never used it
});
