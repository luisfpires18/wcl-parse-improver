import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgression, attemptOutput } from '../server/analysis/raidProgress.js';
import { parseReportFights, groupByEncounter, difficultyName } from '../server/parse/reportFights.js';
import { reportCode } from '../server/wcl/raid.js';

// active DPS = totalDamage / (activeMs/1000); with activeMs 200000 (200s),
// totalDamage 200e6 -> exactly 1,000,000 active DPS.
function detail({ totalDamage, activeMs = 200000, deaths = 0, deathAtMs = 1000, abilities = [] }) {
  return {
    fightID: 1,
    fight: { startTime: 0, endTime: activeMs },
    casts: { totalTimeMs: activeMs, totalCasts: 100, abilities },
    buffs: { totalTimeMs: activeMs, auras: [] },
    damage: { totalDamage, abilities: [] },
    deaths: { deaths: Array.from({ length: deaths }, () => ({ timestamp: deathAtMs })) },
    castEvents: [],
    resourceEvents: [],
  };
}
function attempt(id, opts) {
  const { kill = false, pctRemaining = null, durationMs = opts.activeMs ?? 200000, raidDeaths = null } = opts;
  return { fight: { id, kill, pctRemaining, durationMs }, detail: detail(opts), raidDeaths };
}

test('attemptOutput: active DPS is damage over engaged seconds', () => {
  const o = attemptOutput({ id: 3, kill: false, durationMs: 200000 }, detail({ totalDamage: 200e6 }));
  assert.equal(o.activeDps, 1_000_000);
  assert.equal(o.durationSec, 200);
  assert.equal(o.kill, false);
});

test('buildProgression: steady pulls read as tight consistency', () => {
  const attempts = [
    attempt(1, { totalDamage: 200e6 }),
    attempt(2, { totalDamage: 202e6 }),
    attempt(3, { totalDamage: 198e6 }),
  ];
  const { consistency } = buildProgression({ attempts });
  assert.equal(consistency.verdict, 'tight');
  assert.equal(consistency.scoredPulls, 3);
  assert.ok(consistency.cvPct < 6, `cv should be small, got ${consistency.cvPct}`);
});

test('buildProgression: wide pull-to-pull variance reads as swingy', () => {
  const attempts = [
    attempt(1, { totalDamage: 200e6 }),
    attempt(2, { totalDamage: 300e6 }),
    attempt(3, { totalDamage: 120e6 }),
  ];
  const { consistency } = buildProgression({ attempts });
  assert.equal(consistency.verdict, 'swingy');
  assert.ok(consistency.swingPct >= 40, `expected a large swing, got ${consistency.swingPct}`);
});

test('buildProgression: short pulls are listed but dropped from the spread', () => {
  const attempts = [
    attempt(1, { totalDamage: 200e6 }),
    attempt(2, { totalDamage: 200e6 }),
    // 8s reset with a nonsense rate — must not pollute consistency
    attempt(3, { totalDamage: 5e6, activeMs: 8000, durationMs: 8000 }),
  ];
  const { rows, consistency } = buildProgression({ attempts });
  assert.equal(rows.length, 3, 'all pulls still listed');
  assert.equal(consistency.scoredPulls, 2, 'short pull dropped from scoring');
  assert.equal(consistency.verdict, 'tight');
});

