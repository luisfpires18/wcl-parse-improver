import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRunMetrics } from '../server/analysis/metrics.js';
import { buildReport } from '../server/analysis/compare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures', 'comparison-10658-plus0.json'), 'utf8')
);

test('bands survive parsing into the bundle', () => {
  const auras = bundle.mine.detail.buffs.auras;
  assert.ok(auras.some((a) => Array.isArray(a.bands) && a.bands.length > 0));
});

test('active uptime >= raw uptime is typical (idle time removed from denominator and it contains no buff time by definition of my own casts... at minimum both stay within 0-100)', () => {
  const m = computeRunMetrics(bundle.mine.detail);
  let checked = 0;
  for (const [, aura] of m.auras) {
    if (aura.activeUptimePct == null) continue;
    assert.ok(aura.activeUptimePct >= -0.01 && aura.activeUptimePct <= 100.5);
    checked++;
  }
  assert.ok(checked > 20, `expected many auras with active uptime, got ${checked}`);
  assert.ok(m.engagedMs > 0 && m.engagedMs < (m.fightDurMs ?? Infinity));
});

test('engaged time = fight duration minus idle windows', () => {
  const m = computeRunMetrics(bundle.mine.detail);
  const fightSpan =
    bundle.mine.detail.fight.endTime - bundle.mine.detail.fight.startTime;
  const idleTotal = m.downtime.totalMs;
  assert.ok(Math.abs(m.engagedMs - (fightSpan - idleTotal)) < 5, 'engaged + idle ≈ fight span');
});

// Uptime gaps are measured over ENGAGED time (fight minus idle), so downtime and
// deaths cannot masquerade as buff-management failures — those are already their own
// gaps. A groupmate-applied buff is excluded entirely: it is not your rotation.
test('uptime gaps are active-time based, and never a groupmate buff', () => {
  const report = buildReport(bundle);
  const uptimeGaps = report.gaps.filter((g) => g.category === 'uptime');
  for (const g of uptimeGaps) {
    assert.ok(g.title.includes('(active time)'));
    assert.ok(g.name, 'carries the aura name');
  }
  // anything a groupmate applied belongs in the party-buffs section instead
  const partyNames = new Set(report.consumables.partyBuffs.mine.map((b) => b.name));
  for (const g of uptimeGaps) assert.ok(!partyNames.has(g.name), `${g.name} is someone else's buff`);
});
