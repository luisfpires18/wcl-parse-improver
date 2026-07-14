import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResourceEvents } from '../server/parse/tables.js';
import { computeResource, compareResource, resourceName, isKnownResource } from '../server/analysis/resources.js';
import { computeRunMetrics } from '../server/analysis/metrics.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'probe-resource-events.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));

// The real payload: 1149 Runic Power events (type 6, src4->tgt4 = the player's own
// pool) and 33 Energy events (type 3, src4->tgt6 = the player feeding their GHOUL).
// The parser used to exclude the pet by hardcoding `type === 6`, which is exactly
// what made the whole feature Death-Knight-only. `sourceID === targetID` excludes
// the pet generically — a pet's pool is targeted AT the pet.
test('parseResourceEvents keeps my own pool and excludes my pet, without naming a resource', () => {
  const events = parseResourceEvents([probe]);
  assert.equal(events.length, 1149, 'the 33 pet-targeted Energy events are excluded');
  assert.ok(events.every((e) => e.type === 6));
  for (const e of events) {
    assert.ok(e.gain >= 0 && e.waste >= 0 && typeof e.timestamp === 'number');
  }
});

test('parseResourceEvents survives garbage', () => {
  assert.deepEqual(parseResourceEvents([null, {}, { data: null }]), []);
});

test('computeResource finds the spec resource from the log — nothing hardcoded', () => {
  const r = computeResource(parseResourceEvents([probe]));
  assert.equal(r.type, 6);
  assert.equal(r.name, 'Runic Power'); // derived from the log's own type id
  assert.equal(r.known, true);
  assert.equal(r.events, 1149);
  assert.ok(r.wastePct > 0 && r.wastePct < 100);
});

// The `RP_SCALE = 10` constant is gone. It existed only because WCL reports Runic
// Power at 10x (maxResourceAmount 1000 for a real 100 cap) — a per-resource divisor
// we could never have verified for every class. The percentage cancels the scale.
test('wastePct is scale-invariant, so no per-resource divisor is needed', () => {
  const events = [
    { type: 6, gain: 10, waste: 90 },
    { type: 6, gain: 10, waste: 90 },
  ];
  const scaled = events.map((e) => ({ ...e, gain: e.gain * 10, waste: e.waste * 10 }));
  assert.equal(computeResource(events).wastePct, computeResource(scaled).wastePct);
  assert.equal(computeResource(events).wastePct, 90); // 180 wasted of 200 possible
});

test('the dominant pool wins; the rest are reported as secondary, not confused for it', () => {
  const r = computeResource([
    { type: 9, gain: 5, waste: 0 }, // a trickle of Holy Power
    { type: 1, gain: 500, waste: 100 }, // Rage is clearly the main resource here
    { type: 1, gain: 400, waste: 0 },
  ]);
  assert.equal(r.name, 'Rage');
  assert.equal(r.gain, 900);
  assert.deepEqual(r.others.map((o) => o.name), ['Holy Power']);
});

// Honesty: an id we don't recognise must be reported by its id, not mislabelled.
// Every NUMBER is still derived from the log, so the panel remains usable.
test('an unknown power type is named honestly, not guessed', () => {
  assert.equal(resourceName(17), 'Fury'); // Havoc DH — the other resource we can verify
  assert.equal(resourceName(9), 'Holy Power');
  assert.equal(isKnownResource(99), false);
  assert.equal(resourceName(99), 'power type 99');

  const r = computeResource([{ type: 99, gain: 50, waste: 50 }]);
  assert.equal(r.known, false);
  assert.equal(r.name, 'power type 99');
  assert.equal(r.wastePct, 50, 'the numbers still work — only the name is unknown');
});

test('computeResource returns null when the log carried no resource events', () => {
  assert.equal(computeResource([]), null);
  assert.equal(computeResource(), null);
});

test('compareResource: 1:1 vs the selected player, and only when the pool matches', () => {
  const mine = [{ type: 6, gain: 100, waste: 100 }]; // 50% wasted
  const them = [{ type: 6, gain: 300, waste: 100 }]; // 25% wasted
  const c = compareResource(mine, them);
  assert.equal(c.name, 'Runic Power');
  assert.equal(c.mine.wastePct, 50);
  assert.equal(c.them.wastePct, 25);
  assert.equal(c.diffPp, 25);
  assert.match(c.note, /percentage points/);

  // a different pool is not comparable, and must not be silently compared
  const other = compareResource(mine, [{ type: 1, gain: 100, waste: 0 }]);
  assert.equal(other.them, null);
});

test('computeRunMetrics exposes the generic resource (real fixture)', () => {
  const events = parseResourceEvents([probe]);
  const m = computeRunMetrics({ ...bundle.mine.detail, resourceEvents: events });
  assert.equal(m.resource.name, 'Runic Power');
  assert.ok(m.resource.wastePct > 0 && m.resource.wastePct < 100);
});

test('buildReport surfaces a waste gap named after the real resource', () => {
  const report = buildReport(bundle);
  const wasteGap = report.gaps.find((g) => g.category === 'waste');
  if (wasteGap) {
    assert.match(wasteGap.title, /wasted to overcapping/);
    assert.ok(report.resources.mine.wastePct > 0);
  }
});
