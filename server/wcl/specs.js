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

// There used to be `usesRunicPower` / `usesEpidemicSpenderMix` here, gating the
// resource panel to Death Knights. They are gone: the resource is now read off the
// log itself (see analysis/resources.js), so no spec capability table is needed —
// which also means nothing to update when a new spec ships.
