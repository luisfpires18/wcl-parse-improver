import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGuideReference } from '../server/guide/unholyDkGuide.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8')
);
const magisters = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-12811-plus0.json'), 'utf8')
);

test('getGuideReference returns a complete, cited structure', () => {
  const g = getGuideReference();
  assert.ok(g.meta.sourceUrl.startsWith('https://'));
  assert.ok(g.meta.fetchedAt);
  assert.ok(g.opener.singleTarget.length > 0);
  assert.ok(g.opener.multiTarget.length > 0);
  assert.ok(g.priority.singleTarget.length > 0);
  assert.ok(g.priority.multiTarget.length > 0);
  assert.ok(g.breakpoints.length >= 3);
  assert.ok(g.mechanicNotes.length >= 1);
  // provenance: mechanic notes must cite a source distinct from the guide URL
  for (const n of g.mechanicNotes) assert.ok(n.source && n.source !== g.meta.sourceUrl);
});

test('guide breakpoints cover both the baseline and Forbidden Knowledge-transformed spenders', () => {
  const g = getGuideReference();
  const rules = g.breakpoints.map((b) => b.rule);
  assert.ok(rules.includes('Death Coil'));
  assert.ok(rules.includes('Epidemic'));
  assert.ok(rules.includes('Necrotic Coil'));
  assert.ok(rules.includes('Graveyard'));
});

test('buildReport does not attach the guide — it is served separately via /api/guide', () => {
  // guide content is spec-wide static reference, not per-run data; it lives
  // on its own nav page/endpoint now, not bundled into every report
  const report = buildReport(bundle);
  assert.equal(report.guide, undefined);
});

test('ability advice for Graveyard explains the Forbidden Knowledge mechanic inline (real Magisters gap)', () => {
  const report = buildReport(magisters);
  const g = report.gaps.find((x) => x.category === 'ability' && x.title.startsWith('Graveyard'));
  assert.ok(g, 'Graveyard should be a real gap in the Magisters fixture');
  assert.ok(g.advice.includes('Forbidden Knowledge'));
  assert.ok(g.advice.includes('5+ targets'));
});
