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
// Positive gap = behind; negative = ahead of the comparison.
const gapPhrase = (v) => {
  if (typeof v !== 'number') return 'gap —';
  if (v > 0) return `gap <b>${v}%</b>`;
  if (v < 0) return `ahead by <b>${Math.abs(v)}%</b>`;
  return `dead even`;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadOverview(refresh = false) {
  setStatus(refresh ? 'Refreshing from Warcraft Logs (bypassing cache)…' : 'Loading overview…');
  $('#overview').innerHTML = '';
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/overview?${params}`);
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
      <h2>${esc(character)}
        <button id="refresh-overview" class="mini" title="Re-fetch from Warcraft Logs, bypassing the local cache — use after logging new runs">↻ Refresh data</button>
      </h2>
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

  // Default comparison level for a dungeon = the highest key level the
  // character has actually logged there (that's the run that gates invites),
  // not a fixed global. Falls back to DEFAULT_LEVEL if unknown.
  const defaultLevelFor = (encounterID) => {
    const d = dungeons.find((x) => x.encounterID === encounterID);
    return typeof d?.keyLevel === 'number' ? d.keyLevel : DEFAULT_LEVEL;
  };

  $('#overview tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-analyze]');
    const tr = e.target.closest('tr[data-encounter]');
    const id = btn?.dataset.analyze ?? tr?.dataset.encounter;
    if (id) loadReport(Number(id), defaultLevelFor(Number(id)));
  });
  $('#worst').addEventListener('click', () => {
    const ranked = [...dungeons]
      .filter((d) => typeof d.bestPercent === 'number')
      .sort((a, b) => a.bestPercent - b.bestPercent);
    if (ranked.length) loadReport(ranked[0].encounterID, defaultLevelFor(ranked[0].encounterID));
  });
  $('#refresh-overview').addEventListener('click', () => loadOverview(true));
}

// Cohort dropdown options persist across a compareTo refetch — a
// compareTo response only contains the one filtered player, so the
// dropdown would otherwise lose every other option after the first pick.
let lastCohortPlayers = null;
let lastSimilarPlayers = null;

async function loadReport(encounterID, level, compareTo = '', refresh = false) {
  const dungeon = currentOverview?.dungeons.find((d) => d.encounterID === encounterID);
  setStatus(
    `Building report for <b>${esc(dungeon?.name ?? encounterID)}</b> at +${level}… ` +
      (refresh
        ? `<small>refreshing rankings from WCL (bypassing cache)</small>`
        : `<small>first fetch pulls several reports from WCL and takes up to a minute; cached afterwards</small>`)
  );
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('level', level);
    if (compareTo) params.set('compareTo', compareTo);
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/report?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!compareTo) {
      lastCohortPlayers = data.headline.cohortPlayers;
      lastSimilarPlayers = data.headline.similarPlayers;
    }
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

// ---- DPS-over-time line chart (lazy-loaded from /api/dps-series) ----
const DPS_MINE_COLOR = 'var(--series-1)'; // blue = me
const DPS_OTHER_COLOR = 'var(--series-7)'; // magenta = them (WCL-like pink)
const CHART_L = 56; // left axis gutter
const CHART_R = 12;
const CHART_T = 24; // legend row
const CHART_B = 22; // x-axis
const CHART_W = 760;
const CHART_H = 260;

const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// interactivity state: the full cast-order lists + chart geometry, so brushing
// the chart can filter the cast order / composition to any time window.
let dpsState = null;
let dpsChartGeom = null;

function dpsChartSvg(mine, other) {
  const plotW = CHART_W - CHART_L - CHART_R;
  const plotH = CHART_H - CHART_T - CHART_B;
  const maxSec = Math.max(
    mine.points.at(-1)?.tSec ?? 0,
    other.points.at(-1)?.tSec ?? 0,
    mine.durationMs / 1000,
    other.durationMs / 1000
  );
  dpsChartGeom = { maxSec, x0: CHART_L, plotW, plotTop: CHART_T, plotH };
  const maxDps = Math.max(1, ...mine.points.map((p) => p.dps), ...other.points.map((p) => p.dps));
  const x = (sec) => CHART_L + (maxSec > 0 ? (sec / maxSec) * plotW : 0);
  const y = (dps) => CHART_T + plotH - (dps / maxDps) * plotH;
  const poly = (points, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${points
      .map((p) => `${x(p.tSec).toFixed(1)},${y(p.dps).toFixed(1)}`)
      .join(' ')}"></polyline>`;

  const parts = [];
  // y gridlines + labels (0, 25, 50, 75, 100% of max)
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const gy = CHART_T + plotH - frac * plotH;
    parts.push(`<line x1="${CHART_L}" x2="${CHART_L + plotW}" y1="${gy}" y2="${gy}" stroke="var(--border)" stroke-width="1" opacity="0.5"></line>`);
    parts.push(`<text x="${CHART_L - 6}" y="${gy + 3}" font-size="9" fill="var(--muted)" text-anchor="end">${fmtK(frac * maxDps)}</text>`);
  }
  // x ticks
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const tx = CHART_L + frac * plotW;
    parts.push(`<text x="${tx}" y="${CHART_T + plotH + 14}" font-size="9" fill="var(--muted)" text-anchor="${frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle'}">${fmtSec(frac * maxSec)}</text>`);
  }
  parts.push(poly(other.points, DPS_OTHER_COLOR)); // draw theirs under mine
  parts.push(poly(mine.points, DPS_MINE_COLOR));
  // legend (direct labels)
  const legend = (cx, color, text) =>
    `<line x1="${cx}" x2="${cx + 16}" y1="12" y2="12" stroke="${color}" stroke-width="2"></line>` +
    `<text x="${cx + 22}" y="15" font-size="10" fill="var(--text)">${esc(text)}</text>`;
  parts.push(legend(CHART_L, DPS_MINE_COLOR, `You (${fmtK(mine.totalDamage / (mine.durationMs / 1000))} avg)`));
  parts.push(legend(CHART_L + 180, DPS_OTHER_COLOR, `${other.label} (${fmtK(other.totalDamage / (other.durationMs / 1000))} avg)`));

  // brush selection band (updated during drag) + transparent overlay on top
  // to capture pointer events for selecting a time window
  parts.push(`<rect id="dps-brush" x="0" y="${CHART_T}" width="0" height="${plotH}" fill="var(--accent)" opacity="0.16" pointer-events="none"></rect>`);
  parts.push(`<rect id="dps-overlay" x="${CHART_L}" y="${CHART_T}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"></rect>`);

  return `<svg class="dps-chart-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMinYMin meet">${parts.join('')}</svg>`;
}

