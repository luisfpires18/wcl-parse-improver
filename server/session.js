// Sessions, hand-rolled on node:crypto rather than express-session + cookie-parser.
// The whole app has one dependency (express) and parses its own .env; two more
// packages to sign a cookie and split it on ';' is not a trade worth making.
//
// The cookie carries an opaque session id and nothing else. The Warcraft Logs
// access token stays server-side, in the store, and is never sent to the browser:
// it is a bearer token for someone's WCL account, not ours to hand out.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.js';

// Where sessions are kept. Overridable so a deployment can point it at a mounted
// volume — and so the tests don't scribble into the running app's session store.
const DATA_DIR = process.env.WCL_DATA_DIR || path.join(PROJECT_ROOT, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

export const SESSION_COOKIE = 'wcl_sid';
export const STATE_COOKIE = 'wcl_oauth_state';

// A session outlives any single visit but not the token it wraps: once WCL stops
// honouring the access token there is nothing left to authorise, so the two
// expire together.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** sessionId -> { userId, name, avatar, accessToken, tokenExpiresAt, expiresAt } */
const sessions = new Map();

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error(
      'Missing SESSION_SECRET. Put a long random string in .env (see .env.example) — ' +
        'it signs the session cookie, and changing it signs everyone out.'
    );
  }
  return s;
}

const sign = (value) => createHmac('sha256', secret()).update(value).digest('hex');

/** Constant-time compare that does not throw on a length mismatch. */
function sameSignature(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- persistence ----------------------------------------------------------
// Sessions survive a restart, so an `npm start` mid-session doesn't sign the
// user out. Expired entries are dropped on load rather than accumulating.

function persist() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions], null, 2) + '\n');
  } catch (err) {
    console.error(`[session] could not write ${SESSIONS_FILE}: ${err.message}`);
  }
}

export function loadSessions() {
  let entries;
  try {
    entries = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return; // absent or corrupt — start empty
  }
  if (!Array.isArray(entries)) return;
  const now = Date.now();
  for (const [id, s] of entries) {
    if (s?.expiresAt > now && s?.tokenExpiresAt > now) sessions.set(id, s);
  }
}

// --- cookies --------------------------------------------------------------

export function readCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Lax, not Strict: the OAuth callback is a cross-site top-level GET, and Strict
// would withhold the cookie on exactly that navigation.
function cookieAttrs(maxAgeSeconds) {
  const secure = String(process.env.WCL_REDIRECT_URI || '').startsWith('https:');
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${cookieAttrs(maxAgeSeconds)}`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; ${cookieAttrs(0)}`);
}

// --- the OAuth `state` round trip -----------------------------------------

/** Mint a state token, remember it in a short-lived cookie, return it. */
export function issueState(res) {
  const state = randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, `${state}.${sign(state)}`, 600);
  return state;
}

/** True if `state` from the callback query is the one we issued to this browser. */
export function consumeState(req, res, state) {
  clearCookie(res, STATE_COOKIE);
  const raw = readCookies(req)[STATE_COOKIE];
  if (!raw || !state) return false;
  const i = raw.lastIndexOf('.');
  if (i < 0) return false;
  const value = raw.slice(0, i);
  return value === state && sameSignature(raw.slice(i + 1), sign(value));
}

// --- sessions -------------------------------------------------------------

/** Start a session for a signed-in user and put the signed id in a cookie. */
export function createSession(res, { userId, name, avatar, accessToken, tokenExpiresAt }) {
  const id = randomBytes(24).toString('hex');
  const expiresAt = Math.min(Date.now() + SESSION_TTL_MS, tokenExpiresAt);
  sessions.set(id, { userId, name, avatar, accessToken, tokenExpiresAt, expiresAt });
  persist();
  setCookie(res, SESSION_COOKIE, `${id}.${sign(id)}`, Math.floor((expiresAt - Date.now()) / 1000));
  return id;
}

/** The session this request carries, or null. Verifies the signature first. */
export function getSession(req) {
  const raw = readCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const id = raw.slice(0, i);
  if (!sameSignature(raw.slice(i + 1), sign(id))) return null;

  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    persist();
    return null;
  }
  return { id, ...session };
}

export function destroySession(req, res) {
  const session = getSession(req);
  if (session) {
    sessions.delete(session.id);
    persist();
  }
  clearCookie(res, SESSION_COOKIE);
}

/**
 * Gate for every /api route except /api/auth/*. Attaches req.session.
 * The 401 body is what the client's fetch wrapper watches for to bounce back
 * to the sign-in screen.
 */
export function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) {
    clearCookie(res, SESSION_COOKIE); // a stale or forged cookie should not keep being sent
    return res.status(401).json({ error: 'Not signed in' });
  }
  req.session = session;
  next();
}
