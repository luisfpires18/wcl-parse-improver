import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpikes, rotationComposition, castOrder, bigramCosine } from '../server/analysis/spikes.js';

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

test('rotationComposition: near-identical casts score high similarity (same rotation, confirmed)', () => {
  const ev = (n) => Array.from({ length: n }, (_, i) => ({ timestamp: 1000 + i * 500, abilityGameID: 1 }));
  const mine = makeDetail([...ev(10), { timestamp: 9000, abilityGameID: 2 }]); // 10 Scourge + 1 Army
  const other = makeDetail([...ev(11), { timestamp: 9000, abilityGameID: 2 }]); // 11 Scourge + 1 Army
  const rc = rotationComposition(mine, other);
  assert.ok(rc.similarityPct >= 95, `expected high composition similarity, got ${rc.similarityPct}`);
  // near-identical sequence too (both spam Scourge then Army) -> same rotation
  assert.ok(rc.sequencePct >= 85, `expected high sequence similarity, got ${rc.sequencePct}`);
  assert.equal(rc.sameRotation, true);
  assert.ok(rc.summary.includes('composition') && rc.summary.includes('sequence'));
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

test('bigramCosine: order matters — same counts, different order scores below 1', () => {
  // identical multiset {A,A,B,B} but opposite sequencing
  const a = ['A', 'B', 'A', 'B', 'A', 'B']; // alternating
  const b = ['A', 'A', 'A', 'B', 'B', 'B']; // clumped
  const sim = bigramCosine(a, b);
  assert.ok(sim < 0.6, `expected low order similarity, got ${sim}`);
  // identical sequence = 1
  assert.equal(Math.round(bigramCosine(a, a) * 100), 100);
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
  assert.ok(rc.summary.includes('composition') && rc.summary.includes('sequence'));
});

test('rotationComposition: divergent casts score low similarity (different rotation)', () => {
  // mine: all Scourge; theirs: all Mind Freeze (orthogonal vectors)
  const mine = makeDetail(Array.from({ length: 10 }, () => ({ timestamp: 1000, abilityGameID: 1 })));
  const other = makeDetail(Array.from({ length: 10 }, () => ({ timestamp: 1000, abilityGameID: 3 })));
  const rc = rotationComposition(mine, other);
  assert.ok(rc.similarityPct < 88, `expected low similarity, got ${rc.similarityPct}`);
  assert.equal(rc.sameRotation, false);
});
