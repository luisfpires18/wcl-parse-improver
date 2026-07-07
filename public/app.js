const $ = (sel) => document.querySelector(sel);
const DEFAULT_LEVEL = 20;
const LEVEL_CHOICES = [18, 19, 20, 21, 22, 23, 24, 25];

let currentOverview = null;
let guideLoaded = false;

$('#char-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadOverview();
});

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-link');
  if (!btn) return;
  document.querySelectorAll('.nav-link').forEach((b) => b.classList.toggle('active', b === btn));
  const view = btn.dataset.view;
  $('#view-character').hidden = view !== 'character';
  $('#view-guide').hidden = view !== 'guide';
  if (view === 'guide' && !guideLoaded) loadGuidePage();
});

async function loadGuidePage() {
  $('#view-guide').innerHTML = 'Loading…';
  try {
    const res = await fetch('/api/guide');
    const guide = await res.json();
    if (!res.ok) throw new Error(guide.error || `HTTP ${res.status}`);
    $('#view-guide').innerHTML = `<div class="card">${renderGuideSection(guide)}</div>`;
    guideLoaded = true;
  } catch (err) {
    $('#view-guide').innerHTML = `<span class="error">Failed to load guide: ${esc(err.message)}</span>`;
  }
}

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
    if (id) loadReport(Number(id), DEFAULT_LEVEL);
  });
  $('#worst').addEventListener('click', () => {
    const ranked = [...dungeons]
      .filter((d) => typeof d.bestPercent === 'number')
      .sort((a, b) => a.bestPercent - b.bestPercent);
    if (ranked.length) loadReport(ranked[0].encounterID, DEFAULT_LEVEL);
  });
}

// Cohort dropdown options persist across a compareTo refetch — a
// compareTo response only contains the one filtered player, so the
// dropdown would otherwise lose every other option after the first pick.
let lastCohortPlayers = null;

