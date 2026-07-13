import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateCharacter,
  characterId,
  loadCharacters,
  upsertCharacter,
  removeCharacter,
  setCharacterHidden,
  DEFAULT_CHARACTERS,
} from '../server/characters.js';

// Stand-in for fetchGameClasses() — keyed by classID, values carry the slugs
// the WCL API actually expects.
const CLASSES = new Map([
  [1, { id: 1, slug: 'DeathKnight', name: 'Death Knight', specs: [
    { name: 'Blood', slug: 'Blood' }, { name: 'Frost', slug: 'Frost' }, { name: 'Unholy', slug: 'Unholy' }] }],
  [3, { id: 3, slug: 'Hunter', name: 'Hunter', specs: [
    { name: 'Beast Mastery', slug: 'BeastMastery' }, { name: 'Marksmanship', slug: 'Marksmanship' }, { name: 'Survival', slug: 'Survival' }] }],
  [9, { id: 9, slug: 'Shaman', name: 'Shaman', specs: [
    { name: 'Elemental', slug: 'Elemental' }, { name: 'Enhancement', slug: 'Enhancement' }, { name: 'Restoration', slug: 'Restoration' }] }],
]);

const shaman = (specs) => ({ name: 'Totemz', server: 'grim-batol', region: 'EU', zone: 47, className: 'Shaman', specs });

const withTempFile = (fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wcl-chars-'));
  const file = path.join(dir, 'characters.json');
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('validateCharacter normalizes and keeps the spec slug, not the display name', () => {
  const c = validateCharacter(
    { name: ' Lelou ', server: 'daggerspine', region: 'US', zone: 47, className: 'Hunter', specs: ['BeastMastery'] },
    CLASSES
  );
  assert.equal(c.name, 'Lelou');
  assert.equal(c.className, 'Hunter');
  assert.equal(c.classLabel, 'Hunter');
  // slug is what characterRankings needs; the display name returns 0 rankings silently
  assert.deepEqual(c.specs, [{ name: 'Beast Mastery', slug: 'BeastMastery' }]);
  assert.equal(c.id, 'lelou-daggerspine-hunter');
});

test('validateCharacter accepts spec objects as well as bare slugs', () => {
  const c = validateCharacter(shaman([{ slug: 'Enhancement' }, 'Elemental']), CLASSES);
  assert.deepEqual(c.specs.map((s) => s.slug), ['Enhancement', 'Elemental']);
});

test('validateCharacter dedupes specs', () => {
  const c = validateCharacter(shaman(['Enhancement', 'Enhancement']), CLASSES);
  assert.equal(c.specs.length, 1);
});

test('validateCharacter rejects healer and tank specs', () => {
  assert.throws(() => validateCharacter(shaman(['Restoration']), CLASSES), /Healer spec/);
  assert.throws(
    () => validateCharacter({ ...shaman(['Blood']), className: 'DeathKnight' }, CLASSES),
    /Tank spec/
  );
});

test('validateCharacter rejects a spec that belongs to another class', () => {
  assert.throws(() => validateCharacter(shaman(['Unholy']), CLASSES), /not a Shaman spec/);
});

test('validateCharacter rejects unknown class, empty specs and bad zone', () => {
  assert.throws(() => validateCharacter({ ...shaman(['Elemental']), className: 'Bard' }, CLASSES), /Unknown class/);
  assert.throws(() => validateCharacter(shaman([]), CLASSES), /at least one spec/);
  assert.throws(() => validateCharacter({ ...shaman(['Elemental']), zone: 0 }, CLASSES), /Zone/);
  assert.throws(() => validateCharacter({ ...shaman(['Elemental']), name: '' }, CLASSES), /name is required/);
});

test('characterId is stable across name/server casing and diacritics', () => {
  const a = characterId({ name: 'Unreally', server: 'Aggra(Português)', className: 'DeathKnight' });
  const b = characterId({ name: 'unreally', server: 'aggra-portugues', className: 'DeathKnight' });
  assert.equal(a, b);
});

test('loadCharacters seeds the defaults when the file is absent', () => {
  withTempFile((file) => {
    assert.equal(existsSync(file), false);
    const list = loadCharacters(file);
    assert.equal(list.length, DEFAULT_CHARACTERS.length);
    assert.ok(list.every((c) => c.id));
    assert.equal(existsSync(file), true); // seeded to disk
  });
});

test('upsert adds, then replaces the same character rather than duplicating', () => {
  withTempFile((file) => {
    loadCharacters(file); // seed
    const first = upsertCharacter(shaman(['Elemental', 'Enhancement']), CLASSES, file);
    const afterAdd = loadCharacters(file);
    assert.equal(afterAdd.filter((c) => c.id === first.id).length, 1);

    // same name+server+class, fewer specs -> replaced in place
    const second = upsertCharacter(shaman(['Enhancement']), CLASSES, file);
    assert.equal(second.id, first.id);
    const afterUpdate = loadCharacters(file);
    assert.equal(afterUpdate.filter((c) => c.id === first.id).length, 1);
    assert.deepEqual(afterUpdate.find((c) => c.id === first.id).specs.map((s) => s.slug), ['Enhancement']);
  });
});

test('removeCharacter drops one and errors on an unknown id', () => {
  withTempFile((file) => {
    loadCharacters(file);
    const c = upsertCharacter(shaman(['Enhancement']), CLASSES, file);
    const left = removeCharacter(c.id, file);
    assert.equal(left.some((x) => x.id === c.id), false);
    assert.throws(() => removeCharacter('nope', file), /No character/);
  });
});

test('saved file is valid JSON an operator can hand-edit', () => {
  withTempFile((file) => {
    loadCharacters(file);
    upsertCharacter(shaman(['Enhancement']), CLASSES, file);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.every((c) => c.id && c.className && Array.isArray(c.specs)));
  });
});

// `hidden` keeps a character on the roster but out of the M+/Raid pickers.
test('a character can be hidden and shown again without being forgotten', () => {
  withTempFile((file) => {
    const c = upsertCharacter(
      { name: 'Alt', server: 'grim-batol', region: 'EU', zone: 47, className: 'DeathKnight', specs: ['Unholy'] },
      CLASSES,
      file
    );
    assert.equal(c.hidden, false, 'characters are visible by default');

    const before = loadCharacters(file).length;

    assert.equal(setCharacterHidden(c.id, true, file).hidden, true);
    const reloaded = loadCharacters(file);
    assert.equal(reloaded.find((x) => x.id === c.id).hidden, true, 'persisted');
    assert.equal(reloaded.length, before, 'hiding is not removing');

    assert.equal(setCharacterHidden(c.id, false, file).hidden, false);
  });
});

test('hiding an unknown character is an error, not a silent no-op', () => {
  withTempFile((file) => {
    assert.throws(() => setCharacterHidden('nope', true, file), /No character with id/);
  });
});
