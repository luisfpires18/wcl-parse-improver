// What counts as a potion — decided by the ICON, not the name.
//
// The old test was a name prefix, `/^potion of|^elixir/i`. That is a guess about
// naming, and the game breaks it: "Light's Potential" is a combat potion that the
// whole field drinks and the prefix misses it entirely, so it never showed as an
// amplifier and never counted toward potions-used.
//
// Two independent pieces of evidence, either of which is enough, because neither
// alone covers the field. Verified against 29 top-ranked kills:
//
//   ICON — carries the word whatever the item is called, which is the only way to
//   catch a potion that never says so:
//     Light's Potential          inv_12_profession_alchemy_lightpotion_yellow.jpg
//     Draught of Rampant Abandon inv_12_profession_alchemy_voidpotion_purple.jpg
//     Potion of Recklessness     inv_12_profession_alchemy_voidpotion_red.jpg
//     Silvermoon Health Potion   inv_potion_49.jpg
//
//   NAME — the backstop for a potion whose art we have never seen. "Potion of
//   Zealotry" appears in none of the logs checked, so its icon is unknown; its name
//   is not, and a thing called a potion is a potion.
//
// The trap is the FLASK: its art is a potion bottle —
// inv_12_profession_alchemy_flask_sindoreipotion_red-- — so matching "potion" in the
// icon counted the flask as a drink and reported "2 potions used, 1 possible". A
// flask always calls itself a flask; a potion never does. The exclusion wins first.
//
// "elixir" is deliberately NOT name evidence: "Healing Elixir" is a monk TALENT
// (ability_monk_jasmineforcetea.jpg), and a name rule would have counted it as a
// consumable. It survives only as a last resort when there is no icon at all.
//
// Both the Casts table and the Buffs table carry `abilityIcon`, so the same test
// works on a cast you pressed and on a buff you are only seen wearing.
const POTION_ICON_RE = /potion/i;
const POTION_NAME_RE = /\bpotion\b|\bdraught\b/i;
const NO_ICON_FALLBACK_RE = /\bpotion\b|\bdraught\b|\belixir\b/i;
const NOT_A_POTION_RE = /flask|phial/i; // maintained for the fight, not pressed

/** @param {{name?:string, abilityIcon?:string|null}} entry a casts-table ability or a buffs-table aura */
export function isPotion(entry) {
  if (!entry) return false;
  const name = entry.name ?? '';
  const icon = entry.abilityIcon ?? '';
  if (NOT_A_POTION_RE.test(name) || NOT_A_POTION_RE.test(icon)) return false;
  if (!icon) return NO_ICON_FALLBACK_RE.test(name);
  return POTION_ICON_RE.test(icon) || POTION_NAME_RE.test(name);
}