async function loadReport(encounterID, level, compareTo = '') {
  const dungeon = currentOverview?.dungeons.find((d) => d.encounterID === encounterID);
  setStatus(
    `Building report for <b>${esc(dungeon?.name ?? encounterID)}</b> at +${level}… ` +
      `<small>first fetch pulls several reports from WCL and takes up to a minute; cached afterwards</small>`
  );
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('level', level);
    if (compareTo) params.set('compareTo', compareTo);
    const res = await fetch(`/api/report?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!compareTo) lastCohortPlayers = data.headline.cohortPlayers;
    renderReport(encounterID, level, compareTo, data);
    setStatus('');
    $('#report').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    setStatus(`<span class="error">Report failed: ${esc(err.message)}</span>`);
  }
}

// Rotation timeline: SVG event-plot. Lanes are picked server-side purely by
// cast frequency (see server/analysis/timeline.js) — never by ability name —
// so this keeps working across ability reworks.
const LEFT_LABEL_W = 132;
const PLOT_W = 700;
const ROW_H = 20;
const RIGHT_PAD = 8;

function seriesColor(i) {
  return `var(--series-${(i % 8) + 1})`;
}

function timelineSvg(run, laneNames) {
  const rows = laneNames.length + 2; // idle, deaths, + lanes
  const topPad = 4;
  const axisH = 20;
  const height = topPad + rows * ROW_H + axisH;
  const width = LEFT_LABEL_W + PLOT_W + RIGHT_PAD;
  const dur = Math.max(1, run.durationMs);
  const x = (ms) => LEFT_LABEL_W + (Math.min(Math.max(ms, 0), dur) / dur) * PLOT_W;
  const rowY = (i) => topPad + i * ROW_H;

  const parts = [];

  // row label helper (direct label + identity swatch, no separate legend box)
  const label = (i, text, color) =>
    `<g>
      <rect x="${LEFT_LABEL_W - 122}" y="${rowY(i) + ROW_H / 2 - 4}" width="8" height="8" rx="2" fill="${color}"></rect>
      <text x="${LEFT_LABEL_W - 110}" y="${rowY(i) + ROW_H / 2 + 3.5}" font-size="10" fill="var(--muted)">${esc(text)}</text>
    </g>`;

  // idle row
  parts.push(label(0, 'Idle', 'var(--viz-warning)'));
  for (const w of run.idleWindows) {
    const x1 = x(w.startMs);
    const x2 = x(w.startMs + w.durMs);
    parts.push(
      `<rect class="timeline-tick" x="${x1}" y="${rowY(0) + 3}" width="${Math.max(1.5, x2 - x1)}" height="${ROW_H - 6}" rx="3" fill="var(--viz-warning)"><title>Idle ${(w.durMs / 1000).toFixed(1)}s at ${fmtTime(w.startMs)}</title></rect>`
    );
  }

  // deaths row
  parts.push(label(1, 'Deaths', 'var(--viz-critical)'));
  for (const d of run.deaths) {
    parts.push(
      `<circle class="timeline-tick" cx="${x(d.atMs)}" cy="${rowY(1) + ROW_H / 2}" r="5" fill="var(--viz-critical)" stroke="var(--panel)" stroke-width="2"><title>Death at ${fmtTime(d.atMs)}</title></circle>`
    );
  }

  // cooldown lanes
  run.lanes.forEach((lane, li) => {
    const i = li + 2;
    const color = seriesColor(li);
    parts.push(label(i, lane.name, color));
    for (const ts of lane.casts) {
      parts.push(
        `<line class="timeline-tick" x1="${x(ts)}" x2="${x(ts)}" y1="${rowY(i) + 3}" y2="${rowY(i) + ROW_H - 3}" stroke="${color}" stroke-width="2" stroke-linecap="round"><title>${esc(lane.name)} at ${fmtTime(ts)}</title></line>`
      );
    }
  });

  // x-axis
  const axisY = topPad + rows * ROW_H + 4;
  parts.push(`<line x1="${LEFT_LABEL_W}" x2="${LEFT_LABEL_W + PLOT_W}" y1="${axisY}" y2="${axisY}" stroke="var(--border)" stroke-width="1"></line>`);
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const tx = LEFT_LABEL_W + frac * PLOT_W;
    parts.push(
      `<text x="${tx}" y="${axisY + 12}" font-size="9" fill="var(--muted)" text-anchor="${frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle'}">${fmtTime(frac * dur)}</text>`
    );
  }

  return `<svg class="timeline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">${parts.join('')}</svg>`;
}

function renderTimelineSection(timeline, timelineInfo) {
  if (!timeline || !timeline.laneNames.length) return '';
  const { laneNames, mine, other, otherRoleLabel } = timeline;
  return `
    <h3>Rotation timeline</h3>
    <p class="timeline-sub"><small>Ticks = individual casts. Only cooldown-gated abilities get a lane (fillers like Scourge Strike/Death Coil are already in the CPM table below). The two runs have different durations — each has its own time axis.</small></p>
    <div class="timeline-wrap">
      <div class="timeline-sub">You &middot; duration ${fmtTime(mine.durationMs)}</div>
      ${timelineSvg(mine, laneNames)}
      <div class="timeline-sub">${esc(other.label)}${otherRoleLabel ? ` (${esc(otherRoleLabel)})` : ''} &middot; duration ${fmtTime(other.durationMs)}</div>
      ${timelineSvg(other, laneNames)}
    </div>
    ${timelineInfo ? `<p class="timeline-info"><b>Info:</b> ${esc(timelineInfo.text)}</p>` : ''}`;
}

function renderGuideSection(guide) {
  if (!guide) return '';
  const { meta, opener, priority, breakpoints, cooldowns, mechanicNotes } = guide;
  const list = (items) => `<ol>${items.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  const bpRows = breakpoints
    .map((b) => `<tr><td>${esc(b.targets)}</td><td>${esc(b.rule)}</td><td>${esc(b.detail)}</td></tr>`)
    .join('');
  const notes = (mechanicNotes ?? [])
    .map(
      (n) =>
        `<li><b>${n.abilities.map(esc).join(' / ')}:</b> ${esc(n.note)} <small>(source: ${esc(n.source)})</small></li>`
    )
    .join('');

  return `
    <div class="guide-ref">
      <h3>Rotation guide <small>(external reference — not measured from your logs)</small></h3>
      <p class="table-note"><small>Fetched live from ${esc(meta.sourceName)} on ${esc(meta.fetchedAt)}
        (patch ${esc(meta.patch)}): <a href="${esc(meta.sourceUrl)}" target="_blank" rel="noopener">${esc(meta.sourceUrl)}</a>.
        This is opinion, kept separate from the data-driven gaps above — it never affects severity/ranking, it's here to help read the timeline.</small></p>

      <div class="guide-grid">
        <div>
          <h4>Opener &mdash; single target</h4>
          ${list(opener.singleTarget)}
        </div>
        <div>
          <h4>Opener &mdash; multi target</h4>
          ${list(opener.multiTarget)}
        </div>
      </div>
      <div class="guide-grid">
        <div>
          <h4>Priority &mdash; single target</h4>
          ${list(priority.singleTarget)}
        </div>
        <div>
          <h4>Priority &mdash; multi target</h4>
          ${list(priority.multiTarget)}
        </div>
      </div>

      <h4>Target-count breakpoints</h4>
      <table><thead><tr><th>Targets</th><th>Use</th><th>Detail</th></tr></thead><tbody>${bpRows}</tbody></table>

      <h4>Cooldowns</h4>
      <ul>
        <li>${esc(cooldowns.generalNote)}</li>
        <li>${esc(cooldowns.darkTransformationNote)}</li>
        <li>${esc(cooldowns.trinketNote)}</li>
      </ul>

      ${notes ? `<h4>Mechanic notes</h4><ul class="comp-notes">${notes}</ul>` : ''}
    </div>`;
}

function renderParsePlan(plan) {
  if (!plan) return '';
  const chips = (plan.tiers ?? [])
    .map((t) => {
      const sign = t.dpsDelta >= 0 ? '+' : '';
      return `<span class="tier-chip p-${t.tier}">${t.tier} ${t.threshold}%+<br><small>${sign}${t.pctDeltaNeeded}% DPS</small></span>`;
    })
    .join('');
  return `
    <div class="parse-plan">
      <h3>Path to your next parse color</h3>
      ${chips ? `<div class="tier-chips">${chips}</div>` : ''}
      <p class="parse-plan-text">${esc(plan.text)}</p>
    </div>`;
}

function renderNextSteps(headline, nextSteps) {
  if (!nextSteps) return '';
  const items = nextSteps.actions.map((a) => `<li>${esc(a)}</li>`).join('');
  return `
    <div class="next-steps">
      <h3>What to do next time at +${headline.myKeyLevel}</h3>
      <p class="next-steps-recap">${esc(nextSteps.recap)}</p>
      <ol>${items}</ol>
    </div>`;
}

function renderReport(encounterID, level, compareTo, r) {
  const h = r.headline;
  const levelBtns = LEVEL_CHOICES.map(
    (lvl) =>
      `<button class="mini ${lvl === level ? 'accent' : ''}" data-level="${lvl}">+${lvl}${lvl === DEFAULT_LEVEL ? ' (default)' : ''}</button>`
  ).join(' ');

  const players = lastCohortPlayers ?? h.cohortPlayers;
  const playerOptions = players
    .map((p) => {
      const display = p.label ? `${p.name} (${p.label}, +${p.keyLevel})` : `${p.name} (+${p.keyLevel})`;
      return `<option value="${esc(p.name)}" ${p.name === compareTo ? 'selected' : ''}>${esc(display)}</option>`;
    })
    .join('');
  const compareSelect = `
    <select id="compare-to" class="mini">
      <option value="">All ${players.length} (median)</option>
      ${playerOptions}
    </select>`;

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
        <td class="num">${a.cohortCasts}</td><td class="num">${a.cohortCpm}</td><td class="num">${a.damageSharePct}%</td></tr>`
    )
    .join('');

  const uptimeRows = r.tables.uptimes
    .slice(0, 30)
    .map(
      (u) => `<tr><td>${esc(u.name)}</td><td class="num">${u.minePct}%</td>
        <td class="num">${u.mineActivePct}%</td>
        <td class="num">${u.myUses}</td>
        <td class="num">${u.cohortPct}%</td>
        <td class="num">${u.cohortActivePct}%</td>
        <td class="num">${u.cohortUses}</td>
        <td class="num">${u.diffPp}</td></tr>`
    )
    .join('');

  const deathRows = (r.tables.deaths.cohortByPlayer ?? [])
    .map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.deaths}</td></tr>`)
    .join('');

  const s = r.tables.spender;
  const spenderRows = `
    <tr><td>Death Coil casts</td><td class="num">${s.mine.deathCoil}</td><td class="num">${s.cohortDeathCoilCasts ?? '—'}</td></tr>
    <tr><td>Epidemic casts</td><td class="num">${s.mine.epidemic}</td><td class="num">${s.cohortEpidemicCasts ?? '—'}</td></tr>
    <tr><td>Epidemic share</td><td class="num">${s.mine.epidemicShare != null ? Math.round(100 * s.mine.epidemicShare) + '%' : '—'}</td>
        <td class="num">${s.cohortEpidemicShare != null ? Math.round(100 * s.cohortEpidemicShare) + '%' : '—'}</td></tr>`;

  const w = r.tables.rpWaste;
  const wasteRows = `
    <tr><td>RP generated</td><td class="num">${Math.round(w.mine.netGain)}</td><td class="num">${w.cohortNetGain ?? '—'}</td></tr>
    <tr><td>RP wasted (overcapped)</td><td class="num">${Math.round(w.mine.waste)}</td><td class="num">${w.cohortWasteAmount ?? '—'}</td></tr>
    <tr><td>Waste %</td><td class="num">${w.mine.wastePct != null ? w.mine.wastePct.toFixed(1) + '%' : '—'}</td>
        <td class="num">${w.cohortWastePct != null ? w.cohortWastePct + '%' : '—'}</td></tr>`;

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
    .map(
      (n) => `<tr><td>${esc(n.name)}${n.external ? ' <small>(verified external)</small>' : ''}</td>
        <td class="num">${n.minePct ?? 0}%</td><td class="num">${n.cohortPct}%</td></tr>`
    )
    .join('');
  const compNotesText = (r.compNotes ?? []).map((n) => n.note).filter(Boolean);

  $('#report').innerHTML = `
    <div class="card">
      <h2>${esc(h.dungeon)} +${h.myKeyLevel}${h.myKeyLevel !== h.requestedLevel ? ` <small>(closest to requested +${h.requestedLevel})</small>` : ''} — <span class="${pctClass(h.myBestPercent)}">${h.myBestPercent}%</span> parse</h2>
      <p>
        <b>${fmtK(h.myDps)}</b> me &nbsp;vs&nbsp; <b>${fmtK(h.cohortMedianDps)}</b> ${compareTo ? 'them' : `median of ${h.cohortSize}`} at +${h.cohortLevel}
        &nbsp;→&nbsp; gap <b>${h.dpsGapPct}%</b>
        <br /><small>compared against: ${h.cohortNames.map(esc).join(', ')}</small>
      </p>
      <p>compare at level: ${levelBtns}</p>
      <p>focus comparison on: ${compareSelect}</p>

      <h3>Biggest gaps first</h3>
      <ol class="gaps">${gapRows || '<li>No significant rotational gaps found.</li>'}</ol>

      ${renderParsePlan(r.parsePlan)}

      ${renderTimelineSection(r.timeline, r.timelineInfo)}

      ${r.summary ? `<p class="summary">${esc(r.summary.text)}</p>` : ''}

      <details><summary>Per-ability casts (mine vs cohort median)</summary>
        <table><thead><tr><th>Ability</th><th>My casts</th><th>My CPM</th><th>Cohort casts</th><th>Cohort CPM</th><th>Their dmg share</th></tr></thead>
        <tbody>${cpmRows}</tbody></table>
        <p class="table-note"><small>CPM = casts per minute. Runs differ in length, so raw counts alone aren't comparable across players — CPM normalizes for that; casts is the actual count for reference.</small></p>
      </details>
      <details><summary>Buff/debuff uptimes (raw + active-time, mine vs cohort median)</summary>
        <table><thead><tr><th>Aura</th><th>Mine raw</th><th>Mine active</th><th>My uses</th><th>Cohort raw</th><th>Cohort active</th><th>Cohort uses</th><th>Diff (pp)</th></tr></thead>
        <tbody>${uptimeRows}</tbody></table>
      </details>
      <details><summary>Deaths by cohort player (mine: ${r.tables.deaths.mine.length})</summary>
        <table><thead><tr><th>Player</th><th>Deaths</th></tr></thead>
        <tbody><tr><td>You</td><td class="num">${r.tables.deaths.mine.length}</td></tr>${deathRows}</tbody></table>
      </details>
      <details><summary>RP spender mix &amp; waste (mine vs cohort median)</summary>
        <table><thead><tr><th>Metric</th><th>Mine</th><th>Cohort median</th></tr></thead>
        <tbody>${spenderRows}${wasteRows}</tbody></table>
      </details>
      ${downtimeNoteRows ? `<details><summary>Uptime losses caused by downtime/deaths (already counted above)</summary>
        <table><thead><tr><th>Aura</th><th>Mine raw → active</th><th>Cohort raw → active</th></tr></thead>
        <tbody>${downtimeNoteRows}</tbody></table>
      </details>` : ''}
      <details><summary>My downtime windows (idle ${r.tables.downtime.idlePct ?? '—'}% vs cohort ${r.tables.downtime.cohortIdlePct ?? '—'}%)</summary>
        <table><thead><tr><th>At</th><th>Idle</th></tr></thead><tbody>${downtimeRows}</tbody></table>
      </details>
      ${compRows ? `<details><summary>Group comp / talent differences (not actionable)</summary>
        <table><thead><tr><th>Buff</th><th>Mine</th><th>Cohort</th></tr></thead><tbody>${compRows}</tbody></table>
        <ul class="comp-notes">${compNotesText.map((t) => `<li><small>${esc(t)}</small></li>`).join('')}</ul>
      </details>` : ''}

      <p class="honesty">DPS gap ${r.honesty.dpsGapPct}% — rotational metrics explain ~${r.honesty.explainedPct}% of it.<br />
      <small>${esc(r.honesty.note)}</small></p>

      ${renderNextSteps(h, r.summary?.nextSteps)}
    </div>`;

  $('#report').querySelectorAll('[data-level]').forEach((b) =>
    b.addEventListener('click', () => loadReport(encounterID, Number(b.dataset.level), compareTo))
  );
  $('#compare-to').addEventListener('change', (e) => loadReport(encounterID, level, e.target.value));
}

loadOverview();
