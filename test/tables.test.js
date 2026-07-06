import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCastsTable,
  parseBuffsTable,
  parseDamageTable,
  parseDeathsTable,
  parseCastEvents,
} from '../server/parse/tables.js';
import { parseCharacterRankings } from '../server/parse/characterRankings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadFixture = (name) =>
  JSON.parse(readFileSync(path.join(ROOT, 'fixtures', name), 'utf8'));

test('parseCastsTable: real Pit casts', () => {
  const parsed = parseCastsTable(loadFixture('table-casts-pit.json'));
  assert.equal(parsed.totalTimeMs, 1742934);
  assert.ok(parsed.abilities.length >= 20);
  assert.ok(parsed.totalCasts > 1000);
  // sorted descending
  assert.ok(parsed.abilities[0].casts >= parsed.abilities[1].casts);
});

test('parseBuffsTable: real Pit buffs', () => {
  const parsed = parseBuffsTable(loadFixture('table-buffs-pit.json'));
  assert.equal(parsed.totalTimeMs, 1742934);
  assert.ok(parsed.auras.length >= 40);
  const dt = parsed.auras.find((a) => a.name === 'Dark Transformation');
  assert.ok(dt, 'Dark Transformation aura present');
  assert.ok(dt.uptimeMs > 0 && dt.uptimeMs <= parsed.totalTimeMs);
});

test('parseDamageTable: real Pit damage', () => {
  const parsed = parseDamageTable(loadFixture('table-damagedone-pit.json'));
  assert.ok(parsed.abilities.length >= 15);
  assert.ok(parsed.totalDamage > 100_000_000);
});

test('parseDeathsTable: real Pit deaths (2 deaths that run)', () => {
  const parsed = parseDeathsTable(loadFixture('table-deaths-pit.json'));
  assert.equal(parsed.deaths.length, 2);
  assert.ok(parsed.deaths.every((d) => typeof d.timestamp === 'number'));
});

test('parseCastEvents filters and orders cast events', () => {
  const casts = parseCastEvents([
    { data: [{ type: 'cast', timestamp: 5 }, { type: 'begincast', timestamp: 1 }, { type: 'cast', timestamp: 2 }] },
    { data: [{ type: 'cast', timestamp: 9 }] },
  ]);
  assert.deepEqual(casts.map((c) => c.timestamp), [2, 5, 9]);
});

test('parseCharacterRankings: real top-run page', () => {
  const parsed = parseCharacterRankings(loadFixture('characterRankings-pit-21.json'));
  assert.equal(parsed.entries.length, 100);
  assert.ok(parsed.entries.every((e) => e.report?.code && typeof e.dps === 'number'));
  assert.ok(parsed.entries.every((e) => e.keyLevel === parsed.entries[0].keyLevel));
});

test('table parsers survive garbage', () => {
  for (const fn of [parseCastsTable, parseBuffsTable, parseDamageTable, parseDeathsTable]) {
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn({}));
  }
});
