// Every chart and rotation view, shared by the M+ report and the raid pull view.
//
// A chart "view" bundles the cast-order lists + chart geometry for ONE chart, so
// two charts can be on the page at once without fighting over a module singleton
// or duplicate element ids. Every helper here is scoped to a root element + its
// view — never to `document`.
import { esc, fmtK, fmtSec, fmtTime, castKindClass, seriesColor } from './util.js';

// ---- rotation timeline (cast lanes) ----
// Lanes are picked server-side purely by cast frequency (see
// server/analysis/timeline.js) — never by ability name — so this keeps working
// across ability reworks.
const LEFT_LABEL_W = 132;
const PLOT_W = 700;
const ROW_H = 20;
const RIGHT_PAD = 8;

export function timelineSvg(run, laneNames, buffLaneNames = []) {
  const buffLanes = run.buffLanes ?? [];
  const nBuff = buffLaneNames.length;
  const rows = laneNames.length + nBuff + 2; // idle, deaths, buff bars, + cast lanes
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

  // BUFF lanes — drawn as BARS (a window you held), not ticks (a moment you
  // pressed). This is the only row type that can show a buff which is never cast:
  // a proc. An empty bar row means this run simply never had that buff up.
  buffLaneNames.forEach((name, bi) => {
    const i = bi + 2;
    const color = seriesColor(bi);
    parts.push(label(i, name, color));
    const bands = buffLanes.find((l) => l.name === name)?.bands ?? [];
    for (const b of bands) {
      const x1 = x(b.startMs);
      const x2 = x(b.endMs);
      parts.push(
        `<rect class="timeline-tick buff-band" x="${x1}" y="${rowY(i) + 4}" width="${Math.max(1.5, x2 - x1)}" height="${ROW_H - 8}" rx="2" fill="${color}" fill-opacity="0.42" stroke="${color}" stroke-width="1"><title>${esc(name)} — ${fmtTime(b.startMs)} to ${fmtTime(b.endMs)} (${((b.endMs - b.startMs) / 1000).toFixed(1)}s)</title></rect>`
      );
    }
  });

  // cooldown lanes (ticks)
  run.lanes.forEach((lane, li) => {
    const i = li + 2 + nBuff;
    const color = seriesColor(li);
    parts.push(label(i, lane.name, color));
    for (const ts of lane.casts) {
      parts.push(
        `<line class="timeline-tick" x1="${x(ts)}" x2="${x(ts)}" y1="${rowY(i) + 3}" y2="${rowY(i) + ROW_H - 3}" stroke="${color}" stroke-width="2" stroke-linecap="round"><title>${esc(lane.name)} at ${fmtTime(ts)}</title></line>`
      );
    }
  });

  // divider between the buff bars and the cast ticks, so the two read as
  // different kinds of thing rather than one long stack of rows
  if (nBuff) {
    const dy = rowY(2 + nBuff) - 1;
    parts.push(
      `<line x1="${LEFT_LABEL_W - 126}" x2="${LEFT_LABEL_W + PLOT_W}" y1="${dy}" y2="${dy}" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"></line>`
    );
  }

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

export function renderTimelineSection(timeline, timelineInfo) {
  if (!timeline || !timeline.laneNames.length) return '';
  const { laneNames, buffLaneNames = [], mine, other, otherRoleLabel } = timeline;
  const buffHelp = buffLaneNames.length
    ? ` <b>Filled bars above the dashed line = your buff windows</b> (procs, cooldowns, trinkets — only buffs you applied to yourself, never raid buffs).
        A buff is not a cast, so this is the only view that shows one: compare <em>when</em> each of you pressed a cooldown against <em>which buffs were up</em> at that moment.`
    : '';
  return `
    <h3>Rotation timeline</h3>
    <p class="timeline-sub"><small>Ticks = individual casts. Only cooldown-gated abilities get a lane — fillers are in the per-ability table further down.${buffHelp} The two runs have different durations, so each has its own time axis.</small></p>
    <div class="timeline-wrap">
      <div class="timeline-sub">You &middot; duration ${fmtTime(mine.durationMs)}</div>
      ${timelineSvg(mine, laneNames, buffLaneNames)}
      <div class="timeline-sub">${esc(other.label)}${otherRoleLabel ? ` (${esc(otherRoleLabel)})` : ''} &middot; duration ${fmtTime(other.durationMs)}</div>
      ${timelineSvg(other, laneNames, buffLaneNames)}
    </div>
    ${timelineInfo ? `<p class="timeline-info"><b>Info:</b> ${esc(timelineInfo.text)}</p>` : ''}`;
}

// ---- DPS-over-time line chart ----
const DPS_MINE_COLOR = 'var(--series-1)'; // blue = me
const DPS_OTHER_COLOR = 'var(--series-7)'; // magenta = them (WCL-like pink)
const CHART_L = 56; // left axis gutter
const CHART_R = 12;
const CHART_R_HP = 38; // wider right gutter when the boss-health axis is drawn
const CHART_T = 24; // legend row
const CHART_B = 22; // x-axis
const CHART_W = 760;
const CHART_H = 260;

/**
 * @param {object} mine binned DPS series
 * @param {object} other binned DPS series (already window-truncated, for a raid wipe)
 * @param {object} view receives `.geom` — the brush needs it
 * @param {{bossHealth?: {mine?: {points}, them?: {points}}}} [opts]
 *   When given, the boss's health % is drawn as a dashed line against a right-hand
 *   0-100% axis. It shares the x-axis with the DPS curves, so you can read WHERE in
 *   the boss's health your output landed — and, on a wipe, exactly where it ended.
 */
export function dpsChartSvg(mine, other, view = {}, opts = {}) {
  const hp = opts.bossHealth;
  const hasHp = Boolean(hp?.mine?.points?.length || hp?.them?.points?.length);
  const rightPad = hasHp ? CHART_R_HP : CHART_R;
  const plotW = CHART_W - CHART_L - rightPad;
  const plotH = CHART_H - CHART_T - CHART_B;
  const maxSec = Math.max(
    mine.points.at(-1)?.tSec ?? 0,
    other.points.at(-1)?.tSec ?? 0,
    mine.durationMs / 1000,
    other.durationMs / 1000
  );
  view.geom = { maxSec, x0: CHART_L, plotW, plotTop: CHART_T, plotH };
  const maxDps = Math.max(1, ...mine.points.map((p) => p.dps), ...other.points.map((p) => p.dps));
  const x = (sec) => CHART_L + (maxSec > 0 ? (sec / maxSec) * plotW : 0);
  const y = (dps) => CHART_T + plotH - (dps / maxDps) * plotH;
  const yHp = (pct) => CHART_T + plotH - (pct / 100) * plotH;
  const poly = (points, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${points
      .map((p) => `${x(p.tSec).toFixed(1)},${y(p.dps).toFixed(1)}`)
      .join(' ')}"></polyline>`;
  const hpPoly = (points, color) =>
    `<polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.75" stroke-linejoin="round" points="${points
      .map((p) => `${x(p.tSec).toFixed(1)},${yHp(p.pct).toFixed(1)}`)
      .join(' ')}"></polyline>`;

  const parts = [];
  // y gridlines + labels (0, 25, 50, 75, 100% of max)
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const gy = CHART_T + plotH - frac * plotH;
    parts.push(`<line x1="${CHART_L}" x2="${CHART_L + plotW}" y1="${gy}" y2="${gy}" stroke="var(--border)" stroke-width="1" opacity="0.5"></line>`);
    parts.push(`<text x="${CHART_L - 6}" y="${gy + 3}" font-size="9" fill="var(--muted)" text-anchor="end">${fmtK(frac * maxDps)}</text>`);
    // right-hand boss-health axis, same gridlines
    if (hasHp) {
      parts.push(`<text x="${CHART_L + plotW + 6}" y="${gy + 3}" font-size="9" fill="var(--muted)" text-anchor="start">${Math.round(frac * 100)}%</text>`);
    }
  }
  // x ticks
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const tx = CHART_L + frac * plotW;
    parts.push(`<text x="${tx}" y="${CHART_T + plotH + 14}" font-size="9" fill="var(--muted)" text-anchor="${frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle'}">${fmtSec(frac * maxSec)}</text>`);
  }

  // boss health under the DPS curves, so the curves stay the focus
  if (hp?.them?.points?.length) parts.push(hpPoly(hp.them.points, DPS_OTHER_COLOR));
  if (hp?.mine?.points?.length) parts.push(hpPoly(hp.mine.points, DPS_MINE_COLOR));

  parts.push(poly(other.points, DPS_OTHER_COLOR)); // draw theirs under mine
  parts.push(poly(mine.points, DPS_MINE_COLOR));

  // legend (direct labels)
  const legend = (cx, color, text, dashed = false) =>
    `<line x1="${cx}" x2="${cx + 16}" y1="12" y2="12" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="4 3"' : ''}></line>` +
    `<text x="${cx + 22}" y="15" font-size="10" fill="var(--text)">${esc(text)}</text>`;
  parts.push(legend(CHART_L, DPS_MINE_COLOR, `You (${fmtK(mine.totalDamage / (mine.durationMs / 1000))} avg)`));
  parts.push(legend(CHART_L + 180, DPS_OTHER_COLOR, `${other.label} (${fmtK(other.totalDamage / (other.durationMs / 1000))} avg)`));
  if (hasHp) parts.push(legend(CHART_L + 380, 'var(--muted)', 'boss health % (dashed, right axis)', true));

  // brush selection band (updated during drag) + transparent overlay on top
  // to capture pointer events for selecting a time window
  parts.push(`<rect class="dps-brush" x="0" y="${CHART_T}" width="0" height="${plotH}" fill="var(--accent)" opacity="0.16" pointer-events="none"></rect>`);
  parts.push(`<rect class="dps-overlay" x="${CHART_L}" y="${CHART_T}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"></rect>`);

  return `<svg class="dps-chart-svg" viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="xMinYMin meet">${parts.join('')}</svg>`;
}

