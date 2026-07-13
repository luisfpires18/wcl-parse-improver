// The Mythic+ side: dungeon overview, the per-dungeon report, and its lazy
// DPS-over-time chart.
import { $, esc, fmtK, fmtPct, fmtTime, gapPhrase, pctClass } from './util.js';
import { state, charQuery, setStatus } from './state.js';
import {
  dpsChartSvg,
  wireDpsBrush,
  setCastWindow,
  renderSpikeAnalysis,
  renderTimelineSection,
  renderDamageDone,
} from './chart.js';

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

// Cohort dropdown options persist across a compareTo refetch — a compareTo
// response only contains the one filtered player, so the dropdown would
// otherwise lose every other option after the first pick.
let lastCohortPlayers = null;
let lastSimilarPlayers = null;

async function loadReport(encounterID, level, compareTo = '', refresh = false) {
  const dungeon = state.currentOverview?.dungeons.find((d) => d.encounterID === encounterID);
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
    const view = {
      state: {
        order: sa?.rotation?.order ?? { mine: [], them: [] },
        otherLabel: data.other.label,
        durationSec: Math.max(data.mine.durationMs, data.other.durationMs) / 1000,
      },
    };
    cur.innerHTML =
      dpsChartSvg(data.mine, data.other, view) +
      `<p class="table-note"><small>5-second bins of effective damage (includes your pets). Both runs start at 0; a shorter run ends earlier on the axis. Drag across the chart to inspect any pull's rotation below; the curve shows WHEN your output lands. Absolute totals differ slightly from the parse number due to how WCL counts overkill.</small></p>` +
      renderSpikeAnalysis(sa);
    wireDpsBrush(cur, view);
    setCastWindow(cur, view, 0, view.state.durationSec); // default: whole run
  } catch (err) {
    const cur = $('#dps-chart');
    if (cur) cur.innerHTML = `<span class="error">DPS chart failed: ${esc(err.message)}</span>`;
  }
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

  // Spec-specific resource panels. Both are null for specs that have no such
  // resource/spender — never render a Shaman a row saying "Death Coil casts".
  const s = r.tables.spender;
  const spenderRows = s
    ? `<tr><td>Death Coil casts</td><td class="num">${s.mine.deathCoil}</td><td class="num">${s.cohortDeathCoilCasts ?? '—'}</td></tr>
       <tr><td>Epidemic casts</td><td class="num">${s.mine.epidemic}</td><td class="num">${s.cohortEpidemicCasts ?? '—'}</td></tr>
       <tr><td>Epidemic share</td><td class="num">${s.mine.epidemicShare != null ? Math.round(100 * s.mine.epidemicShare) + '%' : '—'}</td>
           <td class="num">${s.cohortEpidemicShare != null ? Math.round(100 * s.cohortEpidemicShare) + '%' : '—'}</td></tr>`
    : '';

  const w = r.tables.rpWaste;
  const wasteRows = w
    ? `<tr><td>RP generated</td><td class="num">${Math.round(w.mine.netGain)}</td><td class="num">${w.cohortNetGain ?? '—'}</td></tr>
       <tr><td>RP wasted (overcapped)</td><td class="num">${Math.round(w.mine.waste)}</td><td class="num">${w.cohortWasteAmount ?? '—'}</td></tr>
       <tr><td>Waste %</td><td class="num">${w.mine.wastePct != null ? w.mine.wastePct.toFixed(1) + '%' : '—'}</td>
           <td class="num">${w.cohortWastePct != null ? w.cohortWastePct + '%' : '—'}</td></tr>`
    : '';

  const resourceTitle = s ? 'RP spender mix &amp; waste' : 'Runic Power waste';
  const resourcePanel =
    spenderRows || wasteRows
      ? `<details><summary>${resourceTitle} (mine vs cohort median)</summary>
          <table><thead><tr><th>Metric</th><th>Mine</th><th>Cohort median</th></tr></thead>
          <tbody>${spenderRows}${wasteRows}</tbody></table>
        </details>`
      : '';

  const downtimeNoteRows = (r.downtimeNotes ?? [])
    .map(
      (n) => `<tr><td>${esc(n.name)}</td><td class="num">${n.mineRaw}% → ${n.mineActive}%</td>
        <td class="num">${n.cohortRaw}% → ${n.cohortActive}%</td></tr>`
    )
    .join('');

  const downtimeRows = (r.tables.downtime.windows ?? [])
    .map((win) => `<tr><td>${fmtTime(win.startRelMs)}</td><td class="num">${(win.durMs / 1000).toFixed(1)}s</td></tr>`)
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
      ${resourcePanel}
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
