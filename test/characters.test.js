import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateCharacter,
  characterId,
  loadCharacters,
  upsertCharacter,
  upsertCharacters,
  removeCharacter,
  setCharacterHidden,
  adoptLegacy,
  sortCharacters,
  LEGACY_KEY,
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

// Rosters are per Warcraft Logs user id.
const USER = '4242';
const OTHER = '9999';

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
  assert.deepEqual(c.specs, [{ name: 'Beast Mastery', slug: 'BeastMastery', role: 'DPS', points: null }]);
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

// Tanks and healers are tracked and scored; what they can't do is drive the
// damage-based report. That's the pickers' job to enforce, not the store's —
// refusing the spec here would mean a tank character couldn't be on the roster
// at all.
test('validateCharacter keeps healer and tank specs, tagged with their role', () => {
  const healer = validateCharacter(shaman(['Restoration', 'Elemental']), CLASSES);
  assert.deepEqual(
    healer.specs.map((s) => [s.slug, s.role]),
    [
      ['Restoration', 'Healer'],
      ['Elemental', 'DPS'],
    ]
  );

  const tank = validateCharacter({ ...shaman(['Blood']), className: 'DeathKnight' }, CLASSES);
  assert.deepEqual(tank.specs.map((s) => s.role), ['Tank']);
});

test('a spec carries its M+ score, and the rating is the best spec — not the sum', () => {
  const c = validateCharacter(
    shaman([
      { slug: 'Elemental', points: 2100 },
      { slug: 'Enhancement', points: 2991 },
      { slug: 'Restoration', points: 400 },
    ]),
    CLASSES
  );
  assert.deepEqual(c.specs.map((s) => s.points), [2100, 2991, 400]);
  assert.equal(c.mplusRating, 2991);
});

test('a character with no scored spec has no rating, rather than a rating of zero', () => {
  const c = validateCharacter(shaman(['Elemental']), CLASSES);
  assert.equal(c.mplusRating, null);
});

