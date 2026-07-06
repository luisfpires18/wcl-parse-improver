const $ = (sel) => document.querySelector(sel);

let currentOverview = null;

$('#char-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadOverview();
});

function charQuery() {
  return new URLSearchParams({
    name: $('#f-name').value.trim(),
    server: $('#f-server').value.trim(),
    region: $('#f-region').value.trim(),
    zone: $('#f-zone').value.trim(),
  });
}

function setStatus(html) {
  $('#status').innerHTML = html;
}

// WCL-style parse colors
function pctClass(v) {
  if (typeof v !== 'number') return '';
  if (v >= 99) return 'p-pink';
  if (v >= 95) return 'p-orange';
  if (v >= 75) return 'p-purple';
  if (v >= 50) return 'p-blue';
  if (v >= 25) return 'p-green';
  return 'p-gray';
}

const fmtPct = (v) => (typeof v === 'number' ? v.toFixed(1) : '—');
const fmtTime = (ms) => {
  if (typeof ms !== 'number' || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtK = (v) => (typeof v === 'number' ? (v / 1000).toFixed(1) + 'k' : '—');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadOverview() {
  setStatus('Loading overview…');
  $('#overview').innerHTML = '';
  $('#report').innerHTML = '';
  try {
    const res = await fetch(`/api/overview?${charQuery()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentOverview = data;
    renderOverview(data);
    setStatus('');
  } catch (err) {
    setStatus(`<span class="error">Error: ${esc(err.message)}</span>`);
  }
}

function renderOverview({ character, overall, dungeons }) {
  const rows = dungeons
    .map(
      (d) => `<tr data-encounter="${d.encounterID}" class="clickable">
        <td>${esc(d.name)}</td>
        <td class="num">${d.keyLevel ?? '—'}</td>
        <td class="num">${fmtTime(d.durationMs)}</td>
        <td class="num">${d.runs ?? '—'}</td>
        <td class="num">${typeof d.points === 'number' ? Math.floor(d.points) : '—'}</td>
        <td class="num ${pctClass(d.bestPercent)}">${fmtPct(d.bestPercent)}</td>
        <td class="num ${pctClass(d.medianPercent)}">${fmtPct(d.medianPercent)}</td>
        <td class="num">${fmtK(d.bestDps)}</td>
        <td><button class="mini" data-analyze="${d.encounterID}">analyze</button></td>
      </tr>`
    )
    .join('');

  $('#overview').innerHTML = `
    <div class="card">
      <h2>${esc(character)}</h2>
      <p>Best avg: <b class="${pctClass(overall.bestPerformanceAverage)}">${fmtPct(overall.bestPerformanceAverage)}</b> ·
         Median avg: <b class="${pctClass(overall.medianPerformanceAverage)}">${fmtPct(overall.medianPerformanceAverage)}</b>
         <small>(parse percentiles at the shown key level — matches the WCL site)</small>
         <button id="worst" class="mini accent">analyze my worst parse</button></p>
      <table>
        <thead><tr>
          <th>Dungeon</th><th>Level</th><th>Time</th><th>Runs</th><th>Points</th>
          <th>Best %</th><th>Median %</th><th>Best DPS</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  $('#overview tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-analyze]');
    const tr = e.target.closest('tr[data-encounter]');
    const id = btn?.dataset.analyze ?? tr?.dataset.encounter;
    if (id) loadReport(Number(id), 0);
  });
  $('#worst').addEventListener('click', () => {
    const ranked = [...dungeons]
      .filter((d) => typeof d.bestPercent === 'number')
      .sort((a, b) => a.bestPercent - b.bestPercent);
    if (ranked.length) loadReport(ranked[0].encounterID, 0);
  });
}

async function loadReport(encounterID, offset) {
  const dungeon = currentOverview?.dungeons.find((d) => d.encounterID === encounterID);
  setStatus(
    `Building report for <b>${esc(dungeon?.name ?? encounterID)}</b>… ` +
      `<small>first fetch pulls ~6 reports from WCL and takes up to a minute; cached afterwards</small>`
  );
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('offset', offset);
    const res = await fetch(`/api/report?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderReport(encounterID, offset, data);
    setStatus('');
    $('#report').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    setStatus(`<span class="error">Report failed: ${esc(err.message)}</span>`);
  }
}

function renderReport(encounterID, offset, r) {
  const h = r.headline;
  const offsetBtns = [0, 1, 2]
    .map(
      (o) =>
        `<button class="mini ${o === offset ? 'accent' : ''}" data-offset="${o}">+${h.myKeyLevel + o}${o === 0 ? ' (my level)' : ''}</button>`
    )
    .join(' ');

  const gapRows = r.gaps
    .map(
      (g) => `<li class="gap">
        <div class="gap-head">
          <span class="sev">${g.severity}</span>
          <b>${esc(g.title)}</b>
          <span class="vals">mine <b>${esc(String(g.mine))}</b>${g.unit ? ' ' + esc(g.unit) : ''}
            · cohort <b>${esc(String(g.cohort))}</b>${g.unit ? ' ' + esc(g.unit) : ''}
            ${g.rawMine != null ? `· raw ${esc(String(g.rawMine))}% vs ${esc(String(g.rawCohort))}%` : ''}</span>
        </div>
        <div class="gap-advice">${esc(g.advice)}</div>
      </li>`
    )
    .join('');

  const cpmRows = r.tables.cpm
    .slice(0, 25)
    .map(
      (a) => `<tr><td>${esc(a.name)}</td><td class="num">${a.myCasts}</td><td class="num">${a.myCpm}</td>
        <td class="num">${a.cohortCpm}</td><td class="num">${a.damageSharePct}%</td></tr>`
    )
    .join('');

  const uptimeRows = r.tables.uptimes
    .slice(0, 30)
    .map(
      (u) => `<tr><td>${esc(u.name)}</td><td class="num">${u.minePct}%</td>
        <td class="num">${u.mineActivePct}%</td>
        <td class="num">${u.cohortPct}%</td>
        <td class="num">${u.cohortActivePct}%</td>
        <td class="num">${u.diffPp}</td></tr>`
    )
    .join('');

  const downtimeNoteRows = (r.downtimeNotes ?? [])
    .map(
      (n) => `<tr><td>${esc(n.name)}</td><td class="num">${n.mineRaw}% → ${n.mineActive}%</td>
        <td class="num">${n.cohortRaw}% → ${n.cohortActive}%</td></tr>`
    )
    .join('');

  const downtimeRows = (r.tables.downtime.windows ?? [])
    .map((w) => `<tr><td>${fmtTime(w.startRelMs)}</td><td class="num">${(w.durMs / 1000).toFixed(1)}s</td></tr>`)
    .join('');

  const compRows = (r.compNotes ?? [])
    .map((n) => `<tr><td>${esc(n.name)}</td><td class="num">${n.cohortPct}%</td></tr>`)
    .join('');

  $('#report').innerHTML = `
    <div class="card">
      <h2>${esc(h.dungeon)} +${h.myKeyLevel} — <span class="${pctClass(h.myBestPercent)}">${h.myBestPercent}%</span> parse</h2>
      <p>
        <b>${fmtK(h.myDps)}</b> me &nbsp;vs&nbsp; <b>${fmtK(h.cohortMedianDps)}</b> top-${h.cohortSize} median at +${h.cohortLevel}
        &nbsp;→&nbsp; gap <b>${h.dpsGapPct}%</b>
        <br /><small>cohort: ${h.cohortNames.map(esc).join(', ')}</small>
      </p>
      <p>compare against: ${offsetBtns}</p>

      <h3>Biggest gaps first</h3>
      <ol class="gaps">${gapRows || '<li>No significant rotational gaps found.</li>'}</ol>

      <details><summary>Per-ability casts (mine vs cohort median)</summary>
        <table><thead><tr><th>Ability</th><th>My casts</th><th>My CPM</th><th>Cohort CPM</th><th>Their dmg share</th></tr></thead>
        <tbody>${cpmRows}</tbody></table>
      </details>
      <details><summary>Buff/debuff uptimes (raw + active-time)</summary>
        <table><thead><tr><th>Aura</th><th>Mine raw</th><th>Mine active</th><th>Cohort raw</th><th>Cohort active</th><th>Diff (pp)</th></tr></thead>
        <tbody>${uptimeRows}</tbody></table>
      </details>
      ${downtimeNoteRows ? `<details><summary>Uptime losses caused by downtime/deaths (already counted above)</summary>
        <table><thead><tr><th>Aura</th><th>Mine raw → active</th><th>Cohort raw → active</th></tr></thead>
        <tbody>${downtimeNoteRows}</tbody></table>
      </details>` : ''}
      <details><summary>My downtime windows (idle ${r.tables.downtime.idlePct ?? '—'}% vs cohort ${r.tables.downtime.cohortIdlePct ?? '—'}%)</summary>
        <table><thead><tr><th>At</th><th>Idle</th></tr></thead><tbody>${downtimeRows}</tbody></table>
      </details>
      ${compRows ? `<details><summary>Group comp / talent differences (not actionable)</summary>
        <table><thead><tr><th>Buff</th><th>Cohort uptime</th></tr></thead><tbody>${compRows}</tbody></table>
      </details>` : ''}

      <p class="honesty">DPS gap ${r.honesty.dpsGapPct}% — rotational metrics explain ~${r.honesty.explainedPct}% of it.<br />
      <small>${esc(r.honesty.note)}</small></p>
    </div>`;

  $('#report').querySelectorAll('[data-offset]').forEach((b) =>
    b.addEventListener('click', () => loadReport(encounterID, Number(b.dataset.offset)))
  );
}

loadOverview();
