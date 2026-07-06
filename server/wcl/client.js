// GraphQL client for the Warcraft Logs v2 API with a disk cache.
// Every successful response is cached in cache/ keyed by sha256(query + variables),
// so repeated runs and iteration cost zero API points.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getToken } from './auth.js';
import { PROJECT_ROOT } from '../env.js';

const API_URL = 'https://www.warcraftlogs.com/api/v2/client';
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
 * @param {string} query
 * @param {object} [variables]
 * @param {{ noCache?: boolean }} [opts]
 */
export async function gql(query, variables = {}, opts = {}) {
  const file = cachePath(query, variables);
  if (!opts.noCache) {
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

  const token = await getToken();
  const res = await fetch(API_URL, {
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

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ query, variables, data: body.data }, null, 2));
  return body.data;
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
