import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResourceEvents } from '../server/parse/tables.js';
import { computeRunMetrics } from '../server/analysis/metrics.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'probe-resource-events.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));

test('parseResourceEvents keeps only my own Runic Power gains (real Pit payload)', () => {
  const events = parseResourceEvents([probe]);
  // 1149 real type-6 (RunicPower, sourceID===targetID) events in the fixture;
  // the 33 type-3 pet-resource events must be filtered out
  assert.equal(events.length, 1149);
  for (const e of events) {
    assert.ok(e.gain >= 0);
    assert.ok(e.waste >= 0);
    assert.ok(typeof e.timestamp === 'number');
  }
});

test('parseResourceEvents survives garbage', () => {
  assert.deepEqual(parseResourceEvents([null, {}, { data: null }]), []);
});

test('computeRunMetrics.rpWaste matches hand-computed totals from the real fixture', () => {
  const events = parseResourceEvents([probe]);
  const netGain = events.reduce((a, e) => a + e.gain, 0) / 10;
  const waste = events.reduce((a, e) => a + e.waste, 0) / 10;
  const m = computeRunMetrics({ ...bundle.mine.detail, resourceEvents: events });
  assert.ok(Math.abs(m.rpWaste.netGain - netGain) < 0.01);
  assert.ok(Math.abs(m.rpWaste.waste - waste) < 0.01);
  assert.ok(m.rpWaste.wastePct > 0 && m.rpWaste.wastePct < 100);
});

test('buildReport surfaces a waste gap when real Pit data has one', () => {
  const report = buildReport(bundle);
  const wasteGap = report.gaps.find((g) => g.category === 'waste');
  // real data: I wasted ~12.9% vs cohort ~9.4% — a real, meaningful gap
  if (wasteGap) {
    assert.ok(wasteGap.advice.includes('Runic Power'));
    assert.ok(report.tables.rpWaste.mine.wastePct > 0);
  }
});
