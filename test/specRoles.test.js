import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleOf, isDps } from '../server/wcl/specs.js';

// Spec names collide across classes — the map must be keyed by class+spec.
test('roleOf: same spec name, different classes', () => {
  assert.equal(roleOf('Paladin', 'Holy'), 'Healer');
  assert.equal(roleOf('Priest', 'Holy'), 'Healer');
  assert.equal(roleOf('Paladin', 'Protection'), 'Tank');
  assert.equal(roleOf('Warrior', 'Protection'), 'Tank');
  // Frost is a DPS spec for both classes that have it
  assert.equal(roleOf('DeathKnight', 'Frost'), 'DPS');
  assert.equal(roleOf('Mage', 'Frost'), 'DPS');
});

test('roleOf: tanks and healers are classified', () => {
  assert.equal(roleOf('DeathKnight', 'Blood'), 'Tank');
  assert.equal(roleOf('DemonHunter', 'Vengeance'), 'Tank');
  assert.equal(roleOf('Druid', 'Guardian'), 'Tank');
  assert.equal(roleOf('Monk', 'Brewmaster'), 'Tank');
  assert.equal(roleOf('Druid', 'Restoration'), 'Healer');
  assert.equal(roleOf('Shaman', 'Restoration'), 'Healer');
  assert.equal(roleOf('Monk', 'Mistweaver'), 'Healer');
  assert.equal(roleOf('Evoker', 'Preservation'), 'Healer');
});

test('roleOf: anything unlisted defaults to DPS, so new specs need no code change', () => {
  assert.equal(roleOf('DemonHunter', 'Devourer'), 'DPS'); // added in Midnight
  assert.equal(roleOf('Evoker', 'Augmentation'), 'DPS');
  assert.equal(roleOf('Shaman', 'Enhancement'), 'DPS');
  assert.equal(roleOf('Hunter', 'BeastMastery'), 'DPS');
  assert.equal(roleOf('SomeNewClass', 'SomeNewSpec'), 'DPS');
});

test('isDps mirrors roleOf', () => {
  assert.equal(isDps('Shaman', 'Enhancement'), true);
  assert.equal(isDps('Shaman', 'Restoration'), false);
});

// `usesRunicPower` / `usesEpidemicSpenderMix` used to live here, gating the resource
// panel to Death Knights. They are gone — the resource is read off the log now (see
// test/resources.test.js), so there is no spec capability table left to test.