// --- brush: drag on the chart to pick a time window ---
function wireDpsBrush() {
  const svg = document.querySelector('.dps-chart-svg');
  const overlay = document.querySelector('#dps-overlay');
  const sel = document.querySelector('#dps-brush');
  if (!svg || !overlay || !sel || !dpsChartGeom) return;
  const g = dpsChartGeom;
  const toViewX = (clientX) => {
    const r = svg.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * CHART_W;
  };
  const toSec = (vx) => Math.max(0, Math.min(g.maxSec, ((vx - g.x0) / g.plotW) * g.maxSec));
  const secToX = (sec) => g.x0 + (sec / g.maxSec) * g.plotW;
  let x0 = null;
  const onMove = (e) => {
    if (x0 == null) return;
    const x1 = toViewX(e.clientX);
    sel.setAttribute('x', Math.min(x0, x1));
    sel.setAttribute('width', Math.abs(x1 - x0));
  };
  const onUp = (e) => {
    if (x0 == null) return;
    const x1 = toViewX(e.clientX);
    let a = toSec(Math.min(x0, x1));
    let b = toSec(Math.max(x0, x1));
    if (b - a < 4) {
      // treat a click as a ±20s window centred on it
      const c = toSec(x1);
      a = Math.max(0, c - 20);
      b = Math.min(g.maxSec, c + 20);
      sel.setAttribute('x', secToX(a));
      sel.setAttribute('width', secToX(b) - secToX(a));
    }
    x0 = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    setCastWindow(a, b);
  };
  overlay.addEventListener('mousedown', (e) => {
    x0 = toViewX(e.clientX);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}
function clearBrush() {
  const sel = document.querySelector('#dps-brush');
  if (sel) sel.setAttribute('width', 0);
}

function renderSpikeAnalysis(sa) {
  if (!sa || !sa.windows?.length) return '';
  const rows = sa.windows
    .map((s) => {
      const casts = (s.castDiffs ?? [])
        .map((d) => `<span class="cd ${d.diff > 0 ? 'behind' : ''}">${esc(d.name)} <b>${d.them}</b>/${d.mine}</span>`)
        .join(' ');
      const amps = s.theirAmps?.length ? `<div class="spike-amps"><small>amplifiers — them: ${s.theirAmps.map(esc).join(', ')}${s.myAmps?.length ? ` · you: ${s.myAmps.map(esc).join(', ')}` : ' · you: none'}</small></div>` : '';
      return `<li class="spike-row">
        <div class="spike-head"><b>${esc(s.atLabel)}</b> — them <b class="p-purple">${fmtK(s.theirDps)}</b> vs you <b class="p-blue">${fmtK(s.myDps)}</b>
          <span class="vals">(+${fmtK(s.gapDps)} their favor · ${s.theirCastTotal} vs your ${s.myCastTotal} damage casts)</span></div>
        ${amps}
        <div class="spike-casts"><small>damage casts (them/you): ${casts}</small></div>
        <div class="spike-note">${esc(s.note)}</div>
      </li>`;
    })
    .join('');
  return `
    <div class="spike-analysis">
      <h4>Why their spikes are higher <small>— same rotation, where the damage goes</small></h4>
      <p class="spike-headline">${esc(sa.headline)}</p>
      ${sa.openerNote ? `<p class="spike-opener"><b>Opener:</b> ${esc(sa.openerNote)}</p>` : ''}
      <div id="rotation-dyn"></div>
      <ol class="spikes">${rows}</ol>
    </div>`;
}

/** Filter the full cast-order lists to a time window and render columns + composition. */
function setCastWindow(loSec, hiSec) {
  const el = document.querySelector('#rotation-dyn');
  if (!el || !dpsState) return;
  const inWin = (c) => c.tSec >= loSec && c.tSec <= hiSec;
  const them = dpsState.order.them.filter(inWin);
  const mine = dpsState.order.mine.filter(inWin);
  const whole = loSec <= 0 && hiSec >= dpsState.durationSec - 1;
  const label = whole ? 'whole run' : `${fmtSec(loSec)}–${fmtSec(hiSec)}`;
  el.innerHTML = `
    <div class="ord-bar">Rotation for <b>${label}</b> — drag on the chart above to inspect any pull${
      whole ? '' : ` · <a href="#" id="ord-reset">reset to whole run</a>`
    }</div>
    ${renderCastOrderCols(them, mine)}
    ${renderWindowComposition(them, mine)}`;
  const reset = document.querySelector('#ord-reset');
  if (reset)
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      clearBrush();
      setCastWindow(0, dpsState.durationSec);
    });
}

