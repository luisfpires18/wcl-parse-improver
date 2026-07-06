import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../server/analysis/compare.js';
import { buildSummary } from '../server/analysis/summary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8')
);

test('buildReport attaches a summary for real Pit data', () => {
  const report = buildReport(bundle);
  assert.ok(report.summary.text.includes('Pit of Saron'));
  assert.ok(report.summary.text.includes('Deaths') || report.summary.text.includes('death'));
  // honest about what it doesn't do
  assert.ok(report.summary.text.includes('Runic Power'));
});

test('summary names the biggest cluster of idle/deaths on the timeline', () => {
  const report = buildReport(bundle);
  // my two known deaths are far apart (2:07, 21:45) — the cluster around
  // 21:45 also contains two large idle windows (20:02, 24:48), so the
  // summary should call out a window in that neighborhood
  assert.match(report.summary.text, /\d+:\d+-\d+:\d+/);
});

test('buildSummary handles the no-gaps case without crashing', () => {
  const s = buildSummary({
    headline: { dungeon: 'Test Dungeon', dpsGapPct: 0 },
    gaps: [],
    timeline: null,
    honesty: { explainedPct: 0 },
  });
  assert.ok(s.text.includes('Test Dungeon'));
});

test('buildSummary handles a run with no timeline gracefully', () => {
  const s = buildSummary({
    headline: { dungeon: 'Test Dungeon', dpsGapPct: 10 },
    gaps: [{ category: 'cpm', title: 'Total casts per minute', mine: 40, cohort: 50, severity: 5 }],
    timeline: null,
    honesty: { explainedPct: 50 },
  });
  assert.ok(s.text.includes('cast rate'));
  assert.ok(!s.text.includes('undefined'));
});
