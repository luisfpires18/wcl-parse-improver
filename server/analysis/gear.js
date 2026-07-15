// Gear check: your enchants and gems vs the player you're measured against.
//
// There is deliberately NO hardcoded "these slots are enchantable" list. Which
// slots take an enchant changes between patches (Midnight added head/shoulder
// enchants, for instance), and a stale list would either nag about slots that
// can't be enchanted or miss ones that newly can. Instead the enchantable set is
// *derived from the data*: if the benchmark player enchanted a slot, that slot is
// enchantable — so if you didn't, that's a real, current gap. Same for gem
// sockets. This is the app's whole philosophy applied to gear: compare, don't
// assume, and survive the next patch for free.
//
// Embellishments are not audited: they are a crafting property with no reliable
// signal in the combatant snapshot (no enchant field, and their bonus IDs differ
// per embellishment and per patch). Their PROC buffs used to surface as bogus
// rotation gaps; that is fixed in compare.js by only flagging buffs you cast.

// Human slot names by combatant-info index. Cosmetic slots are already dropped
// upstream (parseGear), so they never reach here.
const SLOT_LABEL = {
  0: 'Head',
  1: 'Neck',
  2: 'Shoulder',
  4: 'Chest',
  5: 'Waist',
  6: 'Legs',
  7: 'Feet',
  8: 'Wrist',
  9: 'Hands',
  10: 'Ring 1',
  11: 'Ring 2',
  12: 'Trinket 1',
  13: 'Trinket 2',
  14: 'Back',
  15: 'Main Hand',
  16: 'Off Hand',
};

/**
 * @param {Array|null} mineGear from fetchRunDetail({ includeGear:true })
 * @param {Array|null} otherGear the benchmark player's gear
 * @param {string} otherName label for the benchmark
 * @returns {object|null} null when either side has no gear snapshot (old logs)
 */
export function buildGearCheck(mineGear, otherGear, otherName) {
  if (!mineGear?.length || !otherGear?.length) return null;

  const bySlot = (list) => new Map(list.map((it) => [it.slot, it]));
  const mine = bySlot(mineGear);
  const them = bySlot(otherGear);

  const rows = [];
  for (const slot of new Set([...mine.keys(), ...them.keys()])) {
    const a = mine.get(slot);
    const b = them.get(slot);
    if (!a) continue; // a slot only they filled isn't "your gear missing an upgrade" to flag here

    // Enchantable ⇔ the benchmark enchanted it. Missing ⇔ they did, you didn't.
    const theyEnchant = (b?.enchant ?? 0) > 0;
    const iEnchant = a.enchant > 0;
    const missingEnchant = theyEnchant && !iEnchant;

    // Same logic for gem sockets: they socketed more than you on this slot.
    const missingGem = (b?.gems ?? 0) > a.gems;

    rows.push({
      slot,
      label: SLOT_LABEL[slot] ?? `Slot ${slot}`,
      myEnchant: iEnchant,
      theirEnchant: theyEnchant,
      myGems: a.gems,
      theirGems: b?.gems ?? 0,
      missingEnchant,
      missingGem,
    });
  }

  rows.sort((x, y) => x.slot - y.slot);
  const missingEnchants = rows.filter((r) => r.missingEnchant);
  const missingGems = rows.filter((r) => r.missingGem);

  // Notes are plain text; report.js HTML-escapes them on render, so the player
  // name goes in raw here.
  const notes = [];
  if (missingEnchants.length) {
    notes.push(
      `No enchant on ${missingEnchants.map((r) => r.label).join(', ')}. ${otherName} enchanted ` +
        `${missingEnchants.length === 1 ? 'it' : 'them'} and you didn't; free stats.`
    );
  }
  if (missingGems.length) {
    notes.push(
      `Fewer gems than ${otherName} on ${missingGems.map((r) => r.label).join(', ')}. Check for an empty socket.`
    );
  }
  if (!notes.length) {
    notes.push(`Your enchants and gems match ${otherName} slot for slot. Nothing to fix here.`);
  }

  return {
    otherLabel: otherName,
    rows,
    missingEnchants: missingEnchants.length,
    missingGems: missingGems.length,
    clean: !missingEnchants.length && !missingGems.length,
    notes,
  };
}
