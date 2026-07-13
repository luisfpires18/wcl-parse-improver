import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumGraphSeries, buildHealthCurve, timeAtHealthPct, resolveBossActor } from '../server/parse/bossHealth.js';
import { truncateSeries, truncateDetail } from '../server/analysis/truncate.js';

// two damage sources, 4 bins of 1000ms each, 250 damage per source per bin
const graph = {
  data: {
    series: [
      { name: 'A', pointStart: 0, pointInterval: 1000, data: [250, 250, 250, 250] },
      { name: 'B', pointStart: 0, pointInterval: 1000, data: [250, 250, 250, 250] },
    ],
  },
};

test('sumGraphSeries: adds every source series bin-by-bin', () => {
  const s = sumGraphSeries(graph);
  assert.deepEqual(s.bins, [500, 500, 500, 500]);
  assert.equal(s.pointInterval, 1000);
  assert.equal(s.pointStart, 0);
});

test('buildHealthCurve: a KILL runs 100% down to ~0%', () => {
  const c = buildHealthCurve({ summed: sumGraphSeries(graph), fightStart: 0, pctRemaining: 0 });
  assert.equal(c.points[0].pct, 100);
  assert.equal(c.points.at(-1).pct, 0);
  assert.equal(c.maxHP, 2000); // 2000 damage dealt == 100% of HP
});

test('buildHealthCurve: a WIPE is calibrated by fightPercentage — ends exactly at the % left', () => {
  // same 2000 damage, but the boss still had 60% left -> that 2000 was only 40% of its HP
  const c = buildHealthCurve({ summed: sumGraphSeries(graph), fightStart: 0, pctRemaining: 60 });
  assert.equal(c.points[0].pct, 100);
  assert.equal(Math.round(c.points.at(-1).pct), 60);
  assert.equal(c.maxHP, 5000); // 2000 / 0.4
  assert.equal(c.endPct, 60);
});

test('timeAtHealthPct: interpolates inside the bin the boss crosses in', () => {
  const c = buildHealthCurve({ summed: sumGraphSeries(graph), fightStart: 0, pctRemaining: 0 });
  // linear 100 -> 0 over 4s: 75% at 1s, 50% at 2s, 60% at 1.6s (interpolated)
  assert.equal(timeAtHealthPct(c, 75), 1);
  assert.equal(timeAtHealthPct(c, 50), 2);
  assert.ok(Math.abs(timeAtHealthPct(c, 60) - 1.6) < 0.01, 'should interpolate mid-bin');
  assert.equal(timeAtHealthPct(c, 0), 4);
});

test('timeAtHealthPct: null when the boss never got that low (a wipe)', () => {
  const wipe = buildHealthCurve({ summed: sumGraphSeries(graph), fightStart: 0, pctRemaining: 60 });
  assert.equal(timeAtHealthPct(wipe, 20), null); // never got below 60%
  assert.ok(timeAtHealthPct(wipe, 80) != null);
});

test('resolveBossActor: matches the NPC named inside the fight name, not an add', () => {
  const npcs = [
    { id: 66, name: 'Colossal Horror' },
    { id: 21, name: 'Chimaerus' },
    { id: 68, name: 'Swarming Shade' },
  ];
  assert.equal(resolveBossActor(npcs, 'Chimaerus, the Undreamt God').id, 21);
});

// --- wipe-window truncation ---

test('truncateSeries: drops points past the cutoff and shortens the duration', () => {
  const s = { points: [{ tSec: 0, dps: 1 }, { tSec: 5, dps: 2 }, { tSec: 10, dps: 3 }], durationMs: 10000 };
  const t = truncateSeries(s, 5);
  assert.deepEqual(t.points.map((p) => p.tSec), [0, 5]);
  assert.equal(t.durationMs, 5000);
});

test('truncateSeries: no cutoff (a kill) leaves the series untouched', () => {
  const s = { points: [{ tSec: 0, dps: 1 }], durationMs: 10000 };
  assert.equal(truncateSeries(s, null), s);
});

test('truncateDetail: rebuilds cast counts + active time from the surviving events', () => {
  const detail = {
    fight: { startTime: 1000, endTime: 21000 },
    casts: {
      totalTimeMs: 20000,
      totalCasts: 4,
      abilities: [
        { name: 'Scourge Strike', guid: 1, casts: 3 },
        { name: 'Army of the Dead', guid: 2, casts: 1 },
      ],
    },
    // fight-relative: 1s, 3s, 15s (Scourge) and 18s (Army)
    castEvents: [
      { timestamp: 2000, abilityGameID: 1 },
      { timestamp: 4000, abilityGameID: 1 },
      { timestamp: 16000, abilityGameID: 1 },
      { timestamp: 19000, abilityGameID: 2 },
    ],
    deaths: { deaths: [{ timestamp: 19500 }] },
    damage: { totalDamage: 999, abilities: [] },
  };
  const t = truncateDetail(detail, 10); // keep only the first 10s

  assert.equal(t.castEvents.length, 2, 'only the two casts inside the window survive');
  assert.equal(t.casts.totalCasts, 2);
  assert.equal(t.casts.totalTimeMs, 10000, 'active time must shrink to the window, not stay 20s');
  const ss = t.casts.abilities.find((a) => a.name === 'Scourge Strike');
  assert.equal(ss.casts, 2, 'cast count rebuilt from events, not carried over from the full fight');
  assert.equal(t.casts.abilities.find((a) => a.name === 'Army of the Dead'), undefined, 'ability cast after the cutoff is dropped');
  assert.equal(t.fight.endTime, 11000);
  assert.equal(t.deaths.deaths.length, 0, 'a death after the cutoff is outside the window');
});
