// Live-fetched Unholy DK Mythic+ rotation reference. This is opinion from an
// external guide, NOT derived from your logs — keep it visually and
// structurally separate from the "data says" gap analysis everywhere it's
// rendered. Never let this content influence gap severity/ranking; it's
// display-only context to help read the rotation timeline.
//
// Fetched live via WebFetch on 2026-07-07 (not from training memory, per the
// project's own rule against guessing current rotation). Source content can
// go stale after balance patches — to refresh, ask Claude to re-run
// WebSearch("Unholy Death Knight Mythic+ guide <current season>") and
// WebFetch the rotation page, then update this file.
//
// MECHANIC_NOTES below are a separate, smaller set of facts confirmed by
// the player directly (not from the cited guide) — kept in their own
// export with their own `source` tag so "guide says" never gets muddied
// with "player says".
export const GUIDE_META = {
  sourceUrl: 'https://www.icy-veins.com/wow/unholy-death-knight-pve-dps-rotation-cooldowns-abilities',
  sourceName: 'Icy Veins',
  patch: '12.0.7',
  fetchedAt: '2026-07-07',
};

export const OPENER = {
  singleTarget: [
    'Outbreak',
    'Festering Strike x2',
    'Army of the Dead + Dark Transformation + trinket + racial + potion',
    'Putrefy x2',
    'Soul Reaper',
    'Putrefy x2',
    'Soul Reaper 5s before Dark Transformation ends',
  ],
  multiTarget: [
    'Outbreak',
    'Festering Strike x2',
    'Army of the Dead + Dark Transformation + trinket + racial + potion',
    'Soul Reaper',
    'Putrefy x2',
  ],
};

export const PRIORITY = {
  singleTarget: [
    'Outbreak to maintain your plagues on the target',
    'Festering Scythe if its buff has fallen off',
    'Soul Reaper if the target is below 35% HP and Dark Transformation is active, or Reaping has triggered',
    'Death Coil on a Sudden Doom proc',
    'Putrefy if Dark Transformation is active',
    'Festering Strike if under 3 stacks of Lesser Ghoul',
    'Scourge Strike if you have at least 1 stack',
    'Death Coil as filler',
  ],
  multiTarget: [
    'Outbreak to maintain your plagues',
    'Festering Scythe if its buff has fallen off',
    'Death and Decay at 3+ enemies',
    'Soul Reaper if any enemy is below 35% HP',
    'Epidemic at 80+ Runic Power or a Sudden Doom proc',
    'Putrefy if Dark Transformation is active',
    'Festering Strike if under 3 stacks of Lesser Ghoul',
    'Scourge Strike if you have at least 1 stack',
    'Epidemic as filler',
  ],
};

export const BREAKPOINTS = [
  {
    targets: '1-2',
    rule: 'Death Coil',
    detail: 'Single-target spender at 2 or fewer enemies.',
  },
  {
    targets: '3+',
    rule: 'Epidemic',
    detail: 'Switch spenders at 3+ enemies (exception: 6+ during the Forbidden Knowledge buff, where Death Coil stays live longer).',
  },
  {
    targets: '3+',
    rule: 'Death and Decay',
    detail: 'Drop Death and Decay once 3 or more enemies are engaged.',
  },
  {
    targets: 'up to 4 (during Forbidden Knowledge)',
    rule: 'Necrotic Coil',
    detail: 'Death Coil transforms into Necrotic Coil for 30s after Army of the Dead (Forbidden Knowledge talent) — cleaves up to 3 targets at full damage, so it stays worth using up to 4 enemies instead of Death Coil\'s normal 2-or-fewer cutoff.',
  },
  {
    targets: '5+ (during Forbidden Knowledge)',
    rule: 'Graveyard',
    detail: 'Epidemic transforms into Graveyard for the same 30s window — used at 5+ targets instead of Epidemic\'s normal 3+.',
  },
];

export const COOLDOWNS = {
  generalNote: 'Cooldowns align on a roughly 45-second cycle — use them as soon as they come up; delaying pushes your whole burst window back.',
  darkTransformationNote: 'Use Dark Transformation on cooldown, aligning it with Army of the Dead every second time. Enter the window with high Lesser Ghoul stacks (6-8) if possible.',
  trinketNote: 'Trinkets, racials and potions can be macroed directly into the Army of the Dead opener.',
};

// Mechanic clarifications verified via WebSearch on 2026-07-07 (Warcraft
// Wiki, Method.gg, Maxroll) after the player flagged that these two
// abilities are NOT just reskins of Epidemic/Death Coil — kept separate
// from the Icy Veins rotation-page content above so provenance stays
// honest: "guide says" above is only ever that one cited URL; this is a
// distinct fact-check with its own sources.
export const MECHANIC_NOTES = [
  {
    abilities: ['Graveyard', 'Necrotic Coil'],
    note:
      'Both come from the Forbidden Knowledge talent: a 30s window after casting Army of the Dead ' +
      'transforms Epidemic into Graveyard (used at 5+ targets) and Death Coil into Necrotic Coil ' +
      '(cleaves up to 3 targets at full damage, used at up to 4 — vs. plain Death Coil\'s single target, ' +
      'normally used at 2 or fewer). Both scale with active Magus of the Dead count. Genuinely different ' +
      'abilities with their own target-count breakpoints, not just a reskin of the baseline spender.',
    source: 'web search, 2026-07-07 (Warcraft Wiki / Method.gg / Maxroll)',
  },
];

export function getGuideReference() {
  return {
    meta: GUIDE_META,
    opener: OPENER,
    priority: PRIORITY,
    breakpoints: BREAKPOINTS,
    cooldowns: COOLDOWNS,
    mechanicNotes: MECHANIC_NOTES,
  };
}
