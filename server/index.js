import express from 'express';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.js';
import { fetchOverview } from './wcl/api.js';
import { buildComparison } from './wcl/comparison.js';
import { buildReport } from './analysis/compare.js';

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
    const levelOffset = Math.max(0, Math.min(2, Number(req.query.offset || 0)));
    const cohortSize = Math.max(2, Math.min(10, Number(req.query.size || 5)));

    const bundle = await buildComparison({
      ...charParams(req.query),
      encounterID,
      levelOffset,
      cohortSize,
    });
    res.json(buildReport(bundle));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`wcl-parse-improver running at http://localhost:${PORT}`);
});
