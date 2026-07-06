// Stage 2 verification script: build a full comparison bundle for one dungeon
// and save it as a fixture for analysis development.
//
// Usage: node scripts/fetch-comparison.js [encounterID] [level]
//   default encounter: 10658 (Pit of Saron — worst median parse), default level: 20
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from '../server/env.js';
import { buildComparison, DEFAULT_LEVEL } from '../server/wcl/comparison.js';
import { formatDuration } from '../server/parse/zoneRankings.js';

loadEnv();

const [encounterArg = '10658', levelArg = String(DEFAULT_LEVEL)] = process.argv.slice(2);
const level = Number(levelArg);

const bundle = await buildComparison({
  name: 'Unreally',
  serverSlug: 'aggra-portugues',
  serverRegion: 'EU',
  zoneID: 47,
  encounterID: Number(encounterArg),
  level,
});

// keep the existing "-plus0" fixture name for the default level so every
// test/fixture reference stays valid; other levels get their own filename
const file = path.join(
  PROJECT_ROOT,
  'fixtures',
  level === DEFAULT_LEVEL ? `comparison-${encounterArg}-plus0.json` : `comparison-${encounterArg}-lvl${level}.json`
);
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
  ...bundle.cohort.map((c) => row(`${c.label ?? 'cohort'}: ${c.meta.name}`, c.meta, c.detail)),
]);
