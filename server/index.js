import express from 'express';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.js';
import { fetchOverview } from './wcl/api.js';

loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(PROJECT_ROOT, 'public')));

app.get('/api/overview', async (req, res) => {
  try {
    const {
      name = 'Unreally',
      server = 'aggra-portugues',
      region = 'EU',
      zone = '47',
    } = req.query;
    const overview = await fetchOverview({
      name: String(name),
      serverSlug: String(server),
      serverRegion: String(region),
      zoneID: Number(zone),
    });
    // raw payload not needed by the UI
    const { raw, ...rest } = overview;
    res.json(rest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`wcl-parse-improver running at http://localhost:${PORT}`);
});
