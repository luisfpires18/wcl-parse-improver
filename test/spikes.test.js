import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpikes } from '../server/analysis/spikes.js';

function makeSeries(spikeBins, high, low, nBins = 12, binMs = 5000) {
  const points = [];
  for (let i = 0; i < nBins; i++) points.push({ tSec: i * (binMs / 1000), dps: spikeBins.includes(i) ? high : low });
  return { binMs, durationMs: nBins * binMs, points, totalDamage: points.reduce((s, p) => s + p.dps * (binMs / 1000), 0) };
}
// abilities: Scourge Strike (damage), Army of the Dead (amplifier), Mind Freeze (utility)
function makeDetail(castEvents, damageAbilities = [{ name: 'Scourge Strike', total: 1000, hits: 1 }]) {
  return {
    fight: { startTime: 0, endTime: 60000, keystoneTime: 60000, keystoneLevel: 20 },
    casts: { totalTimeMs: 60000, totalCasts: castEvents.length, abilities: [
      { name: 'Scourge Strike', guid: 1, casts: 1 },
      { name: 'Army of the Dead', guid: 2, casts: 1 },
      { name: 'Mind Freeze', guid: 3, casts: 1 },
    ] },
    buffs: { totalTimeMs: 60000, auras: [] },
    damage: { totalDamage: 1000, abilities: damageAbilities },
    deaths: { deaths: [] },
    castEvents,
    resourceEvents: [],
  };
}

test('analyzeSpikes: reports the burst cast-count gap (their damage casts vs mine)', () => {
  // theirs: 4 Scourge Strikes in the burst window; mine: 1
  const otherDetail = makeDetail([
    { timestamp: 26000, abilityGameID: 2 }, // Army @26s
    { timestamp: 27000, abilityGameID: 1 },
    { timestamp: 28000, abilityGameID: 1 },
    { timestamp: 29000, abilityGameID: 1 },
    { timestamp: 30000, abilityGameID: 1 },
  ]);
  const mineDetail = makeDetail([
    { timestamp: 26000, abilityGameID: 2 }, // Army @26s (same amp)
    { timestamp: 30000, abilityGameID: 1 }, // only 1 Scourge
  ]);
  const otherSeries = makeSeries([5, 6], 100000, 1000); // spike at 25-30s
  const mineSeries = makeSeries([5, 6], 70000, 1000);

  const sa = analyzeSpikes({ mineDetail, otherDetail, mineSeries, otherSeries });
  assert.ok(sa && sa.windows.length >= 1);
  const w = sa.windows[0];
  const ss = w.castDiffs.find((d) => d.name === 'Scourge Strike');
  assert.equal(ss.them, 4);
  assert.equal(ss.mine, 1);
  assert.ok(w.theirCastTotal > w.myCastTotal);
  // amplifiers: Army detected, Mind Freeze never (utility, not in the named set)
  assert.ok(w.theirAmps.includes('Army of the Dead'));
  assert.ok(!w.theirAmps.includes('Mind Freeze'));
});

test('analyzeSpikes: utility casts never appear as amplifiers', () => {
  const otherDetail = makeDetail([
    { timestamp: 26000, abilityGameID: 2 }, // Army
    { timestamp: 27000, abilityGameID: 3 }, // Mind Freeze (utility) during burst
    { timestamp: 28000, abilityGameID: 1 },
  ]);
  const mineDetail = makeDetail([{ timestamp: 28000, abilityGameID: 1 }]);
  const sa = analyzeSpikes({ mineDetail, otherDetail, mineSeries: makeSeries([5, 6], 60000, 1000), otherSeries: makeSeries([5, 6], 100000, 1000) });
  for (const w of sa.windows) {
    assert.ok(!w.theirAmps.includes('Mind Freeze'));
    assert.ok(!w.myAmps.includes('Mind Freeze'));
    assert.ok(!w.note.includes('Mind Freeze'));
  }
});

test('analyzeSpikes: flags a late engagement start (opener note)', () => {
  // theirs: first damage cast at 8s; mine: first damage cast at 25s
  const otherDetail = makeDetail([{ timestamp: 8000, abilityGameID: 1 }, { timestamp: 27000, abilityGameID: 1 }]);
  const mineDetail = makeDetail([{ timestamp: 25000, abilityGameID: 1 }]);
  const sa = analyzeSpikes({ mineDetail, otherDetail, mineSeries: makeSeries([5], 50000, 1000), otherSeries: makeSeries([5], 100000, 1000) });
  assert.ok(sa.openerNote);
  assert.ok(sa.openerNote.includes('0:25'));
  assert.ok(sa.openerNote.includes('0:08'));
  assert.ok(sa.headline.includes('engage pulls later'));
});

test('analyzeSpikes: safe on empty series', () => {
  assert.equal(analyzeSpikes({ mineDetail: makeDetail([]), otherDetail: makeDetail([]), mineSeries: { points: [] }, otherSeries: { points: [] } }), null);
});
