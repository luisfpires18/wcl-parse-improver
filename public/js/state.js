// Shared app state. A single mutable object rather than exported `let`s, so
// every module reads the same live values instead of a stale copy of a binding.
//
// The active spec is threaded to every endpoint so the overview, the cohort and
// the "mine" run are all filtered to one spec — WCL otherwise returns the best
// across all of a character's specs, silently mixing e.g. Havoc and Devourer.
import { $ } from './util.js';

export const state = {
  characters: [],
  activeChar: null,
  activeSpec: null, // always a spec SLUG, never the display name
  currentOverview: null,
};

/** The character/spec query params every endpoint expects. */
export function charQuery() {
  const c = state.activeChar;
  return new URLSearchParams({
    name: c.name,
    server: c.server,
    region: c.region,
    zone: String(c.zone),
    className: c.className,
    specName: state.activeSpec, // the SLUG — "BeastMastery", not "Beast Mastery"
    classLabel: c.classLabel ?? '', // display-only: "Death Knight" reads better than "DeathKnight" in an error
  });
}

export function setStatus(html) {
  $('#status').innerHTML = html;
}
