import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBuffWindows, sharedBuffLanes } from '../server/analysis/buffWindows.js';
import { buildTimeline } from '../server/analysis/timeline.js';
import { truncateDetail } from '../server/analysis/truncate.js';

// fight runs 1000 -> 101000 on the report clock (100s long)
const START = 1000;
const END = 101000;
const band = (relStartSec, relEndSec) => ({ startTime: START + relStartSec * 1000, endTime: START + relEndSec * 1000 });

function detail({ auras = [], castEvents = [], abilities = [] } = {}) {
  return {
    fight: { startTime: START, endTime: END },
    player: { name: 'Me' },
    casts: { totalTimeMs: 100000, totalCasts: castEvents.length, abilities },
    buffs: { totalTimeMs: 100000, auras },
    damage: { totalDamage: 1000, abilities: [{ name: 'The Hunt', total: 1000, hits: 1 }] },
    deaths: { deaths: [] },
    castEvents,
    resourceEvents: [],
  };
}

// Inertia: a self-applied PROC — never cast, so invisible to every cast-based
// view. Short windows, re-procced often. THE case this whole feature exists for.
const inertia = { name: 'Inertia', guid: 1, uses: 2, uptimeMs: 20000, bands: [band(10, 20), band(50, 60)] };
// a raid buff someone else put on me
const lust = { name: 'Bloodlust', guid: 2, uses: 1, uptimeMs: 40000, bands: [band(0, 40)] };
// a consumable that is simply up all fight
const flask = { name: 'Flask of the Magisters', guid: 3, uses: 1, uptimeMs: 100000, bands: [band(0, 100)] };

const SOURCES = {
  Inertia: { self: 2, foreign: 0 },
  Bloodlust: { self: 0, foreign: 1 }, // external => excluded
  'Flask of the Magisters': { self: 1, foreign: 0 }, // self, but a consumable => excluded
};

test('selectBuffWindows: keeps a self-applied proc, drops raid buffs and consumables', () => {
  const got = selectBuffWindows(detail({ auras: [inertia, lust, flask] }), SOURCES);
  assert.deepEqual(got.map((w) => w.name), ['Inertia']);
  assert.equal(got[0].uptimePct, 20); // 20s of a 100s fight
  assert.equal(got[0].uses, 2);
});

// The bug this guards, found on a real Havoc log: Inertia procs off every
// Vengeful Retreat / Fel Rush, so it re-applies dozens of times in short windows.
// An earlier cut dropped any aura with >20 windows (to kill a spammy absorb proc)
// and capped lanes at the 6 highest-UPTIME buffs. Inertia lost on both counts —
// it is short and frequent by nature — so the one buff that explained the entire
// DPS gap was the one buff never drawn.
test('selectBuffWindows: a short, frequently-reapplied proc still earns a lane', () => {
  const frequent = {
    name: 'Inertia',
    guid: 1,
    uses: 30,
    uptimeMs: 0,
    bands: Array.from({ length: 30 }, (_, i) => band(i * 3, i * 3 + 1)), // 30 x 1s windows
  };
  const got = selectBuffWindows(detail({ auras: [frequent] }), SOURCES);
  assert.deepEqual(got.map((w) => w.name), ['Inertia']);
  assert.equal(got[0].bands.length, 30);
});

test('selectBuffWindows: a short buff is not crowded out by long ones', () => {
  // five long buffs that would win every uptime contest, plus the short proc
  const long = Array.from({ length: 5 }, (_, i) => ({
    name: `Long${i}`,
    guid: 10 + i,
    uses: 1,
    uptimeMs: 0,
    bands: [band(0, 70)], // 70% uptime each
  }));
  const sources = { ...SOURCES, ...Object.fromEntries(long.map((a) => [a.name, { self: 1, foreign: 0 }])) };
  const names = selectBuffWindows(detail({ auras: [...long, inertia] }), sources).map((w) => w.name);
  assert.ok(names.includes('Inertia'), `the short proc must survive, got ${names.join(', ')}`);
});

test('selectBuffWindows: bands come back FIGHT-relative and clamped to the fight', () => {
  const straddles = {
    name: 'Inertia',
    guid: 1,
    uses: 2,
    uptimeMs: 0,
    bands: [
      { startTime: START - 5000, endTime: START + 10000 }, // pre-pull -> clamp to 0
      { startTime: START + 95000, endTime: END + 30000 }, // overruns -> clamp to 100s
    ],
  };
  const [w] = selectBuffWindows(detail({ auras: [straddles] }), SOURCES);
  assert.deepEqual(w.bands, [
    { startMs: 0, endMs: 10000 },
    { startMs: 95000, endMs: 100000 },
  ]);
});

