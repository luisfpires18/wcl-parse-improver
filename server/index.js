import express from 'express';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.js';
import { fetchOverview, fetchDamageSeries, fetchGameClasses, detectCharacter } from './wcl/api.js';
import { buildComparison, DEFAULT_LEVEL } from './wcl/comparison.js';
import {
  buildRaidReport,
  buildRaidPull,
  buildRaidBossReport,
  buildBossRotations,
  DEFAULT_RAID_DIFFICULTY,
} from './wcl/raid.js';
import { fetchRaidOverview } from './wcl/raidZones.js';
import { buildReport } from './analysis/compare.js';
import { loadCharacters, upsertCharacter, removeCharacter, setCharacterHidden } from './characters.js';

loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(PROJECT_ROOT, 'public')));
// shared/ holds code imported by BOTH the server and the browser (the
// rotation-match maths). Serving it means there is exactly one copy.
app.use('/shared', express.static(path.join(PROJECT_ROOT, 'shared')));

// No defaults: these used to fall back to the author's own character, so a request
// with missing params silently analysed someone else's toon.
function charParams(query) {
  const name = String(query.name || '').trim();
  const serverSlug = String(query.server || '').trim();
  if (!name || !serverSlug) throw new Error('name and server query params are required');
  return {
    name,
    serverSlug,
    serverRegion: String(query.region || 'EU').trim(),
    zoneID: Number(query.zone || 0) || undefined,
  };
}

function specParams(query) {
  const className = String(query.className || '').trim();
  const specName = String(query.specName || '').trim();
  if (!className || !specName) throw new Error('className and specName query params are required');
  // display-only; used so a "wrong class" error reads "Death Knight", not "DeathKnight"
  const classLabel = String(query.classLabel || '').trim() || null;
  return { className, specName, classLabel };
}

// `refresh=1` bypasses the disk cache for ranking queries (use after logging
// new runs). Any truthy string other than "0"/"false" counts as on.
function wantsRefresh(query) {
  const v = query.refresh;
  return v != null && v !== '' && v !== '0' && v !== 'false';
}

