import express from 'express';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.js';
import { fetchOverview, fetchDamageSeries } from './wcl/api.js';
import { buildComparison, DEFAULT_LEVEL } from './wcl/comparison.js';
import { buildReport, pickSimilarIndex } from './analysis/compare.js';
import { analyzeSpikes } from './analysis/spikes.js';
import { getGuideReference } from './guide/unholyDkGuide.js';

loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(PROJECT_ROOT, 'public')));

function charParams(query) {
  return {
    name: String(query.name || 'Unreally'),
    serverSlug: String(query.server || 'aggra-portugues'),
    serverRegion: String(query.region || 'EU'),
    zoneID: Number(query.zone || 47),
  };
}

// `refresh=1` bypasses the disk cache for ranking queries (use after logging
// new runs). Any truthy string other than "0"/"false" counts as on.
function wantsRefresh(query) {
  const v = query.refresh;
  return v != null && v !== '' && v !== '0' && v !== 'false';
}

app.get('/api/overview', async (req, res) => {
  try {
    const overview = await fetchOverview({ ...charParams(req.query), refresh: wantsRefresh(req.query) });
    const { raw, ...rest } = overview; // raw payload not needed by the UI
    res.json(rest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/report', async (req, res) => {
  try {
    const encounterID = Number(req.query.encounter);
    if (!encounterID) return res.status(400).json({ error: 'encounter query param required' });
    const level = Math.max(2, Math.min(30, Number(req.query.level || DEFAULT_LEVEL)));
    const compareTo = req.query.compareTo ? String(req.query.compareTo) : null;

    const bundle = await buildComparison({
      ...charParams(req.query),
      encounterID,
      level,
      compareTo,
      refresh: wantsRefresh(req.query),
    });
    res.json(buildReport(bundle));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DPS-over-time series (mine vs one comparison run) for the line chart.
// Lazy/separate from /api/report because the damage-event fetch is heavy;
// the report renders first, this loads after. Cohort + report codes come
// from the (cached) buildComparison, so this only adds the two damage-series
// fetches on top.
app.get('/api/dps-series', async (req, res) => {
  try {
    const encounterID = Number(req.query.encounter);
    if (!encounterID) return res.status(400).json({ error: 'encounter query param required' });
    const level = Math.max(2, Math.min(30, Number(req.query.level || DEFAULT_LEVEL)));
    const compareTo = req.query.compareTo ? String(req.query.compareTo) : null;

    const bundle = await buildComparison({ ...charParams(req.query), encounterID, level, compareTo });

    const mineFight = bundle.mine.detail.fight;
    const myDurationMs = mineFight.keystoneTime ?? mineFight.endTime - mineFight.startTime;
    const targetIndex = pickSimilarIndex(bundle.cohort, myDurationMs, bundle.targetLevel);
    const target = bundle.cohort[targetIndex];
    if (!target) return res.status(404).json({ error: 'no comparison run available' });

    // sequential — gql() has a shared rate-limiter that parallel calls would race
    const mine = await fetchDamageSeries({
      code: bundle.mine.detail.code,
      fightID: bundle.mine.detail.fightID,
      playerName: bundle.params.name,
    });
    const other = await fetchDamageSeries({
      code: target.detail.code,
      fightID: target.detail.fightID,
      playerName: target.meta.name,
    });
    const spikeAnalysis = analyzeSpikes({
      mineDetail: bundle.mine.detail,
      otherDetail: target.detail,
      mineSeries: mine,
      otherSeries: other,
    });
    res.json({ mine, other, otherLabel: target.label ?? null, spikeAnalysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guide', (req, res) => {
  res.json(getGuideReference());
});

app.listen(PORT, () => {
  console.log(`wcl-parse-improver running at http://localhost:${PORT}`);
});
