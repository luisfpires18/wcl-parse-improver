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

export const fmtPct = (v) => (typeof v === 'number' ? v.toFixed(1) : '—');

export const fmtTime = (ms) => {
  if (typeof ms !== 'number' || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export const fmtK = (v) => (typeof v === 'number' ? (v / 1000).toFixed(1) + 'k' : '—');

/** Cast colouring shared by the timeline and the cast-order columns. */
export const castKindClass = (kind) => (kind === 'damage' ? 'p-blue' : kind === 'amp' ? 'p-orange' : 'p-gray');

export const seriesColor = (i) => `var(--series-${(i % 8) + 1})`;
