// Stage 3 verification: build the gap report from a saved comparison bundle
// (offline — no API calls) and print it human-readable.
//
// Usage: node scripts/analyze.js [fixtures/comparison-10658-plus0.json]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../server/env.js';
import { buildReport } from '../server/analysis/compare.js';
import { formatDuration } from '../server/parse/zoneRankings.js';

const file = process.argv[2] ?? path.join(PROJECT_ROOT, 'fixtures', 'comparison-10658-plus0.json');
const bundle = JSON.parse(readFileSync(file, 'utf8'));
const report = buildReport(bundle);

const h = report.headline;
console.log(`\n=== ${h.dungeon} +${h.myKeyLevel} — my parse ${h.myBestPercent}% ===`);
console.log(
  `Me: ${(h.myDps / 1000).toFixed(1)}k DPS  vs  top-${h.cohortSize} median @ +${h.cohortLevel}: ` +
    `${(h.cohortMedianDps / 1000).toFixed(1)}k  (gap ${h.dpsGapPct}%)`
);
console.log(`Cohort: ${h.cohortNames.join(', ')}\n`);

console.log('--- Biggest gaps first ---');
for (const g of report.gaps) {
  console.log(`\n[${g.severity.toString().padStart(4)}] ${g.title}`);
  console.log(`       mine: ${g.mine}${g.unit ? ' ' + g.unit : ''}   cohort median: ${g.cohort}${g.unit ? ' ' + g.unit : ''}`);
  console.log(`       ${g.advice}`);
}

console.log('\n--- Downtime windows (mine, biggest first) ---');
for (const w of report.tables.downtime.windows ?? []) {
  console.log(`  at ${formatDuration(w.startRelMs)}  idle ${(w.durMs / 1000).toFixed(1)}s`);
}

if (report.compNotes?.length) {
  console.log('\n--- Group comp / talent differences (not actionable) ---');
  for (const n of report.compNotes) console.log(`  ${n.name}: cohort ~${n.cohortPct}%, you 0%`);
}

console.log('\n--- Honesty ---');
console.log(
  `DPS gap: ${report.honesty.dpsGapPct}% | rotational metrics above estimate ~${report.honesty.explainedPct}% of it explained.`
);
console.log(report.honesty.note);
