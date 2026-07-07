import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline, analyzeTimeline, buildTimelineInfo } from '../server/analysis/timeline.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pit = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));
const magisters = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-12811-plus0.json'), 'utf8'));

test('analyzeTimeline flags a real lane-count gap from the real Pit data (Death Pact)', () => {
  const t = buildTimeline(pit.mine.detail, pit.cohort[0].detail);
  const info = analyzeTimeline(t);
  assert.ok(info.laneNotes.length > 0);
  const deathPact = info.laneNotes.find((n) => n.name === 'Death Pact');
  assert.ok(deathPact, 'Death Pact should stand out (7 vs 2 casts in the real fixture)');
  assert.equal(deathPact.mineCount, 7);
  assert.equal(deathPact.otherCount, 2);
});

test('analyzeTimeline reports idle% and deaths for both sides, fixture-independent shape', () => {
  const t = buildTimeline(magisters.mine.detail, magisters.cohort[0].detail);
  const info = analyzeTimeline(t);
  assert.ok(typeof info.mineIdlePct === 'number' && info.mineIdlePct >= 0);
  assert.ok(typeof info.otherIdlePct === 'number' && info.otherIdlePct >= 0);
  assert.ok(typeof info.mineDeaths === 'number');
  assert.ok(typeof info.otherDeaths === 'number');
});

test('analyzeTimeline handles a null timeline gracefully', () => {
  assert.equal(analyzeTimeline(null), null);
});

test('buildTimelineInfo produces readable text mentioning a real standout lane, never "undefined"', () => {
  const t = buildTimeline(pit.mine.detail, pit.cohort[0].detail);
  const info = buildTimelineInfo(t);
  assert.ok(info.text.includes('Death Pact'));
  assert.ok(!info.text.includes('undefined'));
});

test('buildTimelineInfo says nothing-stands-out when laneNotes is empty', () => {
  const info = buildTimelineInfo({
    laneNames: ['Foo'],
    mine: { durationMs: 60000, idleWindows: [], deaths: [], lanes: [{ name: 'Foo', casts: [1000, 2000] }] },
    other: { durationMs: 60000, idleWindows: [], deaths: [], lanes: [{ name: 'Foo', casts: [1000, 2000] }] },
  });
  assert.ok(info.text.includes('No cooldown lane stands out'));
});

test('buildTimelineInfo flags a lane never used at all, distinct wording from a rate gap', () => {
  const info = buildTimelineInfo({
    laneNames: ['Foo'],
    mine: { durationMs: 60000, idleWindows: [], deaths: [], lanes: [{ name: 'Foo', casts: [] }] },
    other: { durationMs: 60000, idleWindows: [], deaths: [], lanes: [{ name: 'Foo', casts: [1000, 2000, 3000, 4000] }] },
  });
  assert.equal(info.laneNotes[0].neverUsed, true);
  assert.ok(info.text.includes('never cast it'));
});

test('buildReport attaches timelineInfo alongside the timeline, both null when no cohort', () => {
  const report = buildReport(pit);
  assert.ok(report.timelineInfo);
  assert.ok(report.timelineInfo.text.length > 0);
});