app.get('/api/overview', async (req, res) => {
  try {
    // No specName => all specs (the pre-spec-filter behaviour). Do NOT fall back
    // to the DK/Unholy default here: it would silently filter another class's
    // overview by a spec it doesn't have.
    const overview = await fetchOverview({
      ...charParams(req.query),
      specName: req.query.specName ? String(req.query.specName) : null,
      refresh: wantsRefresh(req.query),
    });
    const { raw, ...rest } = overview; // raw payload not needed by the UI
    res.json(rest);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
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
      ...specParams(req.query),
      encounterID,
      level,
      compareTo,
      refresh: wantsRefresh(req.query),
    });
    res.json(buildReport(bundle));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// DPS-over-time series (mine vs one comparison run) for the line chart.
// Lazy/separate from /api/report because the damage-event fetch is heavy: the
// report renders first, the chart loads after. The opponent is already chosen by
// the (cached) buildComparison, so this only adds the two damage-series fetches.
app.get('/api/dps-series', async (req, res) => {
  try {
    const encounterID = Number(req.query.encounter);
    if (!encounterID) return res.status(400).json({ error: 'encounter query param required' });
    const level = Math.max(2, Math.min(30, Number(req.query.level || DEFAULT_LEVEL)));
    const compareTo = req.query.compareTo ? String(req.query.compareTo) : null;

    const bundle = await buildComparison({ ...charParams(req.query), ...specParams(req.query), encounterID, level, compareTo });
    const other = bundle.other;

    // sequential — gql() has a shared rate-limiter that parallel calls would race
    const mineSeries = await fetchDamageSeries({
      code: bundle.mine.detail.code,
      fightID: bundle.mine.detail.fightID,
      playerName: bundle.params.name,
      server: bundle.params.serverSlug, // disambiguate same-named toons in one log
      className: bundle.params.className,
    });
    const otherSeries = await fetchDamageSeries({
      code: other.detail.code,
      fightID: other.detail.fightID,
      playerName: other.meta.name,
    });
    res.json({ mine: mineSeries, other: otherSeries, otherLabel: other.meta.name });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// All raids of the current expansion and how this character parsed in each.
// This is the raid view's DEFAULT — you shouldn't need a report URL to look at a
// boss you killed. Pasting a log stays, for the one thing rankings can't show: wipes.
app.get('/api/raid/overview', async (req, res) => {
  try {
    const { name, serverSlug, serverRegion } = charParams(req.query);
    const overview = await fetchRaidOverview({
      name,
      serverSlug,
      serverRegion,
      specName: req.query.specName ? String(req.query.specName) : null,
      refresh: wantsRefresh(req.query),
    });
    res.json({ zones: overview });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// How the top N ranked players of a class+spec play one boss — rotation only.
// Note there is no charParams here: this is not about you, so it needs no
// character, no log and no kill of your own. It's the "learn the fight before you
// pull it" view.
app.get('/api/raid/rotations', async (req, res) => {
  try {
    const encounterID = Number(req.query.encounter);
    if (!encounterID) return res.status(400).json({ error: 'encounter query param required' });
    const topN = Math.max(2, Math.min(10, Number(req.query.top) || 10)); // each player costs ~5 API calls
    const rotations = await buildBossRotations({
      ...specParams(req.query),
      encounterID,
      difficulty: req.query.difficulty ? Number(req.query.difficulty) : DEFAULT_RAID_DIFFICULTY,
      topN,
      refresh: wantsRefresh(req.query),
    });
    res.json(rotations);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// Analyse a raid boss from the character's own best ranked kill — no log needed.
app.get('/api/raid/boss', async (req, res) => {
  try {
    const encounterID = Number(req.query.encounter);
    if (!encounterID) return res.status(400).json({ error: 'encounter query param required' });
    const report = await buildRaidBossReport({
      ...charParams(req.query),
      ...specParams(req.query),
      encounterID,
      difficulty: req.query.difficulty ? Number(req.query.difficulty) : DEFAULT_RAID_DIFFICULTY,
      compareTo: req.query.compareTo ? String(req.query.compareTo) : null,
      refresh: wantsRefresh(req.query),
    });
    res.json(report);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// Raid progression from a pasted report — kills OR wipes. With no `encounter`
// param it returns just the boss menu (cheap); with one, it fetches the
// player's casts on every pull and the ranked-kill benchmark (heavier).
app.get('/api/raid/report', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code query param required (report code or URL)' });
    const encounterID = req.query.encounter ? Number(req.query.encounter) : null;
    const difficulty = req.query.difficulty ? Number(req.query.difficulty) : DEFAULT_RAID_DIFFICULTY;
    // power users can widen/narrow the per-boss pull sample (each pull is a few
    // API calls); clamp so a bad value can't ask for hundreds of fetches
    const maxAttempts = Math.max(2, Math.min(40, Number(req.query.maxAttempts) || 24));

    const report = await buildRaidReport({
      ...charParams(req.query),
      ...specParams(req.query),
      code,
      encounterID,
      difficulty,
      maxAttempts,
      benchmark: req.query.benchmark !== '0',
      refresh: wantsRefresh(req.query),
    });
    res.json(report);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// One raid pull, charted vs the top parser's kill: DPS-over-time + rotation
// timeline + cast order. The comparison window is normalised by BOSS HEALTH —
// a wipe is only compared against the slice of the kill covering the same
// 100%→X% of the boss. Heavy (damage events for both runs), so it's a separate
// lazy call, like /api/dps-series is for M+.
app.get('/api/raid/pull', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const encounterID = Number(req.query.encounter);
    const fightID = Number(req.query.fight);
    if (!code || !encounterID || !fightID) {
      return res.status(400).json({ error: 'code, encounter and fight query params are required' });
    }
    const difficulty = req.query.difficulty ? Number(req.query.difficulty) : DEFAULT_RAID_DIFFICULTY;

    const pull = await buildRaidPull({
      ...charParams(req.query),
      ...specParams(req.query),
      code,
      encounterID,
      fightID,
      difficulty,
      compareTo: req.query.compareTo ? String(req.query.compareTo) : null,
      refresh: wantsRefresh(req.query),
    });
    res.json(pull);
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// --- tracked characters ---------------------------------------------------

// Detect a character's class and spec list for the "add character" form.
// Bad name/server surfaces as a 404 rather than a 500 — it's user input.
app.get('/api/character', async (req, res) => {
  try {
    const detected = await detectCharacter({
      ...charParams(req.query),
      refresh: wantsRefresh(req.query),
    });
    res.json(detected);
  } catch (err) {
    const notFound = /not found/i.test(err.message);
    res.status(notFound ? 404 : 500).json({ error: err.message });
  }
});

app.get('/api/characters', (req, res) => {
  try {
    res.json(loadCharacters());
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

app.post('/api/characters', async (req, res) => {
  try {
    const classes = await fetchGameClasses();
    res.json(upsertCharacter(req.body, classes));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Hide a character from the analysis views without forgetting it.
app.patch('/api/characters/:id', (req, res) => {
  try {
    res.json(setCharacterHidden(req.params.id, Boolean(req.body?.hidden)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/characters/:id', (req, res) => {
  try {
    res.json(removeCharacter(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`wcl-parse-improver running at http://localhost:${PORT}`);
});
