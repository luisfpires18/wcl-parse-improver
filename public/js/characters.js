// Characters: the roster (add / hide / remove) and the active-character bar shown
// on the two analysis views.
//
// `hidden` keeps a character tracked but out of the analysis picker — for alts you
// want to keep without cluttering the list.
import { $, esc } from './util.js';
import { state, setStatus } from './state.js';

/** Characters offered in the analysis views: everything not hidden. */
export const visibleCharacters = () => state.characters.filter((c) => !c.hidden);

export async function refreshCharacters() {
  try {
    state.characters = await (await fetch('/api/characters')).json();
  } catch {
    state.characters = [];
  }
  // keep the active character valid
  if (!state.activeChar || !visibleCharacters().some((c) => c.id === state.activeChar.id)) {
    setActiveCharacter(visibleCharacters()[0] ?? null);
  }
}

export function setActiveCharacter(c) {
  state.activeChar = c;
  state.activeSpec = c?.specs?.[0]?.slug ?? null;
}

// --- the bar on the analysis views ------------------------------------------

export function renderCharBar(onChange) {
  const bar = $('#char-bar');
  if (!bar) return;
  const chars = visibleCharacters();
  if (!chars.length) {
    bar.innerHTML = `<div class="char-bar"><span class="muted">No characters yet — add one on the Characters tab.</span></div>`;
    return;
  }
  const c = state.activeChar;
  const charOpts = chars
    .map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)} — ${esc(x.classLabel)}</option>`)
    .join('');
  const specOpts = (c.specs ?? [])
    .map((s) => `<option value="${esc(s.slug)}" ${s.slug === state.activeSpec ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');

  bar.innerHTML = `
    <div class="char-bar">
      <label class="spec-pick">character <select id="f-char">${charOpts}</select></label>
      <label class="spec-pick">spec <select id="f-spec">${specOpts}</select></label>
      <span class="muted">${esc(c.server)} (${esc(c.region)})</span>
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

export function renderCharacterList(onChange) {
  const el = $('#char-list');
  if (!el) return;
  const rows = state.characters
    .map(
      (c) => `<tr class="${c.hidden ? 'unanalysed' : ''}">
        <td><b>${esc(c.name)}</b></td>
        <td>${esc(c.classLabel)}</td>
        <td>${esc(c.server)} <small class="muted">(${esc(c.region)})</small></td>
        <td>${(c.specs ?? []).map((s) => esc(s.name)).join(', ')}</td>
        <td>${c.hidden ? '<span class="muted">hidden</span>' : '<span class="p-green">shown</span>'}</td>
        <td>
          <button class="mini" data-hide="${esc(c.id)}" data-to="${c.hidden ? '0' : '1'}">${c.hidden ? 'Show' : 'Hide'}</button>
          <button class="mini danger" data-remove="${esc(c.id)}">Remove</button>
        </td>
      </tr>`
    )
    .join('');

  el.innerHTML = `
    <div class="card">
      <h2>Characters</h2>
      ${
        rows
          ? `<table>
               <thead><tr><th>Name</th><th>Class</th><th>Server</th><th>Specs</th><th>In analysis</th><th></th></tr></thead>
               <tbody>${rows}</tbody>
             </table>
             <p class="table-note"><small><b>Hide</b> keeps a character tracked but takes it out of the M+ and Raid pickers.</small></p>`
          : '<p class="muted">No characters yet. Add one below.</p>'
      }
    </div>`;

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

// --- add character ------------------------------------------------------------

let detected = null;

export function initAddCharacter(onChange) {
  $('#detect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    detected = null;
    $('#detect-result').innerHTML = '';
    $('#detect-status').innerHTML = 'Detecting class from Warcraft Logs…';
    const params = new URLSearchParams({
      name: $('#a-name').value.trim(),
      server: $('#a-server').value.trim(),
      region: $('#a-region').value.trim(),
      zone: $('#a-zone').value.trim(),
    });
    try {
      const res = await fetch(`/api/character?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      detected = body;
      $('#detect-status').innerHTML = '';
      renderDetected(body, onChange);
    } catch (err) {
      $('#detect-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    }
  });
}

function renderDetected(d, onChange) {
  const rows = d.specs
    .map((s) => {
      const dps = s.role === 'DPS';
      const note = dps
        ? s.hasLogs
          ? `<small class="ok">has logged runs</small>`
          : `<small class="muted">no runs in this zone</small>`
        : `<small class="muted">${esc(s.role.toLowerCase())} — DPS analysis only</small>`;
      return `<label class="spec-row ${dps ? '' : 'disabled'}">
        <input type="checkbox" value="${esc(s.slug)}" ${dps ? '' : 'disabled'} ${dps && s.hasLogs ? 'checked' : ''} />
        <span>${esc(s.name)}</span> ${note}
      </label>`;
    })
    .join('');
  $('#detect-result').innerHTML = `
    <div class="detected">
      <h3>${esc(d.classLabel)} <small>— auto-detected for ${esc(d.name)}</small></h3>
      <div class="spec-list">${rows}</div>
      <button id="save-char">Add character</button>
      <span id="save-status"></span>
    </div>`;
  $('#save-char').addEventListener('click', () => saveDetected(onChange));
}

async function saveDetected(onChange) {
  const specs = [...document.querySelectorAll('#detect-result input[type=checkbox]:checked')].map((i) => i.value);
  if (!specs.length) {
    $('#save-status').innerHTML = `<span class="error">Pick at least one spec.</span>`;
    return;
  }
  $('#save-status').textContent = 'Saving…';
  try {
    const res = await fetch('/api/characters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: detected.name,
        server: $('#a-server').value.trim(),
        region: $('#a-region').value.trim(),
        zone: Number($('#a-zone').value.trim()),
        className: detected.className,
        specs,
      }),
    });
    const saved = await res.json();
    if (!res.ok) throw new Error(saved.error || `HTTP ${res.status}`);
    await refreshCharacters();
    setActiveCharacter(state.characters.find((c) => c.id === saved.id) ?? state.activeChar);
    $('#detect-result').innerHTML = '';
    $('#detect-form').reset();
    renderCharacterList(onChange);
    onChange?.();
    setStatus('');
  } catch (err) {
    $('#save-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}
