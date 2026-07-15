// Class colours and spec icons.
//
// Warcraft Logs' schema has no icon field (GameSpec is id/class/name/slug only),
// so specs are mapped to their Blizzard icon by hand and served from Wowhead's
// CDN. Every name below was checked to resolve — but a spec added by a patch
// won't be here (Devourer, at time of writing), so specIcon() falls back to the
// class icon rather than a broken image.
//
// Keys are the WCL slugs, which is what the rest of the app already speaks.

export const CLASS_COLORS = {
  DeathKnight: '#C41E3A',
  DemonHunter: '#A330C9',
  Druid: '#FF7C0A',
  Evoker: '#33937F',
  Hunter: '#AAD372',
  Mage: '#3FC7EB',
  Monk: '#00FF98',
  Paladin: '#F48CBA',
  Priest: '#FFFFFF',
  Rogue: '#FFF468',
  Shaman: '#0070DD',
  Warlock: '#8788EE',
  Warrior: '#C69B6D',
};

const CLASS_ICONS = {
  DeathKnight: 'classicon_deathknight',
  DemonHunter: 'classicon_demonhunter',
  Druid: 'classicon_druid',
  Evoker: 'classicon_evoker',
  Hunter: 'classicon_hunter',
  Mage: 'classicon_mage',
  Monk: 'classicon_monk',
  Paladin: 'classicon_paladin',
  Priest: 'classicon_priest',
  Rogue: 'classicon_rogue',
  Shaman: 'classicon_shaman',
  Warlock: 'classicon_warlock',
  Warrior: 'classicon_warrior',
};

const SPEC_ICONS = {
  'DeathKnight.Blood': 'spell_deathknight_bloodpresence',
  'DeathKnight.Frost': 'spell_deathknight_frostpresence',
  'DeathKnight.Unholy': 'spell_deathknight_unholypresence',

  'DemonHunter.Havoc': 'ability_demonhunter_specdps',
  'DemonHunter.Vengeance': 'ability_demonhunter_spectank',
  // Devourer, the Midnight void spec — its actual spec-select icon (the horned
  // void demon), the sibling of Havoc/Vengeance's specdps/spectank.
  'DemonHunter.Devourer': 'classicon_demonhunter_void',

  'Druid.Balance': 'spell_nature_starfall',
  'Druid.Feral': 'ability_druid_catform',
  'Druid.Guardian': 'ability_racial_bearform',
  'Druid.Restoration': 'spell_nature_healingtouch',

  'Evoker.Devastation': 'classicon_evoker_devastation',
  'Evoker.Preservation': 'classicon_evoker_preservation',
  'Evoker.Augmentation': 'classicon_evoker_augmentation',

  'Hunter.BeastMastery': 'ability_hunter_bestialdiscipline',
  'Hunter.Marksmanship': 'ability_hunter_focusedaim',
  'Hunter.Survival': 'ability_hunter_camouflage',

  'Mage.Arcane': 'spell_holy_magicalsentry',
  'Mage.Fire': 'spell_fire_firebolt02',
  'Mage.Frost': 'spell_frost_frostbolt02',

  'Monk.Brewmaster': 'spell_monk_brewmaster_spec',
  'Monk.Mistweaver': 'spell_monk_mistweaver_spec',
  'Monk.Windwalker': 'spell_monk_windwalker_spec',

  'Paladin.Holy': 'spell_holy_holybolt',
  'Paladin.Protection': 'ability_paladin_shieldofthetemplar',
  'Paladin.Retribution': 'spell_holy_auraoflight',

  'Priest.Discipline': 'spell_holy_powerwordshield',
  'Priest.Holy': 'spell_holy_guardianspirit',
  'Priest.Shadow': 'spell_shadow_shadowwordpain',

  'Rogue.Assassination': 'ability_rogue_deadlybrew',
  'Rogue.Outlaw': 'ability_rogue_waylay',
  'Rogue.Subtlety': 'ability_stealth',

  'Shaman.Elemental': 'spell_nature_lightning',
  'Shaman.Enhancement': 'spell_shaman_improvedstormstrike',
  'Shaman.Restoration': 'spell_nature_magicimmunity',

  'Warlock.Affliction': 'spell_shadow_deathcoil',
  'Warlock.Demonology': 'spell_shadow_metamorphosis',
  'Warlock.Destruction': 'spell_shadow_rainoffire',

  'Warrior.Arms': 'ability_warrior_savageblow',
  'Warrior.Fury': 'ability_warrior_innerrage',
  'Warrior.Protection': 'ability_warrior_defensivestance',
};

// Roles. The report is damage-based, so only DPS can be analysed — but a tank or
// healer spec still belongs on the roster with its score, and the icon is what
// says at a glance why the analysis picker won't take it.
const ROLE_ICONS = {
  Tank: 'inv_shield_06',
  Healer: 'spell_holy_flashheal',
  DPS: 'ability_dualwield',
};

export const ROLE_COLORS = {
  Tank: '#5c8fd6',
  Healer: '#4fd68a',
  DPS: '#d65c5c',
};

// Ornaments. Used sparingly — one per view, as a sigil, not as decoration
// sprinkled through the page.
export const SIGILS = {
  keystone: 'inv_misc_key_13',
  raid: 'achievement_boss_lichking',
  banner: 'inv_misc_tournaments_banner_orc',
  sword: 'inv_sword_2h_artifactashbringer_d_01',
};

const url = (icon) => `https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg`;

export const roleIconUrl = (role) => (ROLE_ICONS[role] ? url(ROLE_ICONS[role]) : null);
export const sigilUrl = (name) => (SIGILS[name] ? url(SIGILS[name]) : null);

export const classColor = (className) => CLASS_COLORS[className] ?? 'var(--text)';

export const classIconUrl = (className) =>
  CLASS_ICONS[className] ? url(CLASS_ICONS[className]) : null;

/** A spec's icon, or the class icon for a spec we don't know yet (new patch). */
export const specIconUrl = (className, specSlug) => {
  const icon = SPEC_ICONS[`${className}.${specSlug}`];
  return icon ? url(icon) : classIconUrl(className);
};
