import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaidParse } from '../server/analysis/raidParse.js';

// A clean line so the arithmetic is checkable by hand:
//   dps = 80000 + 1000 * percentile
// => 25% (green) = 105k, 50% (blue) = 130k, 75% (purple) = 155k, 95% = 175k
const history = [
  { rankPercent: 10, dps: 90000, durationMs: 400000 },
  { rankPercent: 30, dps: 110000, durationMs: 380000 },
  { rankPercent: 50, dps: 130000, durationMs: 390000 },
  { rankPercent: 70, dps: 150000, durationMs: 400000 },
];

test('a ranked KILL uses WCL’s real percentile, not a projection', () => {
  const p = buildRaidParse({ history, pullDps: 130000, pullRankPercent: 48.3, pullDurationSec: 390, isKill: true });
  assert.equal(p.currentPercent, 48.3);
  assert.equal(p.currentTier, 'green'); // >=25 green, and below the 50 blue threshold
  assert.equal(p.projected, false);
  assert.equal(p.ranked, true);
  assert.match(p.text, /Warcraft Logs' own number|Warcraft Logs’ own number/);
  assert.doesNotMatch(p.text, /projected/i);
});

test('next colours are priced in DPS off the fitted line', () => {
  const p = buildRaidParse({ history, pullDps: 130000, pullRankPercent: 50, pullDurationSec: 390, isKill: true });
  // at 50% -> blue is already reached, so the next tiers are purple/orange/pink
  const byTier = Object.fromEntries(p.tiers.map((t) => [t.tier, t]));
  assert.equal(byTier.purple.threshold, 75);
  assert.equal(byTier.purple.needDps, 155000); // 80000 + 1000*75
  assert.equal(byTier.purple.dpsDelta, 25000); // from 130k
  assert.equal(byTier.purple.pctDeltaNeeded, 19.2); // 25000/130000
  assert.equal(byTier.orange.needDps, 175000); // 80000 + 1000*95
});

test('tier ladder runs gray -> green -> blue -> purple -> orange -> pink', () => {
  const p = buildRaidParse({ history, pullDps: 85000, pullRankPercent: 5, pullDurationSec: 390, isKill: true });
  assert.equal(p.currentTier, 'gray');
  assert.deepEqual(p.tiers.map((t) => t.tier), ['green', 'blue', 'purple']); // capped at 3
  assert.deepEqual(p.tiers.map((t) => t.threshold), [25, 50, 75]);
  assert.equal(p.tiers[0].needDps, 105000); // green = 80000 + 1000*25
});

test('a WIPE has no parse — it is projected off your own kills, and says so', () => {
  const p = buildRaidParse({ history, pullDps: 130000, pullRankPercent: null, pullDurationSec: 380, isKill: false });
  assert.equal(p.ranked, false);
  assert.equal(p.projected, true);
  assert.equal(p.currentPercent, 50); // (130000 - 80000) / 1000
  assert.match(p.text, /never ranks wipes/i);
  assert.match(p.text, /[Pp]rojected/);
});

// The trap: a 30s wipe ends inside the opener with every cooldown up, so its rate
// — and therefore its projected parse — is flattering. Caught from the data by
// comparing the pull's length against the length of the player's real kills.
test('a short wipe’s projected parse is flagged as burst-inflated', () => {
  const short = buildRaidParse({ history, pullDps: 250000, pullRankPercent: null, pullDurationSec: 30, isKill: false });
  assert.equal(short.burstInflated, true);
  assert.equal(short.killDurationSec, 395); // median of the real kills
  assert.match(short.text, /flattering/i);
  assert.match(short.text, /inside your opener/i);

  // …but a full-length wipe is NOT flagged — the caveat must not cry wolf
  const full = buildRaidParse({ history, pullDps: 130000, pullRankPercent: null, pullDurationSec: 380, isKill: false });
  assert.equal(full.burstInflated, false);
  assert.doesNotMatch(full.text, /flattering/i);
});

test('a kill is never flagged burst-inflated, however short', () => {
  const p = buildRaidParse({ history, pullDps: 200000, pullRankPercent: 90, pullDurationSec: 30, isKill: true });
  assert.equal(p.burstInflated, false);
});

test('fewer than 2 distinct percentiles: refuse to invent a curve', () => {
  const p = buildRaidParse({ history: [{ rankPercent: 40, dps: 100000, durationMs: 400000 }], pullDps: 100000, isKill: false });
  assert.equal(p.insufficientData, true);
  assert.deepEqual(p.tiers, []);
  assert.match(p.text, /not enough to fit/i);
});

test('no ranked kills at all: still no invented numbers', () => {
  const p = buildRaidParse({ history: [], pullDps: 120000, isKill: false });
  assert.equal(p.insufficientData, true);
  assert.equal(p.currentPercent, null);
});

test('a tier beyond anything you have parsed is marked extrapolated', () => {
  // history tops out at 70%, so EVERY tier above it is the line extended past
  // your own data — a weaker claim, and it must be labelled as one
  const p = buildRaidParse({ history, pullDps: 150000, pullRankPercent: 70, pullDurationSec: 400, isKill: true });
  assert.deepEqual(p.tiers.map((t) => t.tier), ['purple', 'orange', 'pink']);
  for (const t of p.tiers) assert.equal(t.extrapolated, true, `${t.tier} (${t.threshold}%) is past the 70% you have parsed`);
  assert.match(p.text, /extrapolated/i);

  // a tier INSIDE the observed range is not flagged
  const low = buildRaidParse({ history, pullDps: 90000, pullRankPercent: 10, pullDurationSec: 400, isKill: true });
  assert.equal(low.tiers.find((t) => t.tier === 'green').extrapolated, false); // 25% sits inside 10-70
});

// The bug this guards, caught live: the raw least-squares line priced blue (50%)
// at 108.2k DPS while the player's REAL 48.3% kill did 112.6k — i.e. "do less
// damage to rank higher". Anchoring the ladder at the pull itself makes that
// impossible: the next colour always costs MORE than what you just did.
test('the next colour always costs more DPS than the pull you are looking at', () => {
  // a noisy history whose fitted intercept would otherwise undercut the pull
  const noisy = [
    { rankPercent: 4.2, dps: 82094, durationMs: 399000 },
    { rankPercent: 7.9, dps: 82843, durationMs: 399000 },
    { rankPercent: 23.0, dps: 94526, durationMs: 387000 },
    { rankPercent: 30.0, dps: 84153, durationMs: 388000 },
    { rankPercent: 48.3, dps: 112596, durationMs: 348000 },
  ];
  const p = buildRaidParse({ history: noisy, pullDps: 112596, pullRankPercent: 48.3, pullDurationSec: 348, isKill: true });
  assert.equal(p.insufficientData, false);
  for (const t of p.tiers) {
    assert.ok(t.needDps > p.pullDps, `${t.tier} must cost MORE than the ${p.pullDps} you did, got ${t.needDps}`);
    assert.ok(t.dpsDelta > 0 && t.pctDeltaNeeded > 0, `${t.tier} delta must be positive`);
  }
  // and the ladder must rise monotonically
  const need = p.tiers.map((t) => t.needDps);
  assert.deepEqual(need, [...need].sort((x, y) => x - y));
});

test('a backwards fit (more DPS ranking lower) is refused, not printed', () => {
  // deliberately inverted: higher percentile, lower DPS
  const backwards = [
    { rankPercent: 10, dps: 150000, durationMs: 400000 },
    { rankPercent: 80, dps: 90000, durationMs: 400000 },
  ];
  const p = buildRaidParse({ history: backwards, pullDps: 120000, pullRankPercent: 40, pullDurationSec: 400, isKill: true });
  assert.equal(p.fitUnreliable, true);
  assert.equal(p.insufficientData, true);
  assert.deepEqual(p.tiers, [], 'no tier prices off a line that runs backwards');
  assert.equal(p.currentPercent, 40, 'the real parse is still reported');
  assert.match(p.text, /runs backwards|doesn't|does not/i);
});

test('already pink: nothing left to sell', () => {
  const p = buildRaidParse({ history, pullDps: 300000, pullRankPercent: 99.5, pullDurationSec: 390, isKill: true });
  assert.equal(p.atTopTier, true);
  assert.deepEqual(p.tiers, []);
  assert.match(p.text, /top colour/i);
});
