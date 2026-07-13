// Entry point + the three-view router.
//
//   Characters  — the roster: add, hide, remove
//   M+ Parses   — dungeon table -> the eight-section report
//   Raid Parses — paste a log -> boss -> pull -> the SAME eight-section report
//
// js/:
//   util.js       formatting, escaping, colour scale
//   state.js      active character/spec + the query params every endpoint takes
//   chart.js      DPS chart, boss-health overlay, rotation timeline, cast order
//   report.js     THE eight sections — one renderer, used by both analysis views
//   characters.js roster + the active-character bar
//   mplus.js      dungeon overview -> report
//   raid.js       log -> boss -> pull -> report
import { $ } from './js/util.js';
import { state } from './js/state.js';
import { refreshCharacters, renderCharBar, renderCharacterList, initAddCharacter, visibleCharacters } from './js/characters.js';
import { loadOverview } from './js/mplus.js';
import { renderRaidCard } from './js/raid.js';

const VIEWS = ['characters', 'mplus', 'raid'];
let currentView = 'mplus';

function show(view) {
  currentView = view;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  // the character bar only makes sense where we're analysing something
  $('#char-bar').hidden = view === 'characters';
  render();
}

/** Re-render whatever view is open, for the currently active character. */
function render() {
  if (currentView === 'characters') {
    renderCharacterList(onCharacterChange);
    return;
  }
  if (!state.activeChar) {
    $('#status').innerHTML = '<span class="muted">Add a character on the Characters tab to get started.</span>';
    return;
  }
  $('#status').innerHTML = '';
  renderCharBar(onCharacterChange);
  if (currentView === 'mplus') loadOverview();
  else if (currentView === 'raid') renderRaidCard();
}

/** The active character (or the roster) changed — redraw the open view. */
function onCharacterChange() {
  if (currentView !== 'characters') render();
}

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-link');
  if (btn) show(btn.dataset.view);
});

async function boot() {
  initAddCharacter(onCharacterChange);
  await refreshCharacters();
  show(visibleCharacters().length ? 'mplus' : 'characters');
}

boot();