// --- brush: drag on the chart to pick a time window ---
export function wireDpsBrush(root, view) {
  const svg = root?.querySelector('.dps-chart-svg');
  const overlay = root?.querySelector('.dps-overlay');
  const sel = root?.querySelector('.dps-brush');
  if (!svg || !overlay || !sel || !view?.geom) return;
  const g = view.geom;
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
    setCastWindow(root, view, a, b);
  };
  overlay.addEventListener('mousedown', (e) => {
    x0 = toViewX(e.clientX);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

export function clearBrush(root) {
  const sel = root?.querySelector('.dps-brush');
  if (sel) sel.setAttribute('width', 0);
}

/**
 * The mount point the chart brush writes cast order into.
 *
 * This slot used to be emitted by renderSpikeAnalysis, which coupled the
 * cast-order view to a panel that has nothing to do with it — deleting the spike
 * panel would have silently killed the brush. It stands on its own now: whoever
 * renders the chart renders this next to it.
 */
export const castOrderSlot = () => '<div class="rotation-dyn"></div>';

/** Filter the full cast-order lists to a time window and render the columns. */
export function setCastWindow(root, view, loSec, hiSec) {
  const el = root?.querySelector('.rotation-dyn');
  if (!el || !view?.state) return;
  const st = view.state;
  const inWin = (c) => c.tSec >= loSec && c.tSec <= hiSec;
  const them = st.order.them.filter(inWin);
  const mine = st.order.mine.filter(inWin);
  const whole = loSec <= 0 && hiSec >= st.durationSec - 1;
  const label = whole ? 'whole run' : `${fmtSec(loSec)}–${fmtSec(hiSec)}`;
  el.innerHTML = `
    <div class="ord-bar">Rotation for <b>${label}</b> — drag on the chart above to inspect any window${
      whole ? '' : ` · <a href="#" class="ord-reset">reset to whole run</a>`
    }</div>
    ${renderCastOrderCols(them, mine, st.otherLabel)}`;
  const reset = el.querySelector('.ord-reset');
  if (reset)
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      clearBrush(root);
      setCastWindow(root, view, 0, st.durationSec);
    });
}