// The bug this guards: a 30s wipe is spent entirely inside the opener with every
// burst cooldown up and no droughts, so its active DPS beats any full-length pull
// — and would otherwise be crowned "best", inflating swing and the verdict with it.
test('burst inflation: a short all-opener pull has the highest rate but cannot be "best"', () => {
  const army = (n) => [{ name: 'Army of the Dead', guid: 2, casts: n }];
  const attempts = [
    attempt(1, { totalDamage: 300e6, activeMs: 300000, durationMs: 300000, abilities: army(1) }), // 300s -> 1.00M
    attempt(2, { totalDamage: 310e6, activeMs: 300000, durationMs: 300000, abilities: army(1) }), // 300s -> 1.03M
    attempt(3, { totalDamage: 75e6, activeMs: 30000, durationMs: 30000, abilities: army(1) }), //  30s -> 2.50M
  ];
  const { rows, consistency } = buildProgression({ attempts });
  const burst = rows.find((r) => r.fightID === 3);

  // its raw rate genuinely IS the highest — that's exactly why it's dangerous
  assert.ok(burst.activeDps > 2_000_000, `burst pull rate should be huge, got ${burst.activeDps}`);
  assert.equal(burst.comparable, false);
  assert.equal(burst.burstWeighted, true);

  // …and it must not set the bar for anything
  assert.equal(consistency.comparableFloorSec, 120); // 0.4 x the 300s longest pull
  assert.equal(consistency.scoredPulls, 2);
  assert.equal(consistency.burstWeightedPulls, 1);
  assert.ok(
    consistency.bestActiveDps < 1_100_000,
    `best must come from a full-length pull, got ${consistency.bestActiveDps}`
  );
  assert.ok(consistency.swingPct < 10, `swing must not be inflated by the burst pull, got ${consistency.swingPct}`);

  // the exclusion is justified from the data, not asserted: amps fire far faster
  // on the short pull (1 Army in 30s = 2/min vs 1 in 300s = 0.2/min)
  assert.ok(burst.ampCpm > rows.find((r) => r.fightID === 1).ampCpm * 5);
  assert.match(consistency.burstNote, /#3/);
  assert.match(consistency.burstNote, /burst cooldowns at 2\/min against 0\.2\/min/);
});

test('buildProgression: benchmark gap measured against a top kill', () => {
  const attempts = [attempt(1, { totalDamage: 200e6 }), attempt(2, { totalDamage: 200e6 })];
  const benchmark = { name: 'Topdk', difficultyName: 'Mythic', detail: detail({ totalDamage: 260e6 }) };
  const { benchmark: b } = buildProgression({ attempts, benchmark });
  assert.equal(b.killActiveDps, 1_300_000);
  // mean 1.0M vs kill 1.3M -> ~23% under
  assert.ok(b.gapToMeanPct > 20 && b.gapToMeanPct < 25, `got ${b.gapToMeanPct}`);
  assert.equal(b.name, 'Topdk');
});

test('buildProgression: no kill needed — reports best progress reached', () => {
  const attempts = [
    attempt(1, { totalDamage: 200e6, pctRemaining: 42 }),
    attempt(2, { totalDamage: 205e6, pctRemaining: 18 }), // best wipe
    attempt(3, { totalDamage: 190e6, pctRemaining: 55 }),
  ];
  const { consistency } = buildProgression({ attempts });
  assert.equal(consistency.killed, false);
  assert.equal(consistency.bestProgressPctRemaining, 18);
});

// --- report fights parsing ---

test('parseReportFights: drops trash, keeps boss kills and wipes', () => {
  const report = {
    title: 'Prog night',
    zone: { id: 99, name: 'Test Raid' },
    startTime: 1000,
    fights: [
      { id: 1, encounterID: 0, name: 'Trash', kill: false, startTime: 0, endTime: 10 }, // trash -> dropped
      { id: 2, encounterID: 3001, name: 'Boss A', kill: false, difficulty: 5, fightPercentage: 30, startTime: 0, endTime: 100000 },
      { id: 3, encounterID: 3001, name: 'Boss A', kill: true, difficulty: 5, fightPercentage: 0, startTime: 0, endTime: 200000 },
    ],
    masterData: { actors: [{ id: 7, name: 'Me', subType: 'DeathKnight' }] },
  };
  const parsed = parseReportFights(report);
  assert.equal(parsed.fights.length, 2);
  assert.equal(parsed.fights[0].pctRemaining, 30);
  assert.equal(parsed.fights[0].durationMs, 100000);
  assert.equal(parsed.fights[1].kill, true);
  assert.equal(parsed.actors.length, 1);
});

test('groupByEncounter: one row per boss+difficulty with pulls, kills, best progress', () => {
  const { fights } = parseReportFights({
    fights: [
      { id: 2, encounterID: 3001, name: 'Boss A', kill: false, difficulty: 5, fightPercentage: 30, startTime: 0, endTime: 100000 },
      { id: 3, encounterID: 3001, name: 'Boss A', kill: false, difficulty: 5, fightPercentage: 12, startTime: 0, endTime: 120000 },
      { id: 4, encounterID: 3001, name: 'Boss A', kill: true, difficulty: 5, fightPercentage: 0, startTime: 0, endTime: 200000 },
    ],
  });
  const groups = groupByEncounter(fights);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pulls, 3);
  assert.equal(groups[0].kills, 1);
  assert.equal(groups[0].bestPctRemaining, 0); // the kill
  assert.equal(groups[0].difficultyName, 'Mythic');
});

test('buildProgression: EVERY pull is listed and pickable, even the ones not fetched', () => {
  // a 4-pull boss where only two pulls got the per-pull API fetches
  const attempts = [attempt(1, { totalDamage: 200e6 }), attempt(5, { totalDamage: 200e6 })];
  const allFights = [
    { id: 1, kill: false, pctRemaining: 40, durationMs: 200000 },
    { id: 2, kill: false, pctRemaining: 80, durationMs: 60000 }, // never fetched
    { id: 5, kill: false, pctRemaining: 20, durationMs: 200000 },
    { id: 9, kill: true, pctRemaining: 0, durationMs: 300000 }, // never fetched
  ];
  const { rows, consistency } = buildProgression({ attempts, allFights });

  assert.deepEqual(rows.map((r) => r.fightID), [1, 2, 5, 9], 'all four pulls listed in order');
  assert.equal(consistency.pulls, 4);
  assert.equal(consistency.analysedPulls, 2);

  // an unfetched pull still carries its free fight metadata, so it can be shown and clicked
  const un = rows.find((r) => r.fightID === 2);
  assert.equal(un.analysed, false);
  assert.equal(un.durationSec, 60);
  assert.equal(un.pctRemaining, 80);
  assert.equal(un.activeDps, null, 'no invented metrics for a pull we never fetched');
  assert.equal(rows.find((r) => r.fightID === 9).kill, true);

  // …and must not pollute the aggregate stats
  assert.equal(consistency.scoredPulls, 2);
});

