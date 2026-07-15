// Characters: the roster (import / hide / remove) and the active-character bar
// shown on the two analysis views.
//
// There is no add-by-hand form: every character comes from the signed-in user's
// Warcraft Logs profile, which spells the server slug correctly and knows which
// specs have actually been logged.
//
// `hidden` keeps a character tracked but out of the analysis picker — for alts you
// want to keep without cluttering the list.
import { $, esc, EMPTY } from './util.js';
import { state } from './state.js';
import { classColor, classIconUrl, specIconUrl, roleIconUrl, ROLE_COLORS } from './icons.js';

/**
 * The roster keeps every role. The report is damage-based, so only DPS drives it.
 * Best-scoring spec first: that's the one the player actually plays, so it's the
 * one the picker should land on.
 */
export const dpsSpecs = (c) =>
  (c?.specs ?? []).filter((s) => s.role === 'DPS').sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

/** On the roster: everything not hidden. */
export const visibleCharacters = () => state.characters.filter((c) => !c.hidden);

/**
 * Offered in the M+/Raid pickers: not hidden, and has a DPS spec to analyse.
 * A tank-only character is still tracked and still shows its score — it just has
 * nothing the damage-based report can say about it.
 */
export const analysableCharacters = () => visibleCharacters().filter((c) => dpsSpecs(c).length);

export async function refreshCharacters() {
  try {
    state.characters = await (await fetch('/api/characters')).json();
  } catch {
    state.characters = [];
  }
  // keep the active character valid
  if (!state.activeChar || !analysableCharacters().some((c) => c.id === state.activeChar.id)) {
    setActiveCharacter(analysableCharacters()[0] ?? null);
  }
}

export function setActiveCharacter(c) {
  state.activeChar = c;
  // never a tank/healer spec: the endpoints would answer, but with damage
  // rankings for a spec the player never plays for damage.
  state.activeSpec = dpsSpecs(c)[0]?.slug ?? null;
}

// --- the bar on the analysis views ------------------------------------------

export function renderCharBar(onChange) {
  const bar = $('#char-bar');
  if (!bar) return;
  const chars = analysableCharacters();
  if (!chars.length) {
    bar.innerHTML = `<div class="char-bar"><span class="muted">No characters with a DPS spec. Import them on the Characters tab.</span></div>`;
    return;
  }
  const c = state.activeChar;
  const activeSpecName = dpsSpecs(c).find((s) => s.slug === state.activeSpec)?.name ?? state.activeSpec;
  const charOpts = chars
    .map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)} · ${esc(x.classLabel)}</option>`)
    .join('');
  const specOpts = dpsSpecs(c)
    .map((s) => `<option value="${esc(s.slug)}" ${s.slug === state.activeSpec ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');

  const stat = (label, value, cls = '') =>
    `<span class="cstat"><i>${label}</i> <b class="${cls}">${value}</b></span>`;

  bar.innerHTML = `
    <div class="char-bar" style="--class: ${classColor(c.className)}">
      <img class="char-portrait" src="${esc(specIconUrl(c.className, state.activeSpec))}" alt="" />
      <div class="char-id">
        <div class="char-name">${esc(c.name)}</div>
        <div class="char-sub">
          <img class="icon" src="${esc(classIconUrl(c.className))}" alt="" />
          <span>${esc(c.classLabel)}</span>
          <span class="sep">·</span>
          <b>${esc(activeSpecName)}</b>
          <span class="muted">${esc(c.server)} (${esc(c.region)})</span>
        </div>
        <div class="char-stats">
          ${stat('M+', score(c.mplusRating), 'rating')}
          ${stat('ilvl', c.itemLevel ?? EMPTY)}
          ${stat('lvl', c.level ?? EMPTY)}
        </div>
      </div>
      <div class="char-switch">
        <label>character<select id="f-char">${charOpts}</select></label>
        <label>spec<select id="f-spec">${specOpts}</select></label>
      </div>
    </div>`;

  $('#f-char').addEventListener('change', (e) => {
    setActiveCharacter(chars.find((x) => x.id === e.target.value));
    renderCharBar(onChange);
    onChange?.();
  });
  $('#f-spec').addEventListener('change', (e) => {
    state.activeSpec = e.target.value;
    onChange?.();
  });
}

