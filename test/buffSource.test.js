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

test('real Magisters bundle: buffSources fixture has Black Attunement external, Dark Transformation self', () => {
  const bs = magisters.mine.detail.buffSources;
  assert.deepEqual(bs['Black Attunement'], { self: 0, foreign: 1 });
  assert.equal(bs['Dark Transformation'].foreign, 0);
  assert.ok(bs['Dark Transformation'].self > 0);
});

test('buildReport: Black Attunement never appears as an actionable gap despite nonzero uptime', () => {
  const report = buildReport(magisters);
  assert.ok(!report.gaps.some((g) => g.title.includes('Black Attunement')));
  assert.ok(!report.summary.text.includes('Black Attunement'));
  assert.ok(!report.summary.nextSteps.actions.some((a) => a.includes('Black Attunement')));
});

test('buildReport: Black Attunement lands in compNotes, correctly flagged external with its real 6%ish uptime, not "you 0%"', () => {
  const report = buildReport(magisters);
  const note = report.compNotes.find((n) => n.name === 'Black Attunement');
  assert.ok(note, 'Black Attunement should be in compNotes');
  assert.equal(note.external, true);
  assert.ok(note.minePct > 0, `expected nonzero minePct, got ${note.minePct}`);
  assert.ok(note.note.includes('groupmate'));
  assert.ok(!note.note.includes('you 0%'));
});

test('buildReport: a genuine self-managed aura with a real gap is unaffected by the external check', () => {
  const report = buildReport(magisters);
  const festering = report.gaps.find((g) => g.title.includes('Festering Scythe'));
  assert.ok(festering, 'Festering Scythe uptime gap should still be actionable');
});
