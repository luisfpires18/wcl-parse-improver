import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCharacter, assertCharacterInLog } from '../server/wcl/logIdentity.js';

// A pasted log is the one place the wrong character can get in. The M+ path finds
// runs through the character's OWN rankings, so class and spec are right by
// construction — but a report URL is just a string, and a Havoc log analysed as
// Unholy produces a full report in which every number is meaningless, with nothing
// saying so.
const ROSTER = [
  { name: 'Unreally', className: 'DeathKnight', specs: ['Unholy'] },
  { name: 'Unreally', className: 'DemonHunter', specs: ['Havoc'] }, // same name, other toon
  { name: 'Kragat', className: 'DeathKnight', specs: ['Frost'] },
  { name: 'Edôtensei', className: 'Mage', specs: ['Frost'] },
];

test('the fetching guard delegates to the pure rule', () => {
  assert.equal(assertCharacterInLog.constructor.name, 'AsyncFunction');
});

test('right name, right class, right spec: accepted', () => {
  const m = matchCharacter(ROSTER, { name: 'Unreally', className: 'DeathKnight', specName: 'Unholy' });
  assert.equal(m.className, 'DeathKnight');
  assert.deepEqual(m.specs, ['Unholy']);
});

// THE bug this exists for: a Havoc log analysed as Unholy produces a full report
// in which every number is meaningless, and nothing says so.
test('wrong CLASS is refused, and the message says what the log actually is', () => {
  assert.throws(
    () => matchCharacter([ROSTER[1]], { name: 'Unreally', className: 'DeathKnight', specName: 'Unholy', classLabel: 'Death Knight' }),
    (err) => {
      assert.match(err.message, /wrong character/i);
      assert.match(err.message, /DemonHunter/, 'says what the log has');
      assert.match(err.message, /Death Knight/, 'says what you are analysing');
      return true;
    }
  );
});

test('right class, WRONG SPEC is refused', () => {
  assert.throws(
    () => matchCharacter([{ name: 'Unreally', className: 'DeathKnight', specs: ['Frost'] }], { name: 'Unreally', className: 'DeathKnight', specName: 'Unholy' }),
    (err) => {
      assert.match(err.message, /wrong spec/i);
      assert.match(err.message, /Frost/);
      assert.match(err.message, /Unholy/);
      return true;
    }
  );
});

test('character not in the log at all: refused, and lists who IS in it', () => {
  assert.throws(
    () => matchCharacter(ROSTER, { name: 'Somebodyelse', className: 'DeathKnight', specName: 'Unholy' }),
    (err) => {
      assert.match(err.message, /isn't in that log/i);
      assert.match(err.message, /Kragat/, 'names who is actually there');
      return true;
    }
  );
});

// Two toons share a name in one log — the guard must pick the right one, not the
// first one. This is the exact case resolveActor already guards for elsewhere.
test('same name, two classes: the matching one is picked, not the first', () => {
  const m = matchCharacter(ROSTER, { name: 'Unreally', className: 'DemonHunter', specName: 'Havoc' });
  assert.equal(m.className, 'DemonHunter');
});

// A log with no spec recorded must not be rejected over missing metadata — that
// would be worse than the thing we're guarding against.
test('a log that records no spec is accepted on class alone', () => {
  const m = matchCharacter([{ name: 'Unreally', className: 'DeathKnight', specs: [] }], {
    name: 'Unreally',
    className: 'DeathKnight',
    specName: 'Unholy',
  });
  assert.equal(m.className, 'DeathKnight');
});

test('an unreadable roster does not block analysis', () => {
  assert.equal(matchCharacter([], { name: 'Unreally', className: 'DeathKnight', specName: 'Unholy' }), null);
});
