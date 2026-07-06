import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline } from '../server/analysis/timeline.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8')
);

test('buildTimeline picks a shared, frequency-based lane set from real Pit data', () => {
  const t = buildTimeline(bundle.mine.detail, bundle.cohort[0].detail);
  assert.ok(t.laneNames.length > 0 && t.laneNames.length <= 8);
  // high-CPM filler (Scourge Strike, Death Coil, Epidemic) must not be a lane
  for (const filler of ['Scourge Strike', 'Death Coil', 'Epidemic', 'Graveyard']) {
    assert.ok(!t.laneNames.includes(filler), `${filler} is filler, not a cooldown lane`);
  }
  // same lane order/names for both runs (comparability requirement)
  assert.deepEqual(
    t.mine.lanes.map((l) => l.name),
    t.laneNames
  );
  assert.deepEqual(
    t.other.lanes.map((l) => l.name),
    t.laneNames
  );
});

test('buildTimeline carries real idle windows and deaths, fight-relative', () => {
  const t = buildTimeline(bundle.mine.detail, bundle.cohort[0].detail);
  assert.equal(t.mine.deaths.length, 2);
  for (const d of t.mine.deaths) assert.ok(d.atMs >= 0 && d.atMs <= t.mine.durationMs);
  assert.ok(t.mine.idleWindows.length > 0);
  for (const w of t.mine.idleWindows) {
    assert.ok(w.startMs >= 0);
    assert.ok(w.startMs + w.durMs <= t.mine.durationMs + 1000);
  }
});

test('lane cast timestamps fall within the run duration and are non-negative', () => {
  const t = buildTimeline(bundle.mine.detail, bundle.cohort[0].detail);
  for (const view of [t.mine, t.other]) {
    for (const lane of view.lanes) {
      for (const ts of lane.casts) {
        assert.ok(ts >= 0 && ts <= view.durationMs, `${lane.name} cast ${ts} within [0, ${view.durationMs}]`);
      }
    }
  }
});

test('a real cooldown (Dark Transformation) resolves to actual cast timestamps, not an empty lane', () => {
  const t = buildTimeline(bundle.mine.detail, bundle.cohort[0].detail);
  if (t.laneNames.includes('Dark Transformation')) {
    const lane = t.mine.lanes.find((l) => l.name === 'Dark Transformation');
    assert.ok(lane.casts.length > 0);
  }
});

test('buildReport attaches a timeline built from the mine vs top-1 cohort run', () => {
  const report = buildReport(bundle);
  assert.ok(report.timeline);
  assert.equal(report.timeline.other.label, bundle.cohort[0].meta.name);
  assert.equal(report.timeline.mine.label, 'Unreally');
});
