import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotationComposition, castOrder, bigramMatch } from '../server/analysis/spikes.js';

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


test('rotationComposition: near-identical casts score high similarity (same rotation, confirmed)', () => {
  const ev = (n) => Array.from({ length: n }, (_, i) => ({ timestamp: 1000 + i * 500, abilityGameID: 1 }));
  const mine = makeDetail([...ev(10), { timestamp: 9000, abilityGameID: 2 }]); // 10 Scourge + 1 Army
  const other = makeDetail([...ev(11), { timestamp: 9000, abilityGameID: 2 }]); // 11 Scourge + 1 Army
  const rc = rotationComposition(mine, other);
  assert.ok(rc.similarityPct >= 95, `expected high composition similarity, got ${rc.similarityPct}`);
  // near-identical sequence too (both spam Scourge then Army) -> same rotation
  assert.ok(rc.sequencePct >= 85, `expected high sequence similarity, got ${rc.sequencePct}`);
  assert.equal(rc.sameRotation, true);
  assert.ok(rc.summary.includes('spell mix') && rc.summary.includes('cast order'));
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

test('bigramMatch: order matters — same counts, different order scores well below 100', () => {
  // identical multiset {A,A,B,B} but opposite sequencing
  const a = ['A', 'B', 'A', 'B', 'A', 'B']; // alternating
  const b = ['A', 'A', 'A', 'B', 'B', 'B']; // clumped
  const sim = bigramMatch(a, b);
  assert.ok(sim < 60, `expected low order similarity, got ${sim}`);
  // identical sequence = 100
  assert.equal(Math.round(bigramMatch(a, a)), 100);
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
  assert.ok(rc.summary.includes('spell mix') && rc.summary.includes('cast order'));
});

test('rotationComposition: divergent casts score low similarity (different rotation)', () => {
  // mine: all Scourge; theirs: all Mind Freeze (orthogonal vectors)
  const mine = makeDetail(Array.from({ length: 10 }, () => ({ timestamp: 1000, abilityGameID: 1 })));
  const other = makeDetail(Array.from({ length: 10 }, () => ({ timestamp: 1000, abilityGameID: 3 })));
  const rc = rotationComposition(mine, other);
  assert.ok(rc.similarityPct < 88, `expected low similarity, got ${rc.similarityPct}`);
  assert.equal(rc.sameRotation, false);
});
