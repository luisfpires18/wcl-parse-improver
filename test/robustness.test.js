// Regression tests for edge-case correctness bugs found in the robustness
// pass: degenerate durations, negative DPS gaps, and null-safe summary text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRunMetrics } from '../server/analysis/metrics.js';
import { buildReport } from '../server/analysis/compare.js';
import { buildSummary } from '../server/analysis/summary.js';

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

// --- B1: my run ahead of the cohort must not produce a nonsensical honesty % ---

test('buildReport: when my DPS beats the cohort, explainedPct is null (not negative)', () => {
  const b = pit();
  b.mine.meta.dps = 999999; // way above the cohort
  b.cohort = [b.cohort[0]]; // single, weaker player
  const r = buildReport(b);
  assert.ok(r.headline.dpsGapPct < 0, 'gap should be negative (I am ahead)');
  assert.equal(r.honesty.explainedPct, null);
  // summary must not claim a negative % of a negative gap
  assert.ok(!r.summary.text.includes('-2'));
  assert.ok(r.summary.text.includes('match or beat'));
  assert.ok(!r.summary.nextSteps.recap.includes('null'));
});

test('buildReport: zero cohort DPS does not divide-by-zero the gap', () => {
  const b = pit();
  for (const c of b.cohort) c.meta.dps = 0;
  const r = buildReport(b);
  assert.equal(r.headline.dpsGapPct, null);
  assert.equal(r.honesty.explainedPct, null);
});

// --- B3: null gap / null explainedPct never render the literal string "null" ---

test('buildSummary: null dpsGapPct and null explainedPct never print "null%"', () => {
  const s = buildSummary({
    headline: { dungeon: 'Test', dpsGapPct: null, cohortLevel: 20 },
    gaps: [{ category: 'cpm', title: 'Total casts per minute', mine: 40, cohort: 50, severity: 5, advice: 'Cast more.' }],
    honesty: { explainedPct: null },
  });
  assert.ok(!s.text.includes('null'));
  assert.ok(!s.nextSteps.recap.includes('null'));
  assert.ok(s.text.includes('biggest execution difference'));
});