function castKindClass(kind) {
  return kind === 'damage' ? 'p-blue' : kind === 'amp' ? 'p-orange' : 'p-gray';
}

const ORD_DISPLAY_CAP = 150;

function renderCastOrderCols(them, mine) {
  const col = (list, title) => {
    const shown = list.slice(0, ORD_DISPLAY_CAP);
    const items = shown
      .map((c) => `<li><span class="ord-t">${fmtTime(c.tSec * 1000)}</span> <span class="${castKindClass(c.kind)}">${esc(c.name)}</span></li>`)
      .join('');
    const more = list.length > ORD_DISPLAY_CAP ? `<li class="ord-more">…and ${list.length - ORD_DISPLAY_CAP} more — select a smaller window on the chart</li>` : '';
    return `<div class="ord-col"><div class="ord-head">${esc(title)} <small>(${list.length})</small></div><ol class="ord-list">${items}${more}</ol></div>`;
  };
  return `
    <div class="ord-wrap">
      ${col(them, `${esc(dpsState?.otherLabel ?? 'Them')} — cast order`)}
      ${col(mine, 'You — cast order')}
    </div>
    <p class="table-note"><small>Literal spell-cast sequence for the selected window.
      <span class="p-blue">Blue</span> = damage, <span class="p-orange">orange</span> = amplifier (Army/Dark Transformation/pot), grey = utility. Read their column top-down to see their flow.</small></p>`;
}

