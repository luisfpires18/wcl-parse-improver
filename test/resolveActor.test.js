import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActor, withSpec } from '../server/wcl/api.js';

// A real log held two actors both named "Unreally" — the user's DK on
// Aggra and their DH on Grim Batol. Name-only matching grabbed the DK and
// zeroed every "mine" metric for the DH. These guard the disambiguation.
const TWO_UNREALLY = [
  { id: 2, name: 'Unreally', subType: 'DeathKnight', server: 'Aggra(Português)' },
  { id: 45, name: 'Unreally', subType: 'DemonHunter', server: 'GrimBatol' },
];

test('resolveActor: single match ignores hints', () => {
  const actors = [{ id: 1, name: 'Waalpen', subType: 'DeathKnight', server: 'Ragnaros' }];
  assert.equal(resolveActor(actors, 'Waalpen').id, 1);
});

test('resolveActor: duplicate names disambiguated by server slug', () => {
  const a = resolveActor(TWO_UNREALLY, 'Unreally', { server: 'grim-batol', className: 'DemonHunter' });
  assert.equal(a.id, 45);
  const b = resolveActor(TWO_UNREALLY, 'Unreally', { server: 'aggra-portugues', className: 'DeathKnight' });
  assert.equal(b.id, 2);
});

test('resolveActor: server wins even without class hint (diacritics tolerated)', () => {
  const a = resolveActor(TWO_UNREALLY, 'Unreally', { server: 'aggra-portugues' });
  assert.equal(a.id, 2);
});

test('resolveActor: falls back to class when server is unknown', () => {
  const a = resolveActor(TWO_UNREALLY, 'Unreally', { className: 'DemonHunter' });
  assert.equal(a.id, 45);
});

test('resolveActor: no hints on a collision picks the first (documented fallback)', () => {
  assert.equal(resolveActor(TWO_UNREALLY, 'Unreally').id, 2);
});

test('resolveActor: diacritic-insensitive name match', () => {
  const actors = [{ id: 7, name: 'Zoée', subType: 'DemonHunter', server: 'Kazzak' }];
  assert.equal(resolveActor(actors, 'Zoee')?.id, 7);
});

test('resolveActor: returns null when nobody matches', () => {
  assert.equal(resolveActor(TWO_UNREALLY, 'Nobody'), null);
});

// WCL returns "Internal server error" for `specName: null` — the argument has
// to be absent, not null, to mean "all specs".
test('withSpec omits specName entirely rather than sending null', () => {
  const base = { name: 'Unreally', metric: 'playerscore' };
  assert.deepEqual(withSpec(base, null), base);
  assert.equal('specName' in withSpec(base, null), false);
  assert.equal('specName' in withSpec(base, undefined), false);
  assert.equal('specName' in withSpec(base, ''), false);
  assert.deepEqual(withSpec(base, 'Unholy'), { ...base, specName: 'Unholy' });
});
