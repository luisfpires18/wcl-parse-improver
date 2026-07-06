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

test('summary names the biggest idle/death cluster on the timeline', () => {
  const report = buildReport(bundle);
  // real data: my worst 45s-merge cluster is 1:04-3:13 (death at 2:07 plus
  // two nearby idle windows) — the tightest defensible grouping, not the
  // late-fight windows which are >45s apart from each other
  assert.match(report.summary.text, /1:04-3:13/);
});

test('nextSteps leads with the timeline cluster and lists real gap advice', () => {
  const report = buildReport(bundle);
  const { nextSteps } = report.summary;
  assert.ok(nextSteps.recap.includes('gap'));
  assert.ok(nextSteps.actions.length > 0);
  assert.match(nextSteps.actions[0], /1:04-3:13/);
  // deaths gap itself is folded into the cluster line, not repeated verbatim
  assert.ok(!nextSteps.actions.slice(1).some((a) => a.startsWith('You died')));
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
    timeline: null,
    honesty: { explainedPct: 0 },
  });
  assert.ok(s.text.includes('Test Dungeon'));
});

test('buildSummary handles a run with no timeline gracefully', () => {
  const s = buildSummary({
    headline: { dungeon: 'Test Dungeon', dpsGapPct: 10 },
    gaps: [
      { category: 'cpm', title: 'Total casts per minute', mine: 40, cohort: 50, severity: 5, advice: 'Cast more.' },
    ],
    timeline: null,
    honesty: { explainedPct: 50 },
  });
  assert.ok(s.text.includes('cast rate'));
  assert.ok(!s.text.includes('undefined'));
  assert.deepEqual(s.nextSteps.actions, ['Cast more.']);
});
