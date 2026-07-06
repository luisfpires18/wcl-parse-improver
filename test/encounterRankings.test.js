import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseEncounterRankings,
  summarizeBestLevel,
  median,
} from '../server/parse/encounterRankings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'encounterRankings-pit.json'), 'utf8')
);

test('parseEncounterRankings extracts all logged runs, best first', () => {
  const parsed = parseEncounterRankings(fixture);
  assert.equal(parsed.totalKills, 8);
  assert.equal(parsed.runs.length, 8);
  // sorted: highest key level first
  assert.equal(parsed.runs[0].keyLevel, 21);
  assert.ok(parsed.runs[0].report.code);
  assert.ok(parsed.runs.every((r) => typeof r.rankPercent === 'number'));
});

test('summarizeBestLevel reproduces the site Best%/Median% (Pit: 31.1/31.1)', () => {
  const summary = summarizeBestLevel(parseEncounterRankings(fixture));
  assert.equal(summary.keyLevel, 21);
  assert.equal(summary.runsAtLevel, 1);
  assert.ok(Math.abs(summary.bestPercent - 31.06) < 0.1);
  assert.ok(Math.abs(summary.medianPercent - 31.06) < 0.1);
  assert.equal(summary.bestRun.report.code, 'FVbnRwACkMhPzBTx');
});

test('parseEncounterRankings survives garbage', () => {
  assert.deepEqual(parseEncounterRankings(null).runs, []);
  assert.deepEqual(parseEncounterRankings({}).runs, []);
});

test('median handles odd/even/empty', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});
