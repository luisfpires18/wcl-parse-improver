// The Mythic+ side: dungeon overview, and the per-dungeon eight-section report.
//
// The report itself is rendered by report.js — the same renderer the raid view
// uses. This file only fetches the right thing and wires the two controls that are
// M+-specific: the key-level buttons and the opponent picker.
import { $, esc, fmtK, fmtPct, fmtTime, pctClass } from './util.js';
import { state, charQuery, setStatus } from './state.js';
import { renderReport } from './report.js';
import { dpsChartSvg, wireDpsBrush, setCastWindow, castOrderSlot } from './chart.js';

const DEFAULT_LEVEL = 20;
const LEVEL_CHOICES = [18, 19, 20, 21, 22, 23, 24, 25];

export async function loadOverview(refresh = false) {
  setStatus(refresh ? 'Refreshing from Warcraft Logs (bypassing cache)…' : 'Loading overview…');
  $('#overview').innerHTML = '';
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/overview?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.currentOverview = data;
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
        <td class="num ${pctClass(d.bestPercent)}">${fmtPct(d.bestPercent)}</td>
        <td class="num">${fmtK(d.bestDps)}</td>
        <td><button class="mini" data-analyze="${d.encounterID}">analyze</button></td>
      </tr>`
    )
    .join('');

  $('#overview').innerHTML = `
    <div class="card">
      <h2>${esc(character)} <small>— Mythic+</small>
        <button id="refresh-overview" class="mini" title="Re-fetch from Warcraft Logs, bypassing the local cache">↻ Refresh</button>
      </h2>
      <p>Best avg: <b class="${pctClass(overall.bestPerformanceAverage)}">${fmtPct(overall.bestPerformanceAverage)}</b>
         <button id="worst" class="mini accent">analyze my worst parse</button></p>
      <table>
        <thead><tr><th>Dungeon</th><th>Level</th><th>Time</th><th>Best %</th><th>Best DPS</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Default level for a dungeon = the highest key the character actually logged
  // there (that's the run that gates invites), not a fixed global.
  const defaultLevelFor = (encounterID) => {
    const d = dungeons.find((x) => x.encounterID === encounterID);
    return typeof d?.keyLevel === 'number' ? d.keyLevel : DEFAULT_LEVEL;
  };

  $('#overview tbody').addEventListener('click', (e) => {
    const id = e.target.closest('[data-analyze]')?.dataset.analyze ?? e.target.closest('tr[data-encounter]')?.dataset.encounter;
    if (id) loadReport(Number(id), defaultLevelFor(Number(id)));
  });
  $('#worst').addEventListener('click', () => {
    const ranked = [...dungeons].filter((d) => typeof d.bestPercent === 'number').sort((a, b) => a.bestPercent - b.bestPercent);
    if (ranked.length) loadReport(ranked[0].encounterID, defaultLevelFor(ranked[0].encounterID));
  });
  $('#refresh-overview').addEventListener('click', () => loadOverview(true));
}

async function loadReport(encounterID, level, compareTo = '') {
  const dungeon = state.currentOverview?.dungeons.find((d) => d.encounterID === encounterID);
  setStatus(
    `Building report for <b>${esc(dungeon?.name ?? encounterID)}</b> at +${level}… ` +
      `<small>first fetch pulls your run and one opponent from WCL; cached afterwards</small>`
  );
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('level', level);
    if (compareTo) params.set('compareTo', compareTo);
    const res = await fetch(`/api/report?${params}`);
    const view = await res.json();
    if (!res.ok) throw new Error(view.error || `HTTP ${res.status}`);

    // the key-level buttons are M+-only, so the shared renderer takes them as markup
    const levels = [...new Set([...LEVEL_CHOICES, level])].sort((a, b) => a - b);
    view.levelPicker =
      ' at level: ' +
      levels.map((l) => `<button class="mini ${l === level ? 'accent' : ''}" data-level="${l}">+${l}</button>`).join(' ');

    const h = view.headline;
    $('#report').innerHTML = `
      <div class="card">
        <h2>${esc(h.title)} ${esc(h.subtitle ?? '')}
          ${h.myBestPercent != null ? `— <span class="${pctClass(h.myBestPercent)}">${h.myBestPercent}%</span> parse` : ''}
        </h2>
        ${renderReport(view)}
      </div>`;

    $('#report').querySelectorAll('[data-level]').forEach((b) =>
      b.addEventListener('click', () => loadReport(encounterID, Number(b.dataset.level), compareTo))
    );
    $('#compare-to').addEventListener('change', (e) => loadReport(encounterID, level, e.target.value));

    setStatus('');
    $('#report').scrollIntoView({ behavior: 'smooth' });

    // Lazy: the report is on screen; now fetch the heavy damage-event series and
    // inject the chart. Fire-and-forget so it never blocks the render.
    loadDpsChart(encounterID, level, compareTo, view.castOrder);
  } catch (err) {
    setStatus(`<span class="error">Report failed: ${esc(err.message)}</span>`);
  }
}

/** Section 1's chart + section 2's cast order (the brush filters one into the other). */
async function loadDpsChart(encounterID, level, compareTo, order) {
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
    if (!cur) return; // the report was replaced while this was loading
    cur.classList.remove('dps-chart-loading');

    const view = {
      state: {
        order: order ?? { mine: [], them: [] },
        otherLabel: data.otherLabel,
        durationSec: Math.max(data.mine.durationMs, data.other.durationMs) / 1000,
      },
    };
    cur.innerHTML =
      dpsChartSvg(data.mine, data.other, view) +
      `<p class="table-note"><small>5-second bins of effective damage (includes your pets). <b>Drag across the chart</b> to see only the casts from that window.</small></p>` +
      castOrderSlot();
    wireDpsBrush(cur, view);
    setCastWindow(cur, view, 0, view.state.durationSec); // default: the whole run
  } catch (err) {
    const cur = $('#dps-chart');
    if (cur) cur.innerHTML = `<span class="error">DPS chart failed: ${esc(err.message)}</span>`;
  }
}
