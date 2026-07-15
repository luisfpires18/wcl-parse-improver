// Persistent list of tracked characters, stored as characters.json in the
// project root. Hand-editable and diffable on purpose — it holds no secrets.
//
// The roster is per Warcraft Logs user, keyed by their WCL user id:
//
//   { "version": 2, "users": { "12345": [ ...characters ] } }
//
// Validation lives here rather than in the route because a bad specName does
// not error against Warcraft Logs: it silently returns zero rankings, which
// would surface as an empty cohort rather than a failure. Never trust the
// client with a class/spec pair — and an imported character is no more trusted
// than a typed one, since it takes the same round trip through the browser.
//
// No write lock: every load/save pair below runs to completion in one
// synchronous block with no `await` in between, and Node runs that block to the
// end before any other request is looked at. There is no interleaving to guard.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.js';
import { roleOf } from './wcl/specs.js';

export const CHARACTERS_FILE = path.join(PROJECT_ROOT, 'characters.json');

// Where a pre-login characters.json is parked. The first user to sign in adopts
// it (see adoptLegacy) — the file predates accounts, so its characters belong to
// whoever was running the app, and that is the person about to log in.
export const LEGACY_KEY = 'legacy';

const slugify = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Stable identity: one character is one (name, server, class) triple. */
export const characterId = (c) => `${slugify(c.name)}-${slugify(c.server)}-${slugify(c.className)}`;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

const withId = (c) => ({ id: c.id ?? characterId(c), ...c });

/**
 * Normalize + validate a client-supplied character against the real class list.
 * @param {object} input
 * @param {Map<number, {slug:string,name:string,specs:{name:string,slug:string}[]}>} classes from fetchGameClasses()
 * @returns {object} the stored shape
 * @throws {Error} with a user-facing message
 */
export function validateCharacter(input, classes) {
  const name = str(input?.name);
  const server = str(input?.server);
  const region = str(input?.region);
  const zone = Number(input?.zone);
  const className = str(input?.className);

  if (!name) throw new Error('Character name is required');
  if (!server) throw new Error('Server slug is required');
  if (!region) throw new Error('Region is required');
  if (!Number.isInteger(zone) || zone <= 0) throw new Error('Zone must be a positive integer');

  const klass = [...classes.values()].find((c) => c.slug === className);
  if (!klass) throw new Error(`Unknown class "${className}"`);

  const wanted = Array.isArray(input?.specs) ? input.specs : [];
  const bySlug = new Map();
  for (const s of wanted) {
    const slug = str(typeof s === 'string' ? s : s?.slug);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, typeof s === 'string' ? {} : (s ?? {}));
  }
  if (!bySlug.size) throw new Error('Pick at least one spec');

  // Every role is kept — a tank or healer spec belongs on the roster with its M+
  // score. What it cannot do is drive the report, which is damage-based; the
  // pickers filter to `role === 'DPS'` rather than the store refusing the spec.
  const specs = [...bySlug].map(([slug, given]) => {
    const spec = klass.specs.find((s) => s.slug === slug);
    if (!spec) throw new Error(`"${slug}" is not a ${klass.name} spec`);
    const points = Number(given.points);
    return {
      name: spec.name,
      slug: spec.slug,
      role: roleOf(klass.slug, spec.slug),
      points: Number.isFinite(points) ? points : null,
    };
  });

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  // The number a player quotes as "my rating": the best spec's, not the sum.
  const scored = specs.map((s) => s.points).filter((p) => p != null);
  const mplusRating = num(input?.mplusRating) ?? (scored.length ? Math.max(...scored) : null);

  // `hidden` keeps a character on the roster but out of the analysis views — for
  // alts you track but don't want cluttering the picker. Preserved across an
  // upsert so re-adding a character doesn't silently unhide it.
  const hidden = Boolean(input?.hidden);
  const character = {
    name,
    server,
    region,
    zone,
    className: klass.slug,
    classLabel: klass.name,
    specs,
    level: num(input?.level),
    itemLevel: num(input?.itemLevel),
    mplusRating,
    hidden,
  };
  return { id: characterId(character), ...character };
}

/**
 * Best character first: M+ rating, then item level, then character level.
 * A character with no score at all sorts below every character that has one,
 * rather than above them on a null.
 */