// order-sensitive cosine of cast-transition (bigram) vectors
function bigramSim(a, b) {
  const bg = (list) => {
    const m = new Map();
    for (let i = 0; i + 1 < list.length; i++) {
      const k = `${list[i].name}>${list[i + 1].name}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const A = bg(a);
  const B = bg(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k) ?? 0;
    const y = B.get(k) ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? Math.round((dot / (Math.sqrt(na) * Math.sqrt(nb))) * 100) : 0;
}

/** Spell-mix + cast-order similarity + per-ability count table for a window. */
function renderWindowComposition(them, mine) {
  if (them.length + mine.length < 6) return '';
  const count = (list) => {
    const m = new Map();
    for (const c of list) m.set(c.name, (m.get(c.name) ?? 0) + 1);
    return m;
  };
  const kindOf = new Map([...them, ...mine].map((c) => [c.name, c.kind]));
  const mc = count(mine);
  const tc = count(them);
  const names = [...new Set([...mc.keys(), ...tc.keys()])];
  const mTot = mine.length || 1;
  const tTot = them.length || 1;
  let dot = 0;
  let nm = 0;
  let nt = 0;
  for (const n of names) {
    const a = mc.get(n) ?? 0;
    const b = tc.get(n) ?? 0;
    dot += a * b;
    nm += a * a;
    nt += b * b;
  }
  const sim = nm && nt ? Math.round((dot / (Math.sqrt(nm) * Math.sqrt(nt))) * 100) : 0;
  const orderSim = bigramSim(mine, them);
  const rows = names
    .map((n) => {
      const mine2 = mc.get(n) ?? 0;
      const them2 = tc.get(n) ?? 0;
      const diffPp = Math.round(1000 * (mine2 / mTot - them2 / tTot)) / 10;
      return { n, mine: mine2, them: them2, diffPp, kind: kindOf.get(n) };
    })
    .sort((a, b) => b.them - a.them)
    .map((r) => {
      const tag = r.kind === 'amp' ? ' <small class="util">amp</small>' : r.kind === 'util' ? ' <small class="util">util</small>' : '';
      return `<tr class="${Math.abs(r.diffPp) >= 2 ? 'rot-big' : ''}"><td>${esc(r.n)}${tag}</td>
        <td class="num">${r.mine}</td><td class="num">${r.them}</td><td class="num">${r.diffPp > 0 ? '+' : ''}${r.diffPp}pp</td></tr>`;
    })
    .join('');
  return `
    <details><summary>Rotation match for this window — spell mix ${sim}% · cast order ${orderSim}%</summary>
      <p class="table-note"><small><b>Spell mix</b> = which abilities and how many (ignores order). <b>Cast order</b> = cosine of cast-to-cast transitions (order-sensitive) — lower means you sequence the same spells differently.</small></p>
      <table class="rot-table"><thead><tr><th>Ability</th><th>You</th><th>Them</th><th>Diff</th></tr></thead><tbody>${rows}</tbody></table>
    </details>`;
}

function renderDpsChartSection(targetName) {
  return `
    <h3>DPS over time <small>${targetName ? `— you vs ${esc(targetName)}` : ''}</small></h3>
    <div id="dps-chart" class="dps-chart-loading">Loading DPS-over-time (pulls damage events — up to ~15s first time, cached after)…</div>`;
}

async function loadDpsChart(encounterID, level, compareTo) {
  const el = $('#dps-chart');
  if (!el) return;
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('level', level);
    if (compareTo) params.set('compareTo', compareTo);
    const res = await fetch(`/api/dps-series?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const cur = $('#dps-chart');
    if (!cur) return; // report was replaced while loading
    cur.classList.remove('dps-chart-loading');
    const sa = data.spikeAnalysis;
    dpsState = {
      order: sa?.rotation?.order ?? { mine: [], them: [] },
      otherLabel: data.other.label,
      durationSec: Math.max(data.mine.durationMs, data.other.durationMs) / 1000,
    };
    cur.innerHTML =
      dpsChartSvg(data.mine, data.other) +
      `<p class="table-note"><small>5-second bins of effective damage (includes your pets). Both runs start at 0; a shorter run ends earlier on the axis. Drag across the chart to inspect any pull's rotation below; the curve shows WHEN your output lands. Absolute totals differ slightly from the parse number due to how WCL counts overkill.</small></p>` +
      renderSpikeAnalysis(sa);
    wireDpsBrush();
    setCastWindow(0, dpsState.durationSec); // default: whole run
  } catch (err) {
    const cur = $('#dps-chart');
    if (cur) cur.innerHTML = `<span class="error">DPS chart failed: ${esc(err.message)}</span>`;
  }
}

function renderDamageDone(dd) {
  if (!dd || !dd.rows.length) return '';
  const fmtM = (v) => (v / 1e6).toFixed(1) + 'm';
  const rows = dd.rows
    .slice(0, 30)
    .map(
      (a) => `<tr>
        <td>${esc(a.name)}</td>
        <td class="num">${fmtM(a.myAmount)}</td><td class="num">${a.myCasts || '—'}</td><td class="num">${a.myHits || '—'}</td><td class="num">${fmtK(a.myDps)}</td>
        <td class="num sep">${a.theirAmount ? fmtM(a.theirAmount) : '—'}</td><td class="num">${a.theirCasts || '—'}</td><td class="num">${a.theirHits || '—'}</td><td class="num">${a.theirDps ? fmtK(a.theirDps) : '—'}</td>
      </tr>`
    )
    .join('');
  const t = dd.totals;
  return `
    <details open><summary>Damage done — you vs ${esc(dd.otherLabel)} (per ability)</summary>
      <table class="dmg-table">
        <thead>
          <tr><th rowspan="2">Ability</th><th colspan="4" class="grp">You</th><th colspan="4" class="grp sep">${esc(dd.otherLabel)}</th></tr>
          <tr><th>Amount</th><th>Casts</th><th>Hits</th><th>DPS</th><th class="sep">Amount</th><th>Casts</th><th>Hits</th><th>DPS</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td>
          <td class="num">${fmtM(t.myDamage)}</td><td></td><td></td><td class="num">${fmtK(t.myDps)}</td>
          <td class="num sep">${fmtM(t.theirDamage)}</td><td></td><td></td><td class="num">${fmtK(t.theirDps)}</td></tr></tfoot>
      </table>
    </details>`;
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

function renderConsumables(c) {
  if (!c) return '';
  const flaskCell = (f, stat) =>
    f ? `${esc(f.name)}${stat ? ` <b class="p-orange">${esc(stat)}</b>` : ''} <small>(${f.pct}%)</small>` : '<span class="p-gray">none</span>';
  const foodCell = (f) => (f ? `${esc(f.name)} <small>(${f.pct}%)</small>` : '<span class="p-gray">none</span>');
  return `
    <div class="consumables">
      <h3>Consumables <small>— you vs ${esc(c.otherLabel)}</small></h3>
      <table class="rot-table">
        <thead><tr><th></th><th>You</th><th>${esc(c.otherLabel)}</th></tr></thead>
        <tbody>
          <tr><td>Flask</td><td>${flaskCell(c.flask.mine, c.flask.myStat)}</td><td>${flaskCell(c.flask.them, c.flask.theirStat)}</td></tr>
          <tr><td>Food</td><td>${foodCell(c.food.mine)}</td><td>${foodCell(c.food.them)}</td></tr>
        </tbody>
      </table>
      ${c.flaskNote ? `<p class="spike-note">${esc(c.flaskNote)}</p>` : ''}
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
  // always include the loaded level in the choices, even if outside the
  // default 18-25 range (e.g. a very high push); the active one is accented
  const levels = [...new Set([...LEVEL_CHOICES, level])].sort((a, b) => a - b);
  const levelBtns = levels
    .map((lvl) => `<button class="mini ${lvl === level ? 'accent' : ''}" data-level="${lvl}">+${lvl}</button>`)
    .join(' ');

  const players = lastCohortPlayers ?? h.cohortPlayers;
  const similar = lastSimilarPlayers ?? h.similarPlayers ?? [];
  const opt = (name, display) =>
    `<option value="${esc(name)}" ${name === compareTo ? 'selected' : ''}>${esc(display)}</option>`;
  const topOptions = players
    .map((p) => opt(p.name, p.label ? `${p.name} (${p.label}, +${p.keyLevel})` : `${p.name} (+${p.keyLevel})`))
    .join('');
  const similarOptions = similar
    .map((p) => opt(p.name, `${p.name} — ${p.matchPct}% route match${p.dps ? `, ${(p.dps / 1000).toFixed(1)}k` : ''}`))
    .join('');
  const compareSelect = `
    <select id="compare-to" class="mini">
      <option value="">All ${players.length} (median)</option>
      <optgroup label="Top players">${topOptions}</optgroup>
      ${similarOptions ? `<optgroup label="Parses similar to your run">${similarOptions}</optgroup>` : ''}
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
      <h2>${esc(h.dungeon)} +${h.myKeyLevel}${h.myKeyLevel !== h.requestedLevel ? ` <small>(closest to requested +${h.requestedLevel})</small>` : ''} — <span class="${pctClass(h.myBestPercent)}">${h.myBestPercent}%</span> parse
        <button id="refresh-report" class="mini" title="Re-fetch rankings from Warcraft Logs, bypassing the local cache — use after logging new runs">↻ Refresh data</button>
      </h2>
      <p>
        <b>${fmtK(h.myDps)}</b> me &nbsp;vs&nbsp; <b>${fmtK(h.cohortMedianDps)}</b> ${compareTo ? 'them' : `median of ${h.cohortSize}`} at +${h.cohortLevel}
        &nbsp;→&nbsp; ${gapPhrase(h.dpsGapPct)}
        <br /><small>compared against: ${h.cohortNames.map(esc).join(', ')}</small>
      </p>
      <p>compare at level: ${levelBtns}</p>
      <p>focus comparison on: ${compareSelect}</p>

      <h3>Biggest gaps first</h3>
      <ol class="gaps">${gapRows || '<li>No significant rotational gaps found.</li>'}</ol>

      ${renderParsePlan(r.parsePlan)}

      ${renderConsumables(r.consumables)}

      ${renderTimelineSection(r.timeline, r.timelineInfo)}

      ${renderDpsChartSection(h.similarTarget)}

      ${renderDamageDone(r.damageDone)}

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

      <p class="honesty">${
        r.honesty.explainedPct != null
          ? `DPS gap ${r.honesty.dpsGapPct}% — rotational metrics explain ~${r.honesty.explainedPct}% of it.`
          : `No positive DPS gap to attribute here (you match or beat this comparison).`
      }<br />
      <small>${esc(r.honesty.note)}</small></p>

      ${renderNextSteps(h, r.summary?.nextSteps)}
    </div>`;

  $('#report').querySelectorAll('[data-level]').forEach((b) =>
    b.addEventListener('click', () => loadReport(encounterID, Number(b.dataset.level), compareTo))
  );
  $('#compare-to').addEventListener('change', (e) => loadReport(encounterID, level, e.target.value));
  $('#refresh-report').addEventListener('click', () => loadReport(encounterID, level, compareTo, true));

  // Lazy: the report is on screen; now fetch the heavy DPS-over-time series
  // and inject the chart. Fire-and-forget so it never blocks the render.
  loadDpsChart(encounterID, level, compareTo);
}

loadOverview();
