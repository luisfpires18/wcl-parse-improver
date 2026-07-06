// Stage 1 verification script: fetch the real zoneRankings payload, dump it
// to fixtures/zoneRankings.json, and print the parsed overview as a table.
//
// Usage: node scripts/fetch-overview.js [name serverSlug region zoneID]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from '../server/env.js';
import { fetchOverview } from '../server/wcl/api.js';
import { formatDuration } from '../server/parse/zoneRankings.js';

loadEnv();

const [name = 'Unreally', serverSlug = 'aggra-portugues', serverRegion = 'EU', zoneArg = '47'] =
  process.argv.slice(2);
const zoneID = Number(zoneArg);

const { character, raw, overall, dungeons } = await fetchOverview({
  name,
  serverSlug,
  serverRegion,
  zoneID,
});

const fixtureFile = path.join(PROJECT_ROOT, 'fixtures', 'zoneRankings.json');
mkdirSync(path.dirname(fixtureFile), { recursive: true });
writeFileSync(fixtureFile, JSON.stringify(raw, null, 2));
console.log(`raw zoneRankings saved to ${fixtureFile}\n`);

console.log(`Character: ${character}  (zone ${zoneID})`);
console.log(
  `Best avg: ${fmtPct(overall.bestPerformanceAverage)}  Median avg: ${fmtPct(overall.medianPerformanceAverage)}\n`
);

const rows = dungeons.map((d) => ({
  Dungeon: d.name,
  Level: d.keyLevel ?? '—',
  Time: formatDuration(d.fastestKillMs),
  Runs: d.runs ?? '—',
  'Best %': fmtPct(d.bestPercent),
  'Median %': fmtPct(d.medianPercent),
  'Best DPS': d.bestAmount ? `${(d.bestAmount / 1000).toFixed(1)}k` : '—',
  Report: d.report ? `${d.report.code}#${d.report.fightID}` : '—',
}));
console.table(rows);

function fmtPct(v) {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}
