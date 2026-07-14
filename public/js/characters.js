// Tracked characters: the nav tabs, the character header, and the add-character
// flow. Owns every mutation of `state.activeChar` / `state.activeSpec`.
import { $, esc } from './util.js';
import { state, setStatus } from './state.js';
import { loadOverview } from './mplus.js';
import { renderRaidCard } from './raid.js';

export function renderNav() {
  const tabs = state.characters
    .map(
      (c) =>
        `<button type="button" class="nav-link ${c.id === state.activeChar?.id ? 'active' : ''}" data-char="${esc(c.id)}">
          ${esc(c.name)} <small>&middot; ${esc(c.classLabel)}</small>
        </button>`
    )
    .join('');
  $('#nav').innerHTML = `${tabs}<button type="button" class="nav-link nav-add" data-view="add">＋ Add character</button>`;
}

export function selectCharacter(id) {
  const c = state.characters.find((x) => x.id === id);
  if (!c) return;
  state.activeChar = c;
  state.activeSpec = c.specs[0]?.slug ?? null;
  $('#view-add').hidden = true;
  $('#view-character').hidden = false;
  renderNav();
  renderCharBar();
  renderRaidCard();
  loadOverview();
}

// Character header: who, where, spec picker, refresh, remove. The name/server
// are display-only — editing them freely would desync `className` from the
// character and silently pull another class's cohort.
function renderCharBar() {
  const c = state.activeChar;
  const specOpts = c.specs
    .map((s) => `<option value="${esc(s.slug)}" ${s.slug === state.activeSpec ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  $('#char-bar').innerHTML = `
    <div class="char-bar">
      <b>${esc(c.name)}</b>
      <span class="muted">${esc(c.classLabel)} &middot; ${esc(c.server)} (${esc(c.region)}) &middot; zone ${esc(String(c.zone))}</span>
      <label class="spec-pick">spec <select id="f-spec">${specOpts}</select></label>
      <button id="reload" class="mini">Load</button>
      <button id="remove-char" class="mini danger" title="Stop tracking this character">Remove</button>
    </div>`;
  $('#f-spec').addEventListener('change', (e) => {
    state.activeSpec = e.target.value;
    loadOverview();
  });
  $('#reload').addEventListener('click', () => loadOverview());
  $('#remove-char').addEventListener('click', () => removeCharacter(c));
}

async function removeCharacter(c) {
  if (!confirm(`Stop tracking ${c.name} (${c.classLabel})?`)) return;
  try {
    const res = await fetch(`/api/characters/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.characters = body;
    if (state.characters.length) selectCharacter(state.characters[0].id);
    else {
      state.activeChar = null;
      renderNav();
      showAddCharacter();
    }
  } catch (err) {
    setStatus(`<span class="error">Could not remove: ${esc(err.message)}</span>`);
  }
}

// --- add character ---------------------------------------------------------

let detected = null; // last /api/character result

export function showAddCharacter() {
  $('#view-character').hidden = true;
  $('#view-add').hidden = false;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.view === 'add'));
}

/** Wire the nav and the detect form. Called once, at boot. */
export function initCharacterUI() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-link');
    if (!btn) return;
    if (btn.dataset.view === 'add') showAddCharacter();
    else if (btn.dataset.char) selectCharacter(btn.dataset.char);
  });

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
      renderDetected(body);
    } catch (err) {
      $('#detect-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
    }
  });
}

function renderDetected(d) {
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
  $('#save-char').addEventListener('click', saveDetected);
}

async function saveDetected() {
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
    state.characters = await (await fetch('/api/characters')).json();
    $('#detect-result').innerHTML = '';
    $('#detect-form').reset();
    selectCharacter(saved.id);
  } catch (err) {
    $('#save-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}
