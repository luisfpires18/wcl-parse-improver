// Spec roles. Warcraft Logs' GameSpec type carries no role field, so this is
// the one piece of class knowledge the API can't give us.
//
// Keyed by `${classSlug}/${specSlug}` — spec names collide across classes and a
// name-only key would be wrong: "Holy" is Paladin AND Priest, "Protection" is
// Paladin AND Warrior, "Frost" is Death Knight AND Mage.
//
// Only non-DPS specs are listed. Anything absent is DPS, so a newly added spec
// (Devourer, Augmentation) needs no code change here.
const NON_DPS = {
  'DeathKnight/Blood': 'Tank',
  'DemonHunter/Vengeance': 'Tank',
  'Druid/Guardian': 'Tank',
  'Druid/Restoration': 'Healer',
  'Monk/Brewmaster': 'Tank',
  'Monk/Mistweaver': 'Healer',
  'Paladin/Protection': 'Tank',
  'Paladin/Holy': 'Healer',
  'Priest/Discipline': 'Healer',
  'Priest/Holy': 'Healer',
  'Shaman/Restoration': 'Healer',
  'Warrior/Protection': 'Tank',
  'Evoker/Preservation': 'Healer',
};

/** @returns {'DPS'|'Healer'|'Tank'} */
export function roleOf(classSlug, specSlug) {
  return NON_DPS[`${classSlug}/${specSlug}`] ?? 'DPS';
}

export const isDps = (classSlug, specSlug) => roleOf(classSlug, specSlug) === 'DPS';

// --- spec capabilities -----------------------------------------------------
// Which spec-specific analysis panels have any meaning. A spec that lacks the
// resource model must not render an empty table of another class's abilities.

/** Runic Power is the Death Knight resource — RP waste applies to all its specs. */
export const usesRunicPower = (classSlug) => classSlug === 'DeathKnight';

/** The Death Coil vs Epidemic spender split is Unholy-only (Frost spends on Frost Strike). */
export const usesEpidemicSpenderMix = (classSlug, specSlug) =>
  classSlug === 'DeathKnight' && specSlug === 'Unholy';
