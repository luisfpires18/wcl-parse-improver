// Formatting, escaping and the WCL-style colour scale. No state, no DOM writes —
// safe to import anywhere.

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** WCL parse colours: pink 99+, orange 95+, purple 75+, blue 50+, green 25+. */
export function pctClass(v) {
  if (typeof v !== 'number') return '';
  if (v >= 99) return 'p-pink';
  if (v >= 95) return 'p-orange';
  if (v >= 75) return 'p-purple';
  if (v >= 50) return 'p-blue';
  if (v >= 25) return 'p-green';
  return 'p-gray';
}

/** The same scale as a colour value, for a bar rather than text. */
export function pctColor(v) {
  if (typeof v !== 'number') return '#3a3850';
  if (v >= 99) return '#e268a8';
  if (v >= 95) return '#ff8000';
  if (v >= 75) return '#a335ee';
  if (v >= 50) return '#0070dd';
  if (v >= 25) return '#1eff00';
  return '#9d9d9d';
}

/**
 * One row of a ranking board: a bar whose length IS the number, so a page of
 * them reads as a shape rather than a column of digits. Shared by the roster,
 * the M+ dungeon list and the raid boss list so all three look like one app.
 *
 * `pct` drives the bar length (0-100). For percentiles that's the value itself,
 * which is why the bar is comparable across dungeons without any scaling.
 */
export function boardRow({
  rank,
  color,
  iconUrl,
  title,
  subtitle,
  pct,
  value,
  meta = '',
  action = '',
  dim = false,
  attrs = '', // e.g. data-encounter="123", to make the whole row a click target
  clickable = false,
}) {
  const width = typeof pct === 'number' ? Math.max(4, Math.min(100, pct)) : 0;
  return `<div class="rank-row ${dim ? 'unanalysed' : ''} ${clickable ? 'clickable' : ''}" style="--class: ${color}" ${attrs}>
    <span class="rank">${rank}</span>
    ${iconUrl ? `<img class="portrait" src="${esc(iconUrl)}" alt="" loading="lazy" />` : '<span class="portrait blank"></span>'}
    <div class="rank-body">
      ${
        width
          ? `<div class="bar" style="width: ${width}%">
               <span class="who"><b>${esc(title)}</b><small>${esc(subtitle ?? '')}</small></span>
             </div>`
          : `<div class="bar empty">
               <span class="who"><b>${esc(title)}</b><small>${esc(subtitle ?? '')}</small></span>
             </div>`
      }
      <b class="value">${value}</b>
    </div>
    <div class="rank-meta">${meta}</div>
    <div class="row-actions">${action}</div>
  </div>`;
}

// The empty-value mark. A middot reads as "nothing here" without the heavy
// em-dash the rest of the UI used to litter every blank cell with.
export const EMPTY = '·';

export const fmtPct = (v) => (typeof v === 'number' ? v.toFixed(1) : EMPTY);

export const fmtTime = (ms) => {
  if (typeof ms !== 'number' || ms < 0) return EMPTY;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export const fmtK = (v) => (typeof v === 'number' ? (v / 1000).toFixed(1) + 'k' : EMPTY);

/** Cast colouring shared by the timeline and the cast-order columns. */
export const castKindClass = (kind) => (kind === 'damage' ? 'p-blue' : kind === 'amp' ? 'p-orange' : 'p-gray');

export const seriesColor = (i) => `var(--series-${(i % 8) + 1})`;
