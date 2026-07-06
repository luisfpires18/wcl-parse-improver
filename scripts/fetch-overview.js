// Stage 1 verification script: fetch the real zoneRankings payloads, dump
// them to fixtures/, and print the parsed overview as a table.
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

const fixturesDir = path.join(PROJECT_ROOT, 'fixtures');
mkdirSync(fixturesDir, { recursive: true });
writeFileSync(path.join(fixturesDir, 'zoneRankings-playerscore.json'), JSON.stringify(raw.playerscore, null, 2));
writeFileSync(path.join(fixturesDir, 'zoneRankings-dps.json'), JSON.stringify(raw.dps, null, 2));
console.log(`fixtures saved: zoneRankings-playerscore.json, zoneRankings-dps.json\n`);

console.log(`Character: ${character}  (zone ${zoneID})`);
console.log(
  `Best avg: ${fmtPct(overall.bestPerformanceAverage)}  Median avg: ${fmtPct(overall.medianPerformanceAverage)}` +
    (overall.scorePoints ? `  Score points: ${overall.scorePoints.toFixed(1)}` : '') +
    '\n(percentiles = among your own spec at the same keystone level)\n'
);

const rows = dungeons.map((d) => ({
  Dungeon: d.name,
  Level: d.keyLevel ?? '—',
  Time: formatDuration(d.durationMs),
  Runs: d.runs ?? '—',
  Points: typeof d.points === 'number' ? String(Math.floor(d.points)) : '—',
  'Best %': fmtPct(d.bestPercent),
  'Median %': fmtPct(d.medianPercent),
  'Best DPS': typeof d.bestDps === 'number' ? `${(d.bestDps / 1000).toFixed(1)}k` : '—',
}));
console.table(rows);

function fmtPct(v) {
  return typeof v === 'number' ? v.toFixed(1) : '—';
}