// --- the roster ---------------------------------------------------------------
//
// A ranking board, not a table: the roster's whole job is "which character is
// furthest along", and a bar answers that faster than a column of numbers. The
// bar is scaled against the best character on screen, so it reads as a
// comparison rather than an absolute.

const score = (v) => (typeof v === 'number' ? Math.round(v).toLocaleString() : EMPTY);

const FILTERS = [
  { key: 'All', label: 'All' },
  { key: 'DPS', label: 'Damage' },
  { key: 'Tank', label: 'Tanks' },
  { key: 'Healer', label: 'Healers' },
];

const specsOfRole = (c, role) =>
  (c.specs ?? [])
    .filter((s) => role === 'All' || s.role === role)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

/**
 * What ranks a character under the current filter: the best score among the
 * specs of that role. Under "Tanks", a 4k Unholy DK ranks on its Blood score —
 * which is the point of the filter.
 */
const rankScore = (c, role) => specsOfRole(c, role)[0]?.points ?? null;

const specChip = (className, spec, lead) => `
  <span class="chip ${lead ? 'lead' : ''}" title="${esc(spec.name)} · ${esc(spec.role)}, ${score(spec.points)}">
    <img class="icon" src="${esc(specIconUrl(className, spec.slug))}" alt="" loading="lazy" />
    <span>${esc(spec.name)}</span>
    <img class="icon role" src="${esc(roleIconUrl(spec.role))}" alt="${esc(spec.role)}"
         style="border-color: ${ROLE_COLORS[spec.role] ?? 'var(--border)'}" loading="lazy" />
    <b class="chip-score">${score(spec.points)}</b>
  </span>`;