test('burst inflation: an all-short-pulls boss relaxes the bar instead of dead-ending', () => {
  // early prog — the raid dies at ~90% every time, no pull clears the 90s floor
  const attempts = [
    attempt(1, { totalDamage: 60e6, activeMs: 60000, durationMs: 60000 }),
    attempt(2, { totalDamage: 62e6, activeMs: 60000, durationMs: 60000 }),
    attempt(3, { totalDamage: 10e6, activeMs: 15000, durationMs: 15000 }),
  ];
  const { consistency } = buildProgression({ attempts });
  assert.equal(consistency.comparableFloorRelaxed, true);
  assert.equal(consistency.comparableFloorSec, 24); // 0.4 x the 60s longest
  assert.equal(consistency.scoredPulls, 2, 'the two real pulls are still comparable to each other');
  assert.match(consistency.burstNote, /#3/);
});

// --- death timing: early vs with the raid ---

// raid death cascade around 190-200s; the player's death time is what varies.
const raidCascade = [{ timestamp: 190000 }, { timestamp: 195000 }, { timestamp: 200000 }];

test('death timing: dying with the raid cascade is not flagged as early', () => {
  const attempts = [
    attempt(1, { totalDamage: 200e6, deaths: 1, deathAtMs: 193000, durationMs: 200000, raidDeaths: raidCascade }),
    attempt(2, { totalDamage: 200e6, deaths: 1, deathAtMs: 196000, durationMs: 200000, raidDeaths: raidCascade }),
  ];
  const { rows, consistency } = buildProgression({ attempts });
  assert.equal(rows[0].deathTiming, 'with-wipe');
  assert.equal(consistency.deathTiming.earlyDeaths, 0);
  assert.equal(consistency.deathTiming.withWipeDeaths, 2);
});

test('death timing: dying well before the raid is flagged as early with the seconds lost', () => {
  const attempts = [
    attempt(1, { totalDamage: 120e6, deaths: 1, deathAtMs: 90000, durationMs: 200000, raidDeaths: raidCascade }),
    attempt(2, { totalDamage: 200e6, deaths: 1, deathAtMs: 196000, durationMs: 200000, raidDeaths: raidCascade }),
  ];
  const { rows, consistency } = buildProgression({ attempts });
  const early = rows.find((r) => r.fightID === 1);
  assert.equal(early.deathTiming, 'early');
  assert.equal(early.diedNth, 1); // first to die
  assert.ok(early.diedBeforeRaidSec >= 100, `should be ~105s early, got ${early.diedBeforeRaidSec}`);
  assert.equal(consistency.deathTiming.earlyDeaths, 1);
  assert.equal(consistency.deathTiming.withWipeDeaths, 1);
  assert.ok(consistency.deathTiming.haveRaidData);
});

test('death timing narrative distinguishes personal early deaths from raid wipes', () => {
  const withRaid = buildProgression({
    attempts: [
      attempt(1, { totalDamage: 200e6, deaths: 1, deathAtMs: 194000, durationMs: 200000, raidDeaths: raidCascade }),
      attempt(2, { totalDamage: 200e6, deaths: 1, deathAtMs: 196000, durationMs: 200000, raidDeaths: raidCascade }),
    ],
  });
  assert.match(withRaid.text, /went down with the raid/i);
  assert.doesNotMatch(withRaid.text, /died EARLY/);
});

test('reportCode: pulls the 16-char code from a URL or passes a bare code', () => {
  assert.equal(reportCode('https://www.warcraftlogs.com/reports/aBcD1234EfGh5678?fight=3'), 'aBcD1234EfGh5678');
  assert.equal(reportCode('aBcD1234EfGh5678'), 'aBcD1234EfGh5678');
  assert.equal(reportCode('  aBcD1234EfGh5678  '), 'aBcD1234EfGh5678');
});

test('difficultyName: known raid ids map, unknown falls through', () => {
  assert.equal(difficultyName(4), 'Heroic');
  assert.equal(difficultyName(5), 'Mythic');
  assert.equal(difficultyName(99), 'diff 99');
  assert.equal(difficultyName(null), null);
});
