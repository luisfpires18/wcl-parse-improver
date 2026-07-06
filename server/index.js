import express from 'express';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.js';
import { fetchOverview } from './wcl/api.js';
import { buildComparison, DEFAULT_LEVEL } from './wcl/comparison.js';
import { buildReport } from './analysis/compare.js';
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

app.get('/api/overview', async (req, res) => {
  try {
    const overview = await fetchOverview(charParams(req.query));
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

    const bundle = await buildComparison({
      ...charParams(req.query),
      encounterID,
      level,
    });
    res.json(buildReport(bundle));
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