export function renderCharacterList(onChange) {
  const el = $('#char-list');
  if (!el) return;

  const role = state.roleFilter ?? 'All';
  const listed = state.characters
    .filter((c) => specsOfRole(c, role).length)
    .sort(
      (a, b) =>
        (rankScore(b, role) ?? -1) - (rankScore(a, role) ?? -1) ||
        (b.itemLevel ?? -1) - (a.itemLevel ?? -1) ||
        (b.level ?? -1) - (a.level ?? -1)
    );

  // Bars are relative to the best character on screen, so the leader fills the
  // track and everyone else is read against them.
  const top = Math.max(1, ...listed.map((c) => rankScore(c, role) ?? 0));

  const pills = FILTERS.map(
    (f) => `<button class="pill ${f.key === role ? 'on' : ''}" data-role="${f.key}">
      ${f.key === 'All' ? '' : `<img class="icon role" src="${esc(roleIconUrl(f.key))}" alt="" />`}
      ${esc(f.label)}
    </button>`
  ).join('');

  const rows = listed
    .map((c, i) => {
      const color = classColor(c.className);
      const value = rankScore(c, role);
      const pct = Math.max(4, Math.round(((value ?? 0) / top) * 100));
      const specs = specsOfRole(c, role);
      const analysable = dpsSpecs(c).length > 0;

      return `<div class="rank-row ${c.hidden ? 'unanalysed' : ''}" style="--class: ${color}">
        <span class="rank">${i + 1}</span>
        <img class="portrait" src="${esc(classIconUrl(c.className))}" alt="" loading="lazy" />
        <div class="rank-body">
          <div class="bar" style="width: ${pct}%">
            <span class="who">
              <b>${esc(c.name)}</b>
              <small>${esc(c.classLabel)} · ${esc(c.server)} (${esc(c.region)})</small>
            </span>
          </div>
          <b class="value">${score(value)}</b>
        </div>
        <div class="rank-meta">
          <span class="stat" title="Equipped item level"><i>ilvl</i> ${c.itemLevel ?? EMPTY}</span>
          <span class="stat muted" title="Character level"><i>lvl</i> ${c.level ?? EMPTY}</span>
          ${
            analysable
              ? ''
              : '<span class="stat warn" title="The report is damage-based, so this character has nothing to analyse">no DPS spec</span>'
          }
        </div>
        <div class="rank-specs">${specs.map((s, n) => specChip(c.className, s, n === 0)).join('')}</div>
        <div class="row-actions">
          <button class="mini" data-hide="${esc(c.id)}" data-to="${c.hidden ? '0' : '1'}">${c.hidden ? 'Show' : 'Hide'}</button>
          <button class="mini danger" data-remove="${esc(c.id)}">Remove</button>
        </div>
      </div>`;
    })
    .join('');

  // Roster summary: how many are tracked, and the best M+ rating among them.
  const n = state.characters.length;
  const best = Math.max(0, ...state.characters.map((c) => c.mplusRating ?? 0));
  const summary = n
    ? `<span class="roster-summary">${n} tracked${best ? ` · best <b>${score(best)}</b>` : ''}</span>`
    : '';

  el.innerHTML = `
    <div class="card">
      <div class="roster-head">
        <div class="roster-title">
          <h2>Characters</h2>
          ${summary}
        </div>
        ${n ? `<div class="pills">${pills}</div>` : ''}
        <div class="roster-import">
          <button id="import-chars" class="accent">Import my characters</button>
          <label class="spec-pick">zone <input id="import-zone" value="${esc(state.zone)}" size="4" /></label>
        </div>
      </div>
      <div id="import-status" class="muted">
        ${n ? '' : 'Pulls every character you have claimed on your Warcraft Logs profile.'}
      </div>

      ${
        rows
          ? `<div class="board">${rows}</div>
             <p class="table-note"><small>Ranked by <b>M+ score</b> for the selected role, then item level, then level.
               Bars are relative to the best character here. Tanks and healers are tracked and scored, but the report is
               damage-based, so only DPS specs reach the M+ and Raid views. <b>Hide</b> keeps a character out of those
               pickers.</small></p>`
          : n
            ? `<p class="muted">No character has a ${esc(role === 'All' ? '' : role.toLowerCase())} spec with logged runs.</p>`
            : '<p class="muted">No characters yet. Import them from your Warcraft Logs profile.</p>'
      }
    </div>`;

  el.querySelectorAll('[data-role]').forEach((b) =>
    b.addEventListener('click', () => {
      state.roleFilter = b.dataset.role;
      renderCharacterList(onChange);
    })
  );

  $('#import-chars').addEventListener('click', () => importCharacters(onChange));

  el.querySelectorAll('[data-hide]').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch(`/api/characters/${encodeURIComponent(b.dataset.hide)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: b.dataset.to === '1' }),
      });
      await refreshCharacters();
      renderCharacterList(onChange);
      onChange?.();
    })
  );
  el.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = state.characters.find((x) => x.id === b.dataset.remove);
      if (!confirm(`Stop tracking ${c?.name} (${c?.classLabel})?`)) return;
      await fetch(`/api/characters/${encodeURIComponent(b.dataset.remove)}`, { method: 'DELETE' });
      await refreshCharacters();
      renderCharacterList(onChange);
      onChange?.();
    })
  );
}

// --- import from the Warcraft Logs profile ------------------------------------

/**
 * Ask Warcraft Logs which characters are ours. Characters it declines to import
 * (a healer-only alt, a spec with no logs this zone) come back in `skipped` with
 * a reason — folded away rather than spelled out inline, because on a big account
 * the skip list is longer than the roster, but a silently missing character reads
 * as a bug.
 */
async function importCharacters(onChange) {
  const btn = $('#import-chars');
  const status = $('#import-status');
  state.zone = Number($('#import-zone').value.trim()) || state.zone;
  btn.disabled = true;
  status.className = 'muted';
  status.textContent = 'Asking Warcraft Logs which characters are yours…';
  try {
    const res = await fetch('/api/characters/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: state.zone }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    await refreshCharacters();
    renderCharacterList(onChange);
    onChange?.();

    const skipped = body.skipped ?? [];
    const after = $('#import-status');
    after.className = 'import-result';
    after.innerHTML =
      `<span class="import-done">Imported ${body.imported}${
        skipped.length ? ` <span class="muted">· ${skipped.length} skipped</span>` : ''
      }</span>` +
      (skipped.length
        ? `<details class="skipped"><summary>Show skipped</summary><ul>${skipped
            .map(
              (s) =>
                `<li>${esc(s.name)}${s.server ? ` <span class="muted">(${esc(s.server)})</span>` : ''}: ${esc(s.reason)}</li>`
            )
            .join('')}</ul></details>`
        : '');
  } catch (err) {
    status.className = 'error';
    status.textContent = err.message;
  } finally {
    const b = $('#import-chars');
    if (b) b.disabled = false;
  }
}
