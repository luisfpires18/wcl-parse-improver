import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierFor, buildParsePlan, describeParsePlan } from '../server/analysis/parseTiers.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pit = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));

test('tierFor matches the WCL site color breakpoints (same as pctClass in app.js)', () => {
  assert.equal(tierFor(0).name, 'gray');
  assert.equal(tierFor(24.9).name, 'gray');
  assert.equal(tierFor(25).name, 'green');
  assert.equal(tierFor(49.9).name, 'green');
  assert.equal(tierFor(50).name, 'blue');
  assert.equal(tierFor(74.9).name, 'blue');
  assert.equal(tierFor(75).name, 'purple');
  assert.equal(tierFor(94.9).name, 'purple');
  assert.equal(tierFor(95).name, 'orange');
  assert.equal(tierFor(98.9).name, 'orange');
  assert.equal(tierFor(99).name, 'pink');
  assert.equal(tierFor(100).name, 'pink');
});

test('buildParsePlan says insufficientData with fewer than 2 distinct data points', () => {
  const plan = buildParsePlan({ myBestPercent: 20, myDps: 100000, history: [], gaps: [], honestyExplainedPct: 50 });
  assert.equal(plan.insufficientData, true);
  assert.equal(plan.tiers.length, 0);

  const onePoint = buildParsePlan({
    myBestPercent: 20,
    myDps: 100000,
    history: [{ rankPercent: 20, dps: 100000 }],
    gaps: [],
    honestyExplainedPct: 50,
  });
  assert.equal(onePoint.insufficientData, true);
});

test('buildParsePlan says atTopTier when already pink', () => {
  const plan = buildParsePlan({
    myBestPercent: 99.5,
    myDps: 300000,
    history: [
      { rankPercent: 90, dps: 280000 },
      { rankPercent: 99.5, dps: 300000 },
    ],
    gaps: [],
    honestyExplainedPct: 50,
  });
  assert.equal(plan.atTopTier, true);
  assert.equal(plan.tiers.length, 0);
});

test('buildParsePlan fits an exact line through 2 known points and projects correctly', () => {
  // synthetic: 1000 dps per percentile point, dps=100000 at percentile 0
  const history = [
    { rankPercent: 10, dps: 110000 },
    { rankPercent: 20, dps: 120000 },
  ];
  const plan = buildParsePlan({
    myBestPercent: 20,
    myDps: 120000,
    history,
    gaps: [{ title: 'Big gap', severity: 100 }], // covers anything
    honestyExplainedPct: 95,
  });
  const green = plan.tiers.find((t) => t.tier === 'green'); // threshold 25
  assert.equal(green.estDps, 125000); // 100000 + 1000*25
  assert.equal(green.dpsDelta, 5000);
  assert.ok(Math.abs(green.pctDeltaNeeded - 4.2) < 0.1); // 5000/120000*100
  assert.equal(green.fullyCoveredByFlaggedGaps, true);
});

test('buildParsePlan marks tiers outside the observed range as extrapolated', () => {
  const history = [
    { rankPercent: 10, dps: 100000 },
    { rankPercent: 15, dps: 105000 },
  ];
  const plan = buildParsePlan({ myBestPercent: 10, myDps: 100000, history, gaps: [], honestyExplainedPct: 50 });
  // requested tiers (25/50/75) are all above the observed max (15) -> extrapolated
  for (const t of plan.tiers) assert.equal(t.extrapolated, true);
});

test('buildParsePlan flags when even all flagged gaps together fall short (cappedByHonesty)', () => {
  const history = [
    { rankPercent: 10, dps: 100000 },
    { rankPercent: 90, dps: 400000 }, // huge slope -> next tier needs a lot of DPS
  ];
  const plan = buildParsePlan({
    myBestPercent: 10,
    myDps: 100000,
    history,
    gaps: [{ title: 'Small gap', severity: 1 }],
    honestyExplainedPct: 50, // well under 95 -> honesty gap exists
  });
  const green = plan.tiers.find((t) => t.tier === 'green');
  assert.equal(green.fullyCoveredByFlaggedGaps, false);
  assert.equal(green.cappedByHonesty, true);
});

test('describeParsePlan never emits "undefined" and names the tiers', () => {
  const history = [
    { rankPercent: 5, dps: 190000 },
    { rankPercent: 22, dps: 195000 },
  ];
  const plan = buildParsePlan({
    myBestPercent: 22,
    myDps: 195000,
    history,
    gaps: [{ title: 'Some gap', severity: 3 }],
    honestyExplainedPct: 80,
  });
  const text = describeParsePlan(plan);
  assert.ok(!text.includes('undefined'));
  assert.ok(text.includes('Green'));
});

test('describeParsePlan handles insufficientData and atTopTier text branches', () => {
  assert.match(
    describeParsePlan({ insufficientData: true, historyCount: 1, atTopTier: false, tiers: [] }),
    /Only 1 of your own logged run/
  );
  assert.match(describeParsePlan({ atTopTier: true }), /top tier/);
  assert.equal(describeParsePlan(null), null);
});

test('buildReport attaches a real parsePlan for the live-refetched Pit fixture (2 of my own +20 runs)', () => {
  const report = buildReport(pit);
  assert.equal(report.parse.historyCount, 2);
  assert.ok(report.parse.tiers.length > 0);
  assert.ok(report.parse.text.length > 0);
  assert.ok(!report.parse.text.includes('undefined'));
});

test('a tier already reached at a harder key level is never re-shown as a target (real Pit data: 31.1% overall at +21 vs 22.5% at +20)', () => {
  const report = buildReport(pit);
  assert.equal(report.parse.overallBestPercent, 31.1);
  assert.equal(report.parse.overallBestLevel, 21);
  assert.equal(report.parse.outrankedByOverall, true);
  // green (25%+) is already covered by the overall 31.1% -- must not appear
  assert.ok(!report.parse.tiers.some((t) => t.tier === 'green'));
  assert.ok(report.parse.text.startsWith('Your real Best % for this dungeon is already 31.1%'));
});

test('buildParsePlan: overallBestPercent below the level-locked percent does not affect anything (no false prefix)', () => {
  const plan = buildParsePlan({
    myBestPercent: 40,
    overallBestPercent: 10, // lower -- this level's own run is already the best
    overallBestLevel: 18,
    myDps: 150000,
    history: [
      { rankPercent: 30, dps: 140000 },
      { rankPercent: 40, dps: 150000 },
    ],
    gaps: [{ title: 'Gap', severity: 20 }],
    honestyExplainedPct: 90,
  });
  assert.equal(plan.outrankedByOverall, false);
  assert.ok(!describeParsePlan(plan).includes('Your real Best %'));
});

test('buildParsePlan: overall best already at pink means atTopTier even if this level is only green', () => {
  const plan = buildParsePlan({
    myBestPercent: 30,
    overallBestPercent: 99.2,
    overallBestLevel: 25,
    myDps: 150000,
    history: [
      { rankPercent: 25, dps: 145000 },
      { rankPercent: 30, dps: 150000 },
    ],
    gaps: [],
    honestyExplainedPct: 90,
  });
  assert.equal(plan.atTopTier, true);
  assert.match(describeParsePlan(plan), /Your real Best % for this dungeon is already 99\.2%/);
});
