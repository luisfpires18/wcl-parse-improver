import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRunMetrics, median } from '../server/analysis/metrics.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8')
);

test('computeRunMetrics on my real Pit run', () => {
  const m = computeRunMetrics(bundle.mine.detail);
  assert.ok(m.totalCPM > 20 && m.totalCPM < 80, `CPM plausible, got ${m.totalCPM}`);
  assert.equal(m.deaths.length, 2);
  assert.ok(m.downtime.idlePct > 0 && m.downtime.idlePct < 50);
  assert.ok(m.downtime.windows.length > 0);
  assert.ok(m.abilities.get('Death Coil').casts > 0);
  for (const [, aura] of m.auras) {
    assert.ok(aura.uptimePct >= 0 && aura.uptimePct <= 100.5);
  }
  assert.ok(m.spender.epidemicShare > 0 && m.spender.epidemicShare < 1);
});

test('median across cohort', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
  assert.equal(median([1, null, 3, undefined]), 2);
});

test('buildReport produces ranked gaps with advice', () => {
  const report = buildReport(bundle);
  assert.equal(report.headline.dungeon, 'Pit of Saron');
  assert.equal(report.headline.cohortSize, 5);
  assert.ok(report.headline.dpsGapPct > 0);

  assert.ok(report.gaps.length >= 3);
  // sorted by severity descending
  for (let i = 1; i < report.gaps.length; i++) {
    assert.ok(report.gaps[i - 1].severity >= report.gaps[i].severity);
  }
  // every gap has one sentence of advice
  for (const g of report.gaps) assert.ok(g.advice.length > 20, `advice for ${g.title}`);
  // deaths gap present (I died 2x, cohort 0)
  assert.ok(report.gaps.some((g) => g.category === 'deaths'));
});

test('group-comp buffs are segregated, not ranked as actionable gaps', () => {
  const report = buildReport(bundle);
  const gapNames = report.gaps.map((g) => g.title);
  // cohort-only externals must not appear in the ranked gap list
  for (const external of ['Mark of the Wild uptime', 'Ebon Might uptime', 'Prescience uptime']) {
    assert.ok(!gapNames.includes(external), `${external} should be comp-only`);
  }
  assert.ok(report.compNotes.length >= 3);
});

test('honesty never claims more than 95% explained', () => {
  const report = buildReport(bundle);
  assert.ok(report.honesty.explainedPct <= 95);
  assert.ok(report.honesty.dpsGapPct > 0);
  assert.ok(report.honesty.note.includes('group comp'));
});

test('cpm table has cohort raw cast counts alongside CPM, not just the rate', () => {
  const report = buildReport(bundle);
  assert.ok(report.tables.cpm.length > 0);
  for (const row of report.tables.cpm) {
    assert.ok(typeof row.cohortCasts === 'number', `${row.name} missing cohortCasts`);
    assert.ok(typeof row.myCasts === 'number');
  }
});

test('uptime table has raw use-counts alongside percentages', () => {
  const report = buildReport(bundle);
  assert.ok(report.tables.uptimes.length > 0);
  for (const row of report.tables.uptimes) {
    assert.ok(typeof row.myUses === 'number');
    assert.ok(typeof row.cohortUses === 'number');
  }
});

test('deaths table gives a per-player cohort breakdown, not just the median', () => {
  const report = buildReport(bundle);
  const byPlayer = report.tables.deaths.cohortByPlayer;
  assert.equal(byPlayer.length, 5);
  for (const p of byPlayer) {
    assert.ok(typeof p.name === 'string' && p.name.length > 0);
    assert.ok(typeof p.deaths === 'number');
  }
  // real data: every top-5 run had 0 deaths (matches the median of 0)
  assert.ok(byPlayer.every((p) => p.deaths === 0));
});

test('spender and rpWaste tables carry cohort raw amounts, not just percentages', () => {
  const report = buildReport(bundle);
  const sp = report.tables.spender;
  assert.ok(typeof sp.cohortDeathCoilCasts === 'number');
  assert.ok(typeof sp.cohortEpidemicCasts === 'number');
  const w = report.tables.rpWaste;
  assert.ok(typeof w.cohortNetGain === 'number');
  assert.ok(typeof w.cohortWasteAmount === 'number');
  // real data: cohort generates comparable RP but wastes noticeably less
  assert.ok(w.cohortWasteAmount < w.mine.waste);
});