test('selectBuffWindows: a near-permanent aura is a passive, not a window', () => {
  const passive = { name: 'Inertia', guid: 1, uses: 1, uptimeMs: 0, bands: [band(0, 95)] }; // 95%
  assert.deepEqual(selectBuffWindows(detail({ auras: [passive] }), SOURCES), []);
});

test('selectBuffWindows: an aura with no source entry at all is not assumed to be yours', () => {
  const unknown = { name: 'Mystery Aura', guid: 9, uses: 1, uptimeMs: 10000, bands: [band(0, 10)] };
  assert.deepEqual(selectBuffWindows(detail({ auras: [unknown] }), SOURCES), []);
});

test('sharedBuffLanes: one lane set across both runs, so the rows line up', () => {
  const mine = [{ name: 'Inertia', uptimePct: 5, uses: 1, bands: [] }];
  const theirs = [
    { name: 'Inertia', uptimePct: 20, uses: 4, bands: [] },
    { name: 'Metamorphosis', uptimePct: 30, uses: 2, bands: [] },
  ];
  // Ranked by COMBINED uptime across both runs, so a buff only ONE of them ever
  // had still earns a lane — that asymmetry is the finding, not noise to drop.
  assert.deepEqual(sharedBuffLanes(mine, theirs), ['Metamorphosis', 'Inertia']);
});

test('buildTimeline: both runs get the same buff lanes; an absent buff is an empty lane', () => {
  const abilities = [{ name: 'The Hunt', guid: 7, casts: 1 }];
  const casts = [{ timestamp: START + 15000, abilityGameID: 7 }];
  const mineDetail = detail({ auras: [], abilities, castEvents: casts }); // never had Inertia
  const otherDetail = detail({ auras: [inertia], abilities, castEvents: casts }); // held it

  const t = buildTimeline(mineDetail, otherDetail, SOURCES);
  assert.deepEqual(t.buffLaneNames, ['Inertia']);
  // the finding IS the empty lane: they held it, you never did
  assert.deepEqual(t.mine.buffLanes, [{ name: 'Inertia', bands: [] }]);
  assert.equal(t.other.buffLanes[0].bands.length, 2);
  assert.equal(t.other.buffLanes[0].bands[0].startMs, 10000);
});

test('buildTimeline: no buffSources => no buff lanes (M+ behaviour unchanged)', () => {
  const abilities = [{ name: 'The Hunt', guid: 7, casts: 1 }];
  const casts = [{ timestamp: START + 15000, abilityGameID: 7 }];
  const t = buildTimeline(detail({ auras: [inertia], abilities, castEvents: casts }), detail({ abilities, castEvents: casts }));
  assert.deepEqual(t.buffLaneNames, []);
  assert.deepEqual(t.mine.buffLanes, []);
});

test('truncateDetail: buff bands are clipped to the wipe window, not left overrunning it', () => {
  const d = detail({
    auras: [
      {
        name: 'Inertia',
        guid: 1,
        uses: 3,
        uptimeMs: 30000,
        bands: [
          band(5, 15), // wholly inside a 40s cutoff
          band(35, 45), // STRADDLES the cutoff -> must be cut at 40s
          band(60, 70), // entirely after -> must be dropped
        ],
      },
    ],
  });
  const t = truncateDetail(d, 40); // keep only the first 40s

  const aura = t.buffs.auras.find((a) => a.name === 'Inertia');
  assert.equal(aura.bands.length, 2, 'the post-cutoff band is dropped');
  assert.equal(aura.bands[1].endTime, START + 40000, 'the straddling band is cut at the cutoff');
  assert.equal(aura.uptimeMs, 15000, 'uptime recomputed from the surviving bands (10s + 5s)');
  assert.equal(t.buffs.totalTimeMs, 40000, 'uptime is now measured against the window, not the full kill');
});

test('truncateDetail: an aura that only existed after the cutoff disappears entirely', () => {
  const d = detail({ auras: [{ name: 'Inertia', guid: 1, uses: 1, uptimeMs: 10000, bands: [band(60, 70)] }] });
  assert.deepEqual(truncateDetail(d, 40).buffs.auras, []);
});