export function sortCharacters(list) {
  const key = (c) => [c.mplusRating ?? -1, c.itemLevel ?? -1, c.level ?? -1];
  return [...list].sort((a, b) => {
    const [ar, ai, al] = key(a);
    const [br, bi, bl] = key(b);
    return br - ar || bi - ai || bl - al || String(a.name).localeCompare(String(b.name));
  });
}

// --- the file ---------------------------------------------------------------

/** Read the whole store, migrating the pre-login array shape on the way past. */
function readStore(file = CHARACTERS_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { version: 2, users: {} }; // absent or corrupt — start empty
  }
  // Pre-login: the file was one flat array, with no user to attribute it to.
  if (Array.isArray(parsed)) {
    return { version: 2, users: { [LEGACY_KEY]: parsed.map(withId) } };
  }
  if (!parsed?.users || typeof parsed.users !== 'object') return { version: 2, users: {} };
  return { version: 2, users: parsed.users };
}

function writeStore(store, file = CHARACTERS_FILE) {
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n');
  return store;
}

const key = (userId) => {
  const k = str(userId);
  if (!k) throw new Error('A user id is required to read or write characters');
  return k;
};

/**
 * This user's roster, best character first. Sorting on the way out (rather than
 * on the way in) means the order survives a hand-edited characters.json.
 */
export function loadCharacters(userId, file = CHARACTERS_FILE) {
  const list = readStore(file).users[key(userId)];
  return Array.isArray(list) ? sortCharacters(list.map(withId)) : [];
}

export function saveCharacters(userId, list, file = CHARACTERS_FILE) {
  const store = readStore(file);
  store.users[key(userId)] = list;
  writeStore(store, file);
  return list;
}

/**
 * Hand a pre-login characters.json to the first user who signs in, once.
 * Skipped if they already have a roster of their own — that means they are not
 * the person the old file belonged to, or they have already adopted it.
 * @returns {number} how many characters were adopted
 */
export function adoptLegacy(userId, file = CHARACTERS_FILE) {
  const store = readStore(file);
  const legacy = store.users[LEGACY_KEY];
  if (!Array.isArray(legacy) || !legacy.length) return 0;

  const k = key(userId);
  if (store.users[k]?.length) return 0;

  store.users[k] = legacy.map(withId);
  delete store.users[LEGACY_KEY];
  writeStore(store, file);
  return store.users[k].length;
}

// --- mutations --------------------------------------------------------------

/** Add, or replace an existing character with the same id (same name+server+class). */
export function upsertCharacter(userId, input, classes, file = CHARACTERS_FILE) {
  const [character] = upsertCharacters(userId, [input], classes, file);
  return character;
}

/**
 * Upsert several at once — the roster import. One write for the whole roster
 * instead of one per character, and one bad character does not abort the rest:
 * it lands in `skipped` with the reason, which the UI shows.
 * @returns {object[]} the characters that were stored
 */
export function upsertCharacters(userId, inputs, classes, file = CHARACTERS_FILE, skipped = []) {
  const store = readStore(file);
  const k = key(userId);
  const list = Array.isArray(store.users[k]) ? store.users[k].map(withId) : [];
  const stored = [];

  for (const input of inputs) {
    let character;
    try {
      character = validateCharacter(input, classes);
    } catch (err) {
      skipped.push({ name: input?.name ?? '?', server: input?.server, reason: err.message });
      continue;
    }
    // Don't clobber a hidden flag the user set here with a default from an import.
    const i = list.findIndex((c) => c.id === character.id);
    if (i >= 0) list[i] = { ...character, hidden: list[i].hidden ?? character.hidden };
    else list.push(character);
    stored.push(character);
  }

  store.users[k] = list;
  writeStore(store, file);
  return stored;
}

/** Show/hide one character without removing it. */
export function setCharacterHidden(userId, id, hidden, file = CHARACTERS_FILE) {
  const store = readStore(file);
  const k = key(userId);
  const list = (store.users[k] ?? []).map(withId);
  const c = list.find((x) => x.id === id);
  if (!c) throw new Error(`No character with id "${id}"`);
  c.hidden = Boolean(hidden);
  store.users[k] = list;
  writeStore(store, file);
  return c;
}

export function removeCharacter(userId, id, file = CHARACTERS_FILE) {
  const store = readStore(file);
  const k = key(userId);
  const list = (store.users[k] ?? []).map(withId);
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) throw new Error(`No character with id "${id}"`);
  store.users[k] = next;
  writeStore(store, file);
  return next;
}
