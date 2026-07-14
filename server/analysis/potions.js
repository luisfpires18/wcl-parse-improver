// What counts as a potion — decided by the ICON, not the name.
//
// The old test was a name prefix, `/^potion of|^elixir/i`. That is a guess about
// naming, and the game breaks it: "Light's Potential" is a combat potion that the
// whole field drinks and the prefix misses it entirely, so it never showed as an
// amplifier and never counted toward potions-used.
//
// Every potion's icon carries the word, whatever the item is called:
//
//   Potion of Recklessness   inv_12_profession_alchemy_voidpotion_red.jpg
//   Light's Potential        inv_12_profession_alchemy_lightpotion_yellow.jpg
//   Silvermoon Health Potion inv_potion_49.jpg
//
// But so does a FLASK, which is the trap: "Flask of the Shattered Sun" is
// inv_12_profession_alchemy_flask_sindoreipotion_red--.jpg — the art is a Sin'dorei
// potion bottle. Matching "potion" alone counted the flask as a drink and reported
// "2 potions used, 1 possible". A flask always says flask (in the icon and in the
// name); a potion never does. So: potion art, minus anything calling itself a flask.
//
// Both the Casts table and the Buffs table carry `abilityIcon`, so the same test
// works on a cast you pressed and on a buff you are only seen wearing.
const POTION_ICON_RE = /potion/i;
const POTION_NAME_RE = /potion|elixir/i;
const NOT_A_POTION_RE = /flask|phial/i; // maintained for the fight, not pressed

/** @param {{name?:string, abilityIcon?:string|null}} entry a casts-table ability or a buffs-table aura */
export function isPotion(entry) {
  if (!entry) return false;
  const name = entry.name ?? '';
  const icon = entry.abilityIcon ?? '';
  if (NOT_A_POTION_RE.test(name) || NOT_A_POTION_RE.test(icon)) return false;
  return icon ? POTION_ICON_RE.test(icon) : POTION_NAME_RE.test(name);
}
