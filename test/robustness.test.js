// Regression tests for edge-case correctness bugs found in the robustness
// pass: degenerate durations, negative DPS gaps, and null-safe summary text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRunMetrics } from '../server/analysis/metrics.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pit = () =>
  JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));

// --- B2: zero / missing duration must never produce Infinity or NaN ---

test('computeRunMetrics: zero fight duration yields 0 rates, never Infinity/NaN', () => {
  const detail = {
    fight: { startTime: 0, endTime: 0, keystoneTime: 0 },
    casts: { totalTimeMs: 0, totalCasts: 100, abilities: [{ name: 'X', casts: 100 }] },
    buffs: { totalTimeMs: 0, auras: [{ name: 'A', uptimeMs: 5000, uses: 1, bands: [] }] },
    damage: { abilities: [] },
    deaths: { deaths: [] },
    castEvents: [],
    resourceEvents: [],
  };
  const m = computeRunMetrics(detail);
  assert.equal(m.totalCPM, 0);
  assert.equal(m.abilities.get('X').cpm, 0);
  assert.equal(m.auras.get('A').uptimePct, 0);
  assert.ok(Number.isFinite(m.totalCPM));
});

test('computeRunMetrics: missing casts/buffs objects do not throw', () => {
  const m = computeRunMetrics({ fight: { startTime: 0, endTime: 60000 } });
  assert.equal(m.totalCPM, 0);
  assert.equal(m.deaths.length, 0);
  assert.equal(m.abilities.size, 0);
});

test('computeRunMetrics: real Pit run still produces sane finite rates (fix did not regress the normal path)', () => {
  const m = computeRunMetrics(pit().mine.detail);
  assert.ok(m.totalCPM > 20 && m.totalCPM < 80);
  for (const [, a] of m.abilities) assert.ok(Number.isFinite(a.cpm));
});

// The honesty/summary machinery these used to guard is gone: there is no cohort
// median to be "ahead of" any more, and no generated summary paragraph. What still
// needs guarding is that a 1:1 comparison survives degenerate opponents.

test('buildReport: an opponent with zero DPS does not divide-by-zero the gap', () => {
  const b = pit();
  b.other.meta.dps = 0;
  const report = buildReport(b);
  assert.ok(report.headline.dpsGapPct === null || Number.isFinite(report.headline.dpsGapPct));
});

test('buildReport: beating the opponent yields a negative gap, not a broken one', () => {
  const b = pit();
  b.mine.meta.dps = 999999; // way above them
  const report = buildReport(b);
  assert.ok(report.headline.dpsGapPct < 0, 'ahead of them = negative gap');
  assert.ok(Number.isFinite(report.headline.dpsGapPct));
});