test('sortCharacters ranks by M+ rating, then item level, then level', () => {
  const c = (name, mplusRating, itemLevel, level) => ({ name, mplusRating, itemLevel, level });
  const sorted = sortCharacters([
    c('NoScore', null, 300, 90),
    c('LowRating', 1000, 300, 90),
    c('TopRating', 4000, 200, 90),
    c('SameRatingLowerIlvl', 4000, 190, 90),
    c('SameRatingSameIlvlLowerLevel', 4000, 200, 80),
  ]);
  assert.deepEqual(sorted.map((x) => x.name), [
    'TopRating',
    'SameRatingSameIlvlLowerLevel',
    'SameRatingLowerIlvl',
    'LowRating',
    'NoScore', // an unranked character sorts below every ranked one, not above on a null
  ]);
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

test('a user with no roster gets an empty list, not someone else’s characters', () => {
  withTempFile((file) => {
    assert.equal(existsSync(file), false);
    assert.deepEqual(loadCharacters(USER, file), []);
  });
});

test('upsert adds, then replaces the same character rather than duplicating', () => {
  withTempFile((file) => {
    const first = upsertCharacter(USER, shaman(['Elemental', 'Enhancement']), CLASSES, file);
    const afterAdd = loadCharacters(USER, file);
    assert.equal(afterAdd.filter((c) => c.id === first.id).length, 1);

    // same name+server+class, fewer specs -> replaced in place
    const second = upsertCharacter(USER, shaman(['Enhancement']), CLASSES, file);
    assert.equal(second.id, first.id);
    const afterUpdate = loadCharacters(USER, file);
    assert.equal(afterUpdate.filter((c) => c.id === first.id).length, 1);
    assert.deepEqual(afterUpdate.find((c) => c.id === first.id).specs.map((s) => s.slug), ['Enhancement']);
  });
});

// The whole point of the login: two accounts, two rosters, no bleed.
test('rosters are per user — one user cannot see or clobber another’s', () => {
  withTempFile((file) => {
    const mine = upsertCharacter(USER, shaman(['Enhancement']), CLASSES, file);
    const theirs = upsertCharacter(
      OTHER,
      { name: 'Alt', server: 'daggerspine', region: 'US', zone: 47, className: 'Hunter', specs: ['BeastMastery'] },
      CLASSES,
      file
    );

    assert.deepEqual(loadCharacters(USER, file).map((c) => c.id), [mine.id]);
    assert.deepEqual(loadCharacters(OTHER, file).map((c) => c.id), [theirs.id]);

    removeCharacter(USER, mine.id, file);
    assert.deepEqual(loadCharacters(USER, file), []);
    assert.equal(loadCharacters(OTHER, file).length, 1, 'the other user is untouched');
  });
});

test('a character id is only removable by the user who owns it', () => {
  withTempFile((file) => {
    const mine = upsertCharacter(USER, shaman(['Enhancement']), CLASSES, file);
    assert.throws(() => removeCharacter(OTHER, mine.id, file), /No character/);
    assert.throws(() => setCharacterHidden(OTHER, mine.id, true, file), /No character/);
    assert.equal(loadCharacters(USER, file).length, 1);
  });
});

// The roster import: one write, and one bad character does not sink the rest.
test('upsertCharacters imports the good ones and reports why it skipped the others', () => {
  withTempFile((file) => {
    const skipped = [];
    const stored = upsertCharacters(
      USER,
      [
        shaman(['Enhancement']),
        { ...shaman(['Restoration']), name: 'Healz' }, // a healer is imported, not skipped
        { ...shaman(['Elemental']), name: 'Nobody', className: 'Bard' }, // not a class
      ],
      CLASSES,
      file,
      skipped
    );

    assert.deepEqual(stored.map((c) => c.name), ['Totemz', 'Healz']);
    assert.deepEqual(skipped.map((s) => s.name), ['Nobody']);
    assert.match(skipped[0].reason, /Unknown class/);
  });
});

test('an import does not unhide a character the user hid', () => {
  withTempFile((file) => {
    const c = upsertCharacter(USER, shaman(['Enhancement']), CLASSES, file);
    setCharacterHidden(USER, c.id, true, file);

    upsertCharacters(USER, [shaman(['Enhancement', 'Elemental'])], CLASSES, file);

    const after = loadCharacters(USER, file).find((x) => x.id === c.id);
    assert.equal(after.hidden, true, 'still hidden');
    assert.equal(after.specs.length, 2, 'but the specs were refreshed');
  });
});

// characters.json predates logins: it was a flat array with no user attached.
test('a pre-login characters.json is adopted by the first user to sign in', () => {
  withTempFile((file) => {
    writeFileSync(
      file,
      JSON.stringify([
        { name: 'Unreally', server: 'aggra-portugues', region: 'EU', zone: 47, className: 'DeathKnight',
          classLabel: 'Death Knight', specs: [{ name: 'Unholy', slug: 'Unholy' }], hidden: false },
      ])
    );

    assert.equal(adoptLegacy(USER, file), 1);
    assert.deepEqual(loadCharacters(USER, file).map((c) => c.name), ['Unreally']);

    // once adopted it is gone from the file, so the next user does not inherit it
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[LEGACY_KEY], undefined);
    assert.equal(adoptLegacy(OTHER, file), 0);
    assert.deepEqual(loadCharacters(OTHER, file), []);
  });
});

test('adoption is skipped for a user who already has a roster', () => {
  withTempFile((file) => {
    upsertCharacter(USER, shaman(['Enhancement']), CLASSES, file);
    const store = JSON.parse(readFileSync(file, 'utf8'));
    store.users[LEGACY_KEY] = [
      { name: 'Old', server: 'grim-batol', region: 'EU', zone: 47, className: 'DeathKnight',
        classLabel: 'Death Knight', specs: [{ name: 'Unholy', slug: 'Unholy' }], hidden: false },
    ];
    writeFileSync(file, JSON.stringify(store));

    assert.equal(adoptLegacy(USER, file), 0);
    assert.deepEqual(loadCharacters(USER, file).map((c) => c.name), ['Totemz']);
  });
});

test('saved file is valid JSON an operator can hand-edit', () => {
  withTempFile((file) => {
    upsertCharacter(USER, shaman(['Enhancement']), CLASSES, file);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 2);
    const list = parsed.users[USER];
    assert.ok(Array.isArray(list));
    assert.ok(list.every((c) => c.id && c.className && Array.isArray(c.specs)));
  });
});

// `hidden` keeps a character on the roster but out of the M+/Raid pickers.
test('a character can be hidden and shown again without being forgotten', () => {
  withTempFile((file) => {
    const c = upsertCharacter(
      USER,
      { name: 'Alt', server: 'grim-batol', region: 'EU', zone: 47, className: 'DeathKnight', specs: ['Unholy'] },
      CLASSES,
      file
    );
    assert.equal(c.hidden, false, 'characters are visible by default');

    const before = loadCharacters(USER, file).length;

    assert.equal(setCharacterHidden(USER, c.id, true, file).hidden, true);
    const reloaded = loadCharacters(USER, file);
    assert.equal(reloaded.find((x) => x.id === c.id).hidden, true, 'persisted');
    assert.equal(reloaded.length, before, 'hiding is not removing');

    assert.equal(setCharacterHidden(USER, c.id, false, file).hidden, false);
  });
});

test('hiding an unknown character is an error, not a silent no-op', () => {
  withTempFile((file) => {
    assert.throws(() => setCharacterHidden(USER, 'nope', true, file), /No character with id/);
  });
});

test('reading or writing without a user id is an error, not a shared bucket', () => {
  withTempFile((file) => {
    assert.throws(() => loadCharacters('', file), /user id is required/);
    assert.throws(() => upsertCharacter(null, shaman(['Enhancement']), CLASSES, file), /user id is required/);
  });
});
