// GraphQL client for the Warcraft Logs v2 API with a disk cache.
// Every successful response is cached in cache/ keyed by sha256(query + variables),
// so repeated runs and iteration cost zero API points.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getToken } from './auth.js';
import { PROJECT_ROOT } from '../env.js';

const API_URL = 'https://www.warcraftlogs.com/api/v2/client';
// The private endpoint. Same schema, but it answers as the signed-in user, which
// is the only way to reach userData.currentUser.
const USER_API_URL = 'https://www.warcraftlogs.com/api/v2/user';
const CACHE_DIR = path.join(PROJECT_ROOT, 'cache');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

// Delay between uncached network fetches to stay polite with rate limits.
const FETCH_DELAY_MS = 400;
let lastFetchAt = 0;

function cachePath(query, variables) {
  const hash = createHash('sha256')
    .update(query)
    .update(JSON.stringify(variables ?? {}))
    .digest('hex')
    .slice(0, 32);
  return path.join(CACHE_DIR, `${hash}.json`);
}

/**
 * Run a GraphQL query. Returns the `data` object.
 *
 * With `userToken`, the query runs against the private endpoint as that user —
 * and is never cached. The cache key is sha256(query + variables) with nothing
 * identifying the caller, so caching a per-user answer would serve one user's
 * profile to the next person who asked the same question. The only user-endpoint
 * query is the roster import, which is one click, so there is nothing to lose.
 *
 * @param {string} query
 * @param {object} [variables]
 * @param {{ noCache?: boolean, userToken?: string }} [opts]
 */
export async function gql(query, variables = {}, opts = {}) {
  const perUser = Boolean(opts.userToken);
  const file = cachePath(query, variables);
  if (!opts.noCache && !perUser) {
    try {
      const cachedRaw = readFileSync(file, 'utf8');
      return JSON.parse(cachedRaw).data;
    } catch {
      // cache miss — fall through to network
    }
  }

  const wait = lastFetchAt + FETCH_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt = Date.now();

  const token = opts.userToken ?? (await getToken());
  const res = await fetch(perUser ? USER_API_URL : API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`WCL API HTTP ${res.status} — ${(await res.text()).slice(0, 1000)}`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    const dumped = dumpDebug('graphql-errors', { query, variables, errors: body.errors });
    throw new Error(
      `WCL GraphQL errors: ${body.errors.map((e) => e.message).join('; ')} (raw dumped to ${dumped})`
    );
  }

  if (!perUser) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ query, variables, data: body.data }, null, 2));
  }
  return body.data;
}

/**
 * Small keyed disk cache for computed/derived values (e.g. a binned DPS
 * series) — distinct from the raw GraphQL cache. Use this when the raw
 * upstream payload is huge but the derived result is tiny, so we never
 * persist the multi-MB event blob, only the compact output.
 */
export function readDerivedCache(key) {
  try {
    return JSON.parse(readFileSync(path.join(CACHE_DIR, `derived-${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function writeDerivedCache(key, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path.join(CACHE_DIR, `derived-${key}.json`), JSON.stringify(value));
}

/**
 * Write an unexpected payload to debug/ so it can be inspected instead of crashing.
 * Returns the file path.
 */
export function dumpDebug(name, payload) {
  mkdirSync(DEBUG_DIR, { recursive: true });
  const file = path.join(DEBUG_DIR, `${name}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.error(`[debug] unexpected payload dumped to ${file}`);
  return file;
}
