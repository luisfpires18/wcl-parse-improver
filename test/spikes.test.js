import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpikes } from '../server/analysis/spikes.js';

// Build a 60s run: one "Boom" cooldown at 5s (burst) + one "Interrupt" at 30s
// (utility, no damage lift). Series spikes at t=10-15s (after Boom), flat else.
function makeSeries(spikeBins, high, low, nBins = 12, binMs = 5000) {
  const points = [];
  for (let i = 0; i < nBins; i++) points.push({ tSec: i * (binMs / 1000), dps: spikeBins.includes(i) ? high : low });
  return { binMs, durationMs: nBins * binMs, points, totalDamage: points.reduce((s, p) => s + p.dps * (binMs / 1000), 0) };
}
function makeDetail(castEvents) {
  return {
    fight: { startTime: 0, endTime: 60000, keystoneTime: 60000, keystoneLevel: 20 },
    casts: { totalTimeMs: 60000, totalCasts: 2, abilities: [
      { name: 'Boom', guid: 1, casts: 1 },
      { name: 'Interrupt', guid: 2, casts: 1 },
    ] },
    buffs: { totalTimeMs: 60000, auras: [] },
    damage: { totalDamage: 0, abilities: [] },
    deaths: { deaths: [] },
    castEvents,
    resourceEvents: [],
  };
}

test('analyzeSpikes: identifies Boom as the burst cooldown I missed at the spike', () => {
  const otherDetail = makeDetail([
    { timestamp: 5000, abilityGameID: 1 }, // Boom @5s -> drives the 10-15s spike
    { timestamp: 30000, abilityGameID: 2 }, // Interrupt @30s -> no lift
  ]);
  const mineDetail = makeDetail([{ timestamp: 30000, abilityGameID: 2 }]); // I only interrupt, never Boom
  const otherSeries = makeSeries([2, 3], 100000, 1000);
  const mineSeries = makeSeries([], 100000, 1000);

  const sa = analyzeSpikes({ mineDetail, otherDetail, mineSeries, otherSeries });
  assert.ok(sa);
  assert.ok(sa.spikes.length >= 1);
  const first = sa.spikes[0];
  assert.ok(first.theirDps > first.myDps);
  assert.deepEqual(first.missing, ['Boom']); // Boom flagged, Interrupt excluded (no lift)
  assert.ok(first.note.includes('Boom'));
  assert.ok(!first.note.includes('Interrupt'));
  assert.ok(sa.headline.includes('Boom'));
  assert.equal(sa.culprits[0].name, 'Boom');
});

test('analyzeSpikes: when I fire the same burst cooldown, it is not a "missing" gap', () => {
  const otherDetail = makeDetail([{ timestamp: 5000, abilityGameID: 1 }]);
  const mineDetail = makeDetail([{ timestamp: 5000, abilityGameID: 1 }]); // I also Boom at 5s
  const otherSeries = makeSeries([2, 3], 100000, 1000);
  const mineSeries = makeSeries([2, 3], 60000, 1000); // I spike too, just lower

  const sa = analyzeSpikes({ mineDetail, otherDetail, mineSeries, otherSeries });
  const first = sa.spikes[0];
  assert.deepEqual(first.missing, []);
  assert.ok(first.note.includes('same cooldowns') || first.note.includes('target count'));
});

test('analyzeSpikes: safe on empty series', () => {
  assert.equal(analyzeSpikes({ mineDetail: makeDetail([]), otherDetail: makeDetail([]), mineSeries: { points: [] }, otherSeries: { points: [] } }), null);
});
