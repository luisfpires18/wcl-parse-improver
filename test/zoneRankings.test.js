import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeRanking,
  parseZoneRankings,
  buildOverview,
  formatDuration,
} from '../server/parse/zoneRankings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadFixture = (name) =>
  JSON.parse(readFileSync(path.join(ROOT, 'fixtures', name), 'utf8'));

test('decodeRanking unpacks key level, dps and duration', () => {
  // Real values from fixtures/zoneRankings-dps.json (Algeth'ar Academy +20)
  const decoded = decodeRanking({ bestAmount: 400196236.39447, fastestKill: -398228140 });
  assert.equal(decoded.keyLevel, 20);
  assert.ok(Math.abs(decoded.dps - 196236.39) < 1);
  assert.equal(decoded.durationMs, 1771860); // 29:31
});

test('decodeRanking leaves small (unpacked) amounts alone', () => {
  const decoded = decodeRanking({ bestAmount: 486.77, fastestKill: 1771860, bestRank: { ilvl: 20 } });
  assert.equal(decoded.keyLevel, 20);
  assert.equal(decoded.dps, 486.77);
  assert.equal(decoded.durationMs, 1771860);
});

test('parseZoneRankings survives garbage without throwing', () => {
  assert.deepEqual(parseZoneRankings(null).rankings, []);
  assert.deepEqual(parseZoneRankings({ nope: true }).rankings, []);
  assert.deepEqual(parseZoneRankings({ rankings: [null, 42, {}] }).rankings.length, 1);
});

test('buildOverview merges real playerscore + dps fixtures', () => {
  const score = loadFixture('zoneRankings-playerscore.json');
  const dps = loadFixture('zoneRankings-dps.json');
  const { overall, dungeons } = buildOverview(score, dps);

  assert.equal(dungeons.length, 8, 'expected 8 ranked dungeons');

  const algethar = dungeons.find((d) => d.name === "Algeth'ar Academy");
  assert.ok(algethar);
  assert.equal(algethar.keyLevel, 20);
  assert.equal(algethar.runs, 18); // site Runs column
  assert.ok(Math.abs(algethar.bestDps - 196236.39) < 1); // site 196.24K
  assert.equal(formatDuration(algethar.durationMs), '29:31'); // site 29:31
  assert.ok(Math.floor(algethar.points) === 486); // site 486

  // every dungeon: sane percentiles and key levels 20-21
  for (const d of dungeons) {
    assert.ok(d.keyLevel >= 20 && d.keyLevel <= 21, `${d.name} key level ${d.keyLevel}`);
    assert.ok(d.bestPercent > 0 && d.bestPercent <= 100);
    assert.ok(d.medianPercent > 0 && d.medianPercent <= d.bestPercent + 0.001);
  }
  assert.ok(overall.bestPerformanceAverage > 0);
});
