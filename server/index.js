import express from 'express';
import path from 'node:path';
import { loadEnv, PROJECT_ROOT } from './env.js';
import {
  fetchOverview,
  fetchDamageSeries,
  fetchGameClasses,
  fetchCurrentUser,
  fetchClaimedCharacters,
} from './wcl/api.js';
import { authorizeUrl, exchangeCode } from './wcl/auth.js';
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
import {
  loadCharacters,
  upsertCharacters,
  removeCharacter,
  setCharacterHidden,
  adoptLegacy,
} from './characters.js';
import {
  loadSessions,
  requireSession,
  issueState,
  consumeState,
  createSession,
  destroySession,
  getSession,
} from './session.js';

loadEnv();

// Fail here rather than at the first click: an app that boots fine and then
// cannot sign anyone in is a worse bug than one that refuses to start.
const missing = ['WCL_CLIENT_ID', 'WCL_CLIENT_SECRET', 'WCL_REDIRECT_URI', 'SESSION_SECRET'].filter(
  (k) => !process.env[k]
);
if (missing.length) {
  console.error(
    `Missing required environment ${missing.join(', ')} — see .env.example.\n` +
      'WCL_REDIRECT_URI must also be listed as a redirect URL on your API client at\n' +
      'https://www.warcraftlogs.com/api/clients/.'
  );
  process.exit(1);
}

loadSessions();

const app = express();
const PORT = process.env.PORT || 3000;

// The zone the add-character form defaults to; the roster import uses the same
// one, so an imported character and a typed one are directly comparable.
const DEFAULT_ZONE = 47;

app.use(express.json());
app.use(express.static(path.join(PROJECT_ROOT, 'public')));
// shared/ holds code imported by BOTH the server and the browser (the
// rotation-match maths). Serving it means there is exactly one copy.
app.use('/shared', express.static(path.join(PROJECT_ROOT, 'shared')));

// --- sign in with Warcraft Logs -------------------------------------------
//
// The app token (client credentials) still does all the analysis work. This flow
// exists to answer one question the app token cannot: who are you, and which
// characters have you claimed?

app.get('/api/auth/login', (req, res) => {
  try {
    res.redirect(authorizeUrl(issueState(res)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/callback', async (req, res) => {
  try {
    // Check `state` before spending the code: an unsolicited callback is someone
    // else's login being pushed onto this browser, not ours to complete.
    if (!consumeState(req, res, String(req.query.state || ''))) {
      return res.status(400).json({ error: 'Login expired or was not started here. Try again.' });
    }
    if (req.query.error) {
      return res.status(400).json({ error: `Warcraft Logs declined the login: ${req.query.error}` });
    }
    const code = String(req.query.code || '');
    if (!code) return res.status(400).json({ error: 'No authorization code came back' });

    const { token, expiresAt } = await exchangeCode(code);
    const user = await fetchCurrentUser(token);
    createSession(res, {
      userId: user.id,
      name: user.name,
      avatar: user.avatar,
      accessToken: token,
      tokenExpiresAt: expiresAt,
    });
    // A characters.json from before logins existed belongs to whoever was running
    // the app — which is whoever just signed in for the first time.
    adoptLegacy(user.id);
    res.redirect('/');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// The client's "am I signed in?" probe. 401 here is normal, not an error.
app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in' });
  res.json({ id: session.userId, name: session.name, avatar: session.avatar });
});

// Everything else under /api is per-user and needs a session.
app.use('/api', requireSession);

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

    // refresh reaches the RANKING lookups (which run is "mine", who's on the ranked
    // page). The damage-event fetches below are keyed by report+fight and can't go
    // stale — a logged fight never changes — so they stay cached either way.
    const bundle = await buildComparison({
      ...charParams(req.query),
      ...specParams(req.query),
      encounterID,
      level,
      compareTo,
      refresh: wantsRefresh(req.query),
    });
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

// How ONE top-ranked player of a class+spec plays a boss — rotation only, plus the
// roster of the other nine to switch to (`player` picks one; default is the #1
// parse). Only the selected player's run is ever fetched.
//
// Note there is no charParams here: this is not about you, so it needs no
// character, no log and no kill of your own. It's the "learn the fight before you
// pull it" view.
app.get('/api/raid/rotations', async (req, res) => {
  try {
    const encounterID = Number(req.query.encounter);
    if (!encounterID) return res.status(400).json({ error: 'encounter query param required' });
    const rotations = await buildBossRotations({
      ...specParams(req.query),
      encounterID,
      difficulty: req.query.difficulty ? Number(req.query.difficulty) : DEFAULT_RAID_DIFFICULTY,
      player: req.query.player ? String(req.query.player) : null,
      topN: Math.max(2, Math.min(25, Number(req.query.top) || 10)), // roster size — costs nothing
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
//
// There is no add-by-hand endpoint. The roster comes from the signed-in user's
// Warcraft Logs profile, which knows the server slug and which specs have logs —
// the two things a human typing into a form reliably gets wrong.

app.get('/api/characters', (req, res) => {
  try {
    res.json(loadCharacters(req.session.userId));
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// Characters with no logged DPS spec (a healer-only alt) land in `skipped` with
// a reason rather than sinking the import.
app.post('/api/characters/import', async (req, res) => {
  try {
    const zoneID = Number(req.body?.zone) || DEFAULT_ZONE;
    const { characters, skipped } = await fetchClaimedCharacters({
      userToken: req.session.accessToken,
      zoneID,
    });
    if (!characters.length) {
      return res.status(404).json({
        error:
          'No characters are claimed on your Warcraft Logs profile. Claim them at warcraftlogs.com ' +
          'and import again.',
        skipped,
      });
    }

    const classes = await fetchGameClasses();
    // Every role — tanks and healers belong on the roster with their score, even
    // though the damage-based report can't analyse them. What we do drop is a
    // spec with no logged runs: importing all 3-4 specs of every character would
    // bury the picker in specs that were never played.
    const wanted = characters.map((c) => ({ ...c, specs: c.specs.filter((s) => s.hasLogs) }));
    const played = wanted.filter((c) => c.specs.length);
    for (const c of wanted) {
      if (!c.specs.length) {
        skipped.push({ name: c.name, server: c.server, reason: 'no logged runs in this zone' });
      }
    }

    const stored = upsertCharacters(req.session.userId, played, classes, undefined, skipped);
    res.json({ imported: stored.length, skipped, characters: loadCharacters(req.session.userId) });
  } catch (err) {
    // A dead or revoked user token reads as a 401 from WCL — the session is no
    // longer good for anything, so say so and let the client bounce to sign-in.
    const status = /HTTP 401/.test(err.message) ? 401 : 500;
    res.status(status).json({
      error: status === 401 ? 'Your Warcraft Logs sign-in expired. Sign in again.' : err.message,
    });
  }
});

// Hide a character from the analysis views without forgetting it.
app.patch('/api/characters/:id', (req, res) => {
  try {
    res.json(setCharacterHidden(req.session.userId, req.params.id, Boolean(req.body?.hidden)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/characters/:id', (req, res) => {
  try {
    res.json(removeCharacter(req.session.userId, req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`wcl-parse-improver running at http://localhost:${PORT}`);
});
