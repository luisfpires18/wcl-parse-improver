import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binDamageEvents, parseDamageTable } from '../server/parse/tables.js';
import { buildAbilityTable, buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pit = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));

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

// There is one opponent now, chosen server-side (closest route to mine, or whoever
// you pick from the dropdown). pickSimilarIndex — which scored a 5-7 player cohort
// to find the most-similar run — is gone with the cohort itself.
test('the picker offers top players and similar parses, without duplicating between them', () => {
  const report = buildReport(pit);
  const { top, similar, selected } = report.compare;
  assert.ok(top.length > 0);
  assert.ok(selected);

  const topNames = new Set(top.map((p) => p.name));
  for (const p of similar) {
    assert.ok(!topNames.has(p.name), `${p.name} must not be in both groups`);
    assert.ok(p.matchPct >= 0 && p.matchPct <= 100);
  }
  // similar parses are ranked by how close their route is to mine
  for (let i = 1; i < similar.length; i++) assert.ok(similar[i - 1].matchPct >= similar[i].matchPct);
});

// One table, casts AND damage, 1:1 — replacing a "casts vs cohort median" table and
// a separate "damage done" table that listed the same abilities twice.
test('buildAbilityTable joins casts + damage against the one opponent', () => {
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
  const t = buildAbilityTable(mineDetail, otherDetail, 'Them');
  assert.equal(t.otherLabel, 'Them');

  const big = t.rows.find((r) => r.name === 'Big');
  assert.equal(big.myCasts, 4);
  assert.equal(big.theirCasts, 6);
  assert.equal(big.castDiff, -2, 'they pressed it twice more than me');
  assert.equal(big.myDps, Math.round(2000 / 60));
  assert.equal(big.theirAmount, 2500);

  const small = t.rows.find((r) => r.name === 'Small');
  assert.equal(small.theirAmount, 0, 'they never used it');
  assert.equal(small.theirCasts, 0);
});
