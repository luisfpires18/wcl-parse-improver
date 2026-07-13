// Entry point. Everything else lives in js/:
//   util.js       formatting, escaping, colour scale
//   state.js      shared app state + the char/spec query params
//   chart.js      DPS chart, boss-health overlay, rotation timeline, cast order
//   characters.js nav, character header, add-character flow
//   mplus.js      dungeon overview + per-dungeon report
//   raid.js       raid log -> boss -> pulls, death timing, rotation vs top parser
// The rotation-match maths is in /shared/rotationMatch.js — the same file the
// server imports, so a brushed window and a whole run can't disagree.
import { state } from './js/state.js';
import { initCharacterUI, renderNav, selectCharacter, showAddCharacter } from './js/characters.js';

async function boot() {
  initCharacterUI();
  try {
    const res = await fetch('/api/characters');
    state.characters = await res.json();
  } catch {
    state.characters = [];
  }
  renderNav();
  if (state.characters.length) selectCharacter(state.characters[0].id);
  else showAddCharacter();
}

boot();
