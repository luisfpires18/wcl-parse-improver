// Stage 2 verification script: build a full comparison bundle for one dungeon
// and save it as a fixture for analysis development.
//
// Usage: node scripts/fetch-comparison.js [encounterID] [levelOffset] [cohortSize]
//   default encounter: 10658 (Pit of Saron — worst median parse)
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from '../server/env.js';
import { buildComparison } from '../server/wcl/comparison.js';
import { formatDuration } from '../server/parse/zoneRankings.js';

loadEnv();

const [encounterArg = '10658', offsetArg = '0', sizeArg = '5'] = process.argv.slice(2);

const bundle = await buildComparison({
  name: 'Unreally',
  serverSlug: 'aggra-portugues',
  serverRegion: 'EU',
  zoneID: 47,
  encounterID: Number(encounterArg),
  levelOffset: Number(offsetArg),
  cohortSize: Number(sizeArg),
});

const file = path.join(PROJECT_ROOT, 'fixtures', `comparison-${encounterArg}-plus${offsetArg}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(bundle, null, 1));
console.log(`bundle saved to ${file}\n`);

const row = (label, meta, detail) => ({
  Run: label,
  Key: detail.fight.keystoneLevel ?? meta.keyLevel ?? '—',
  Time: formatDuration(detail.fight.keystoneTime ?? meta.durationMs),
  DPS: `${((meta.dps ?? 0) / 1000).toFixed(1)}k`,
  Casts: detail.casts.totalCasts,
  CPM: (detail.casts.totalCasts / (detail.casts.totalTimeMs / 60000)).toFixed(1),
  Deaths: detail.deaths.deaths.length,
  Events: detail.castEvents.length,
});

console.log(`Dungeon: ${bundle.mine.detail.fight.name}  target level: +${bundle.targetLevel}`);
console.table([
  row(`ME (${bundle.mine.meta.bestPercent?.toFixed(1)}%)`, bundle.mine.meta, bundle.mine.detail),
  ...bundle.cohort.map((c, i) => row(`top${i + 1} ${c.meta.name}`, c.meta, c.detail)),
]);