const ORD_DISPLAY_CAP = 150;

/**
 * The two cast-order columns, each with its burst cooldowns PINNED above the
 * scrolling list.
 *
 * Two things made a cooldown impossible to find, and both are display bugs — the
 * data was always there:
 *
 *   1. A potion is usually the FIRST thing pressed, so it sits at the top of a
 *      140-row scrolling list. The moment you scroll to compare mid-fight play,
 *      it's gone. (Reported as "I can't find the potion, only shows mine" — theirs
 *      was at 0.1s, scrolled out of view.)
 *   2. The list is capped at 150 rows. A cooldown past that was silently DROPPED,
 *      so on a long window it genuinely wasn't rendered at all.
 *
 * The pinned strip fixes both: every burst cooldown in the window, complete, in
 * order, always visible. The full sequence stays below for reading the flow.
 */
/**
 * One player's cast order as a column: burst cooldowns pinned at the top (never
 * truncated — they're the reason you opened it), then the literal sequence.
 *
 * `cap` bounds the sequence list. Under the DPS chart that's what the brush is
 * for — narrow the window and the rest come into view. The "learn a boss" view
 * has NO chart, so there is nothing to brush and a cap would just hide casts with
 * no way to reach them: it passes cap = Infinity and renders the lot.
 */
export function castOrderColumn(list, title, { cap = ORD_DISPLAY_CAP, brushable = true } = {}) {
  const amps = list.filter((c) => c.kind === 'amp');

  // never truncated — the cooldowns are the whole reason you opened this
  const pinned = amps.length
    ? `<div class="ord-cds">
         <div class="ord-cds-head">Cooldowns &amp; consumables <small>(${amps.length})</small></div>
         <ol class="ord-cds-list">${amps
           .map((c) => `<li><span class="ord-t">${fmtTime(c.tSec * 1000)}</span> <span class="p-orange">${esc(c.name)}</span></li>`)
           .join('')}</ol>
       </div>`
    : `<div class="ord-cds"><div class="ord-cds-head muted">No cooldowns or consumables in this window</div></div>`;

  const shown = Number.isFinite(cap) ? list.slice(0, cap) : list;
  const items = shown
    .map(
      (c) =>
        `<li class="${c.kind === 'amp' ? 'ord-amp' : ''}"><span class="ord-t">${fmtTime(c.tSec * 1000)}</span> <span class="${castKindClass(c.kind)}">${esc(c.name)}</span></li>`
    )
    .join('');
  // the truncation note says what it actually drops — and the cooldowns among them
  // are safe, because they're pinned above
  const cut = list.length - shown.length;
  const more =
    cut > 0
      ? `<li class="ord-more">…and ${cut} more casts below (all cooldowns &amp; consumables are pinned above)${
          brushable ? ' — brush a smaller window on the chart to read them' : ''
        }</li>`
      : '';

  return `<div class="ord-col">
    <div class="ord-head">${esc(title)} <small>(${list.length})</small></div>
    ${pinned}
    <ol class="ord-list">${items}${more}</ol>
  </div>`;
}

export function renderCastOrderCols(them, mine, otherLabel) {
  return `
    <div class="ord-wrap">
      ${castOrderColumn(them, `${otherLabel ?? 'Them'} — cast order`)}
      ${castOrderColumn(mine, 'You — cast order')}
    </div>
    <p class="table-note"><small><b>Cooldowns &amp; consumables are pinned at the top of each column</b> so you never have to hunt for a potion
      in a 150-row list. <span class="p-orange"><b>Orange</b></span> is every <b>potion</b> (matched by its icon, so Light's Potential counts
      as surely as Potion of Recklessness), every <b>on-use trinket</b>, and any ability pressed at cooldown frequency that either deals damage
      or grants you a buff — all worked out from the run, never a per-class or per-item list. That last rule is deliberately generous: a rare
      <b>defensive</b> can land here too, because nothing in a log says whether a buff raises your damage or lowers theirs.
      <span class="p-blue">Blue</span> = ordinary damage, grey = utility. Below the pin is the literal cast sequence — read their column
      top-down for the flow, then check the <b>buff bars on the rotation timeline</b> to see which buffs were up while they pressed them.</small></p>`;
}
