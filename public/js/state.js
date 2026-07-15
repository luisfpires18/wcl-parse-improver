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
  // Which zone the roster import asks about: it decides which specs count as
  // "logged", and is stored on each character as the zone its rankings come from.
  zone: 47,
  // Which role ranks the roster board: All | DPS | Tank | Healer.
  roleFilter: 'All',
  // How the M+ dungeon board is ordered: weakest | best. Weakest first by
  // default — the worst parse is the one worth opening.
  mplusSort: 'weakest',
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

/**
 * The one loading indicator, always at the top of the page — a spinner plus a
 * message — so a slow fetch never leaves the user staring at a blank spot lower
 * down wondering if anything is happening. `html` may contain markup.
 */
export function showLoading(html) {
  const el = $('#loading');
  if (!el) return;
  el.hidden = false;
  el.className = 'loading-banner';
  el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="loading-msg">${html}</span>`;
}

export function hideLoading() {
  const el = $('#loading');
  if (!el) return;
  el.hidden = true;
  el.innerHTML = '';
}

/** A shimmering placeholder to drop where content is about to appear. */
export const skeleton = (lines = 3) =>
  `<div class="skeleton-card">${'<div class="skeleton-line"></div>'.repeat(lines)}</div>`;
