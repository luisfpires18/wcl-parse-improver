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

console.log('\n--- Summary ---');
console.log(report.summary.text);

console.log('\n--- Downtime windows (mine, biggest first) ---');
for (const w of report.tables.downtime.windows ?? []) {
  console.log(`  at ${formatDuration(w.startRelMs)}  idle ${(w.durMs / 1000).toFixed(1)}s`);
}

console.log(`\n--- Deaths by player (mine: ${report.tables.deaths.mine.length}) ---`);
for (const c of report.tables.deaths.cohortByPlayer) console.log(`  ${c.name}: ${c.deaths}`);

console.log('\n--- RP spender mix & waste (mine vs cohort median) ---');
const sp = report.tables.spender;
console.log(`  Death Coil casts: ${sp.mine.deathCoil} vs ${sp.cohortDeathCoilCasts}`);
console.log(`  Epidemic casts:   ${sp.mine.epidemic} vs ${sp.cohortEpidemicCasts}`);
const rw = report.tables.rpWaste;
console.log(`  RP generated:     ${Math.round(rw.mine.netGain)} vs ${rw.cohortNetGain}`);
console.log(`  RP wasted:        ${Math.round(rw.mine.waste)} vs ${rw.cohortWasteAmount}`);

if (report.downtimeNotes?.length) {
  console.log('\n--- Uptime losses caused by downtime/deaths (not buff management) ---');
  for (const n of report.downtimeNotes) console.log(`  ${n.note}`);
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

console.log(`\n--- What to do next time at +${h.myKeyLevel} ---`);
console.log(report.summary.nextSteps.recap);
report.summary.nextSteps.actions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
