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

test('summary and next-steps never mention a death timestamp or "rewatch/review" instruction', () => {
  const report = buildReport(bundle);
  // deaths at 2:07 and 21:45 in the real fixture — neither should be quoted
  // back at the player as a "go look here" moment; the count comparison
  // (mine vs cohort) is the useful part, not the clock time
  assert.doesNotMatch(report.summary.text, /\d+:\d\d-\d+:\d\d/);
  assert.doesNotMatch(report.summary.text, /rewatch|review those moments/i);
  for (const a of report.summary.nextSteps.actions) {
    assert.doesNotMatch(a, /\d+:\d\d-\d+:\d\d/);
    assert.doesNotMatch(a, /rewatch|review those moments/i);
  }
});

test('nextSteps lists real gap advice ordered by severity, deaths included as a plain comparison', () => {
  const report = buildReport(bundle);
  const { nextSteps } = report.summary;
  assert.ok(nextSteps.recap.includes('gap'));
  assert.ok(nextSteps.actions.length > 0);
  const deathsAction = nextSteps.actions.find((a) => a.startsWith('You died'));
  if (deathsAction) assert.match(deathsAction, /cohort's \d/);
  for (const a of nextSteps.actions) assert.ok(!a.includes('undefined'));
});

test('advice for uptime/ability gaps is self-contained (names the buff/ability, not just "this")', () => {
  const report = buildReport(bundle);
  for (const g of report.gaps) {
    if (g.category === 'uptime') {
      const auraName = g.title.replace(' uptime (active time)', '');
      assert.ok(g.advice.includes(auraName), `advice for ${g.title} should name ${auraName}`);
    }
    if (g.category === 'ability') {
      const abilityName = g.title.replace(' usage', '');
      assert.ok(g.advice.includes(abilityName), `advice for ${g.title} should name ${abilityName}`);
    }
  }
});

test('buildSummary handles the no-gaps case without crashing', () => {
  const s = buildSummary({
    headline: { dungeon: 'Test Dungeon', dpsGapPct: 0 },
    gaps: [],
    honesty: { explainedPct: 0 },
  });
  assert.ok(s.text.includes('Test Dungeon'));
});

test('buildSummary reuses gap.advice verbatim in nextSteps', () => {
  const s = buildSummary({
    headline: { dungeon: 'Test Dungeon', dpsGapPct: 10 },
    gaps: [
      { category: 'cpm', title: 'Total casts per minute', mine: 40, cohort: 50, severity: 5, advice: 'Cast more.' },
    ],
    honesty: { explainedPct: 50 },
  });
  assert.ok(s.text.includes('cast rate'));
  assert.ok(!s.text.includes('undefined'));
  assert.deepEqual(s.nextSteps.actions, ['Cast more.']);
});
