import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBuffSources } from '../server/parse/tables.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const magisters = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-12811-plus0.json'), 'utf8')
);
const pit = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8'));

test('classifyBuffSources: real Magisters events prove Black Attunement is external, Dark Transformation is self', () => {
  const events = [
    { data: [{ type: 'applybuff', sourceID: 4, targetID: 5, abilityGameID: 403295 }] },
    { data: [{ type: 'applybuff', sourceID: 5, targetID: 5, abilityGameID: 1233448 }] },
  ];
  const nameByGameID = new Map([
    [403295, 'Black Attunement'],
    [1233448, 'Dark Transformation'],
  ]);
  const result = classifyBuffSources(events, 5, nameByGameID);
  assert.deepEqual(result['Black Attunement'], { self: 0, foreign: 1 });
  assert.deepEqual(result['Dark Transformation'], { self: 1, foreign: 0 });
});

test('classifyBuffSources round-trips through JSON (plain object, not a Map)', () => {
  const result = classifyBuffSources(
    [{ data: [{ type: 'applybuff', sourceID: 1, targetID: 2, abilityGameID: 99 }] }],
    2,
    new Map([[99, 'Test Buff']])
  );
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.deepEqual(roundTripped['Test Buff'], { self: 0, foreign: 1 });
});

test('real Magisters bundle: buffSources classifies Dark Transformation as self (structural, fixture-independent)', () => {
  const bs = magisters.mine.detail.buffSources;
  assert.ok(bs['Dark Transformation'], 'Dark Transformation should have buffSources data');
  assert.equal(bs['Dark Transformation'].foreign, 0);
  assert.ok(bs['Dark Transformation'].self > 0);
});

// classifyBuffSources still does the load-bearing job, it just feeds a different
// place now: an externally-applied aura becomes a PARTY BUFF (section 4) instead of
// being ranked as a rotation gap the player could have fixed.
test('an externally-applied aura becomes a party buff, never an actionable gap', () => {
  const report = buildReport(magisters);
  const party = report.consumables.partyBuffs.mine.map((b) => b.name);
  assert.ok(party.length >= 1, 'real run: groupmates buffed me');
  for (const name of party) {
    assert.ok(!report.gaps.some((g) => g.name === name), `${name} is not my rotation`);
  }
});

test('a self-managed aura with a real gap is unaffected by the external check', () => {
  const report = buildReport(pit);
  const uptimeGaps = report.gaps.filter((g) => g.category === 'uptime');
  const party = new Set(report.consumables.partyBuffs.mine.map((b) => b.name));
  // whatever survives as an uptime gap must be a buff I apply to MYSELF
  for (const g of uptimeGaps) assert.ok(!party.has(g.name));
});
