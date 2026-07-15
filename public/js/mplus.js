// The Mythic+ side: dungeon overview, and the per-dungeon eight-section report.
//
// The report itself is rendered by report.js — the same renderer the raid view
// uses. This file only fetches the right thing and wires the two controls that are
// M+-specific: the key-level buttons and the opponent picker.
import { $, esc, fmtK, fmtPct, fmtTime, pctClass, pctColor, boardRow } from './util.js';
import { state, charQuery, setStatus, showLoading, hideLoading, skeleton } from './state.js';
import { renderReport } from './report.js';
import { dpsChartSvg, wireDpsBrush, setCastWindow, castOrderSlot } from './chart.js';

const DEFAULT_LEVEL = 20;
const LEVEL_CHOICES = [18, 19, 20, 21, 22, 23, 24, 25];

export async function loadOverview(refresh = false) {
  showLoading(refresh ? 'Refreshing your dungeons, bypassing the cache…' : 'Loading your dungeons…');
  $('#overview').innerHTML = skeleton(5);
  $('#report').innerHTML = '';
  try {
    const params = charQuery();
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/overview?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.currentOverview = data;
    renderOverview(data);
    hideLoading();
  } catch (err) {
    hideLoading();
    $('#overview').innerHTML = '';
    setStatus(`<span class="error">Error: ${esc(err.message)}</span>`);
  }
}

function renderOverview({ character, overall, dungeons }) {
  // Weakest first by default: this app exists to close gaps, and the dungeon
  // with the worst parse is the one worth opening. A dungeon with no logged run
  // has nothing to improve, so it sinks to the bottom either way.
  const order = state.mplusSort ?? 'weakest';
  const ranked = [...dungeons].sort((a, b) => {
    const av = a.bestPercent;
    const bv = b.bestPercent;
    if (typeof av !== 'number') return 1;
    if (typeof bv !== 'number') return -1;
    return order === 'weakest' ? av - bv : bv - av;
  });

  const rows = ranked
    .map((d, i) => {
      const run = typeof d.bestPercent === 'number';
      return boardRow({
        rank: i + 1,
        color: pctColor(d.bestPercent),
        title: d.name,
        subtitle: run ? `+${d.keyLevel ?? '?'} · ${fmtTime(d.durationMs)}` : 'no logged run',
        pct: d.bestPercent,
        value: `<span class="${pctClass(d.bestPercent)}">${fmtPct(d.bestPercent)}</span>`,
        meta: run ? `<span class="stat"><i>dps</i> ${fmtK(d.bestDps)}</span>` : '',
        action: `<button class="mini" data-analyze="${d.encounterID}">analyze</button>`,
        dim: !run,
        attrs: `data-encounter="${d.encounterID}"`,
        clickable: true,
      });
    })
    .join('');

  const pill = (key, label) =>
    `<button class="pill ${order === key ? 'on' : ''}" data-sort="${key}">${label}</button>`;

  $('#overview').innerHTML = `
    <div class="card">
      <div class="board-head">
        <span class="headline">
          <b class="${pctClass(overall.bestPerformanceAverage)}">${fmtPct(overall.bestPerformanceAverage)}</b>
          <small class="muted">best avg · Mythic+</small>
        </span>
        <div class="pills">${pill('weakest', 'Weakest first')}${pill('best', 'Best first')}</div>
        <button id="worst" class="mini accent">analyze my worst parse</button>
        <button id="refresh-overview" class="mini" title="Re-fetch from Warcraft Logs, bypassing the local cache">↻ Refresh</button>
      </div>

      <div class="board parse">${rows}</div>
      <p class="table-note"><small>The bar <b>is</b> the percentile, so it reads the same in every dungeon. Click a row
        to analyse your best run there against the top runs of your spec at that key level.</small></p>
    </div>`;

  $('#overview .pills').addEventListener('click', (e) => {
    const key = e.target.closest('[data-sort]')?.dataset.sort;
    if (!key) return;
    state.mplusSort = key;
    renderOverview({ character, overall, dungeons });
  });

  // Default level for a dungeon = the highest key the character actually logged
  // there (that's the run that gates invites), not a fixed global.
  const defaultLevelFor = (encounterID) => {
    const d = dungeons.find((x) => x.encounterID === encounterID);
    return typeof d?.keyLevel === 'number' ? d.keyLevel : DEFAULT_LEVEL;
  };

  $('#overview .board').addEventListener('click', (e) => {
    const id =
      e.target.closest('[data-analyze]')?.dataset.analyze ??
      e.target.closest('[data-encounter]')?.dataset.encounter;
    if (id) loadReport(Number(id), defaultLevelFor(Number(id)));
  });
  $('#worst').addEventListener('click', () => {
    const ranked = [...dungeons].filter((d) => typeof d.bestPercent === 'number').sort((a, b) => a.bestPercent - b.bestPercent);
    if (ranked.length) loadReport(ranked[0].encounterID, defaultLevelFor(ranked[0].encounterID));
  });
  $('#refresh-overview').addEventListener('click', () => loadOverview(true));
}

/**
 * @param {boolean} [refresh] bypass the disk cache — for after you've logged a new
 *   run, when the cached ranking still shows the old one.
 */
async function loadReport(encounterID, level, compareTo = '', refresh = false) {
  const dungeon = state.currentOverview?.dungeons.find((d) => d.encounterID === encounterID);
  showLoading(
    refresh
      ? `Re-fetching <b>${esc(dungeon?.name ?? encounterID)}</b> at +${level}, bypassing the cache…`
      : `Building report for <b>${esc(dungeon?.name ?? encounterID)}</b> at +${level}. ` +
          `<small>First fetch pulls your run and one opponent; cached afterwards.</small>`
  );
  $('#report').innerHTML = skeleton(6);
  $('#report').scrollIntoView({ block: 'start', behavior: 'smooth' });
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('level', level);
    if (compareTo) params.set('compareTo', compareTo);
    if (refresh) params.set('refresh', '1');
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
          ${h.myBestPercent != null ? `<span class="${pctClass(h.myBestPercent)}">${h.myBestPercent}%</span> <small>parse</small>` : ''}
          <button id="refresh-report" class="mini" title="Re-fetch this report from Warcraft Logs, bypassing the local cache">↻ Refresh</button>
        </h2>
        ${renderReport(view)}
      </div>`;

    $('#report').querySelectorAll('[data-level]').forEach((b) =>
      b.addEventListener('click', () => loadReport(encounterID, Number(b.dataset.level), compareTo))
    );
    $('#compare-to').addEventListener('change', (e) => loadReport(encounterID, level, e.target.value));
    $('#refresh-report').addEventListener('click', () => loadReport(encounterID, level, compareTo, true));

    hideLoading();

    // Lazy: the report is on screen; now fetch the heavy damage-event series and
    // inject the chart. Fire-and-forget so it never blocks the render.
    // The chart is a SECOND request, so a refresh has to reach it too — otherwise
    // you'd get a re-fetched report with a stale chart under it.
    loadDpsChart(encounterID, level, compareTo, view.castOrder, refresh);
  } catch (err) {
    hideLoading();
    $('#report').innerHTML = '';
    setStatus(`<span class="error">Report failed: ${esc(err.message)}</span>`);
  }
}

/** Section 1's chart + section 2's cast order (the brush filters one into the other). */
async function loadDpsChart(encounterID, level, compareTo, order, refresh = false) {
  const el = $('#dps-chart');
  if (!el) return;
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('level', level);
    if (compareTo) params.set('compareTo', compareTo);
    if (refresh) params.set('refresh', '1');
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
