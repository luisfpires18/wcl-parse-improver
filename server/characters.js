// Persistent list of tracked characters, stored as characters.json in the
// project root. Hand-editable and diffable on purpose — it holds no secrets.
//
// Validation lives here rather than in the route because a bad specName does
// not error against Warcraft Logs: it silently returns zero rankings, which
// would surface as an empty cohort rather than a failure. Never trust the
// client with a class/spec pair.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './env.js';
import { roleOf } from './wcl/specs.js';

export const CHARACTERS_FILE = path.join(PROJECT_ROOT, 'characters.json');

// Seeded on first run so an existing install keeps working with no setup.
export const DEFAULT_CHARACTERS = [
  {
    name: 'Unreally',
    server: 'aggra-portugues',
    region: 'EU',
    zone: 47,
    className: 'DeathKnight',
    classLabel: 'Death Knight',
    specs: [
      { name: 'Unholy', slug: 'Unholy' },
      { name: 'Frost', slug: 'Frost' },
    ],
  },
  {
    name: 'Unreally',
    server: 'grim-batol',
    region: 'EU',
    zone: 47,
    className: 'DemonHunter',
    classLabel: 'Demon Hunter',
    specs: [
      { name: 'Havoc', slug: 'Havoc' },
      { name: 'Devourer', slug: 'Devourer' },
    ],
  },
];

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
  const slugs = [...new Set(wanted.map((s) => str(typeof s === 'string' ? s : s?.slug)).filter(Boolean))];
  if (!slugs.length) throw new Error('Pick at least one spec');

  const specs = slugs.map((slug) => {
    const spec = klass.specs.find((s) => s.slug === slug);
    if (!spec) throw new Error(`"${slug}" is not a ${klass.name} spec`);
    const role = roleOf(klass.slug, spec.slug);
    if (role !== 'DPS') {
      throw new Error(`${spec.name} is a ${role} spec — only DPS specs can be analysed`);
    }
    return { name: spec.name, slug: spec.slug };
  });

  const character = { name, server, region, zone, className: klass.slug, classLabel: klass.name, specs };
  return { id: characterId(character), ...character };
}

export function loadCharacters(file = CHARACTERS_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // absent or corrupt — seed from the defaults
    const seeded = DEFAULT_CHARACTERS.map((c) => ({ id: characterId(c), ...c }));
    saveCharacters(seeded, file);
    return seeded;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((c) => ({ id: c.id ?? characterId(c), ...c }));
}

export function saveCharacters(list, file = CHARACTERS_FILE) {
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
  return list;
}

/** Add, or replace an existing character with the same id (same name+server+class). */
export function upsertCharacter(input, classes, file = CHARACTERS_FILE) {
  const character = validateCharacter(input, classes);
  const list = loadCharacters(file);
  const i = list.findIndex((c) => c.id === character.id);
  if (i >= 0) list[i] = character;
  else list.push(character);
  saveCharacters(list, file);
  return character;
}

export function removeCharacter(id, file = CHARACTERS_FILE) {
  const list = loadCharacters(file);
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) throw new Error(`No character with id "${id}"`);
  saveCharacters(next, file);
  return next;
}
