// Per-run rotational metrics derived from a fetchRunDetail() result.
// No patch-specific rotation knowledge: everything is computed from what the
// run data itself contains, so the tool survives game patches.

const DOWNTIME_GAP_MS = 5000;

// consumables / cosmetic rows that would pollute ability-frequency analysis
// (cast diffs in compare.js, cooldown-lane selection in timeline.js)
export const IGNORED_ABILITIES = new Set([
  'Acherus Deathcharger',
  'Raise Ally',
  "Charge!", // gauntlet extra action button appears for everyone
  'Raise Dead', // pet-alive uptime is noisy — dismissed for mechanics/skips, not a rotation habit worth flagging
]);

export function computeRunMetrics(detail) {
  const fight = detail.fight ?? {};
  const fightDurMs =
    fight.keystoneTime ?? (fight.endTime && fight.startTime ? fight.endTime - fight.startTime : null);
  const activeMs = detail.casts?.totalTimeMs ?? fightDurMs ?? 1;
  const minutes = activeMs / 60000;

  const abilities = new Map();
  for (const a of detail.casts?.abilities ?? []) {
    abilities.set(a.name, { casts: a.casts, cpm: a.casts / minutes });
  }

  const downtime = computeDowntime(detail.castEvents ?? [], fight);
  // "engaged" = fight span minus my idle windows (>5s zero-cast gaps, which
  // include death → re-engage stretches). Uptime measured only inside these
  // windows isolates buff management from downtime/deaths/routing.
  const engaged = engagedWindows(fight, downtime.allWindows);
  const engagedMs = engaged.reduce((acc, w) => acc + (w.end - w.start), 0);

  const auras = new Map();
  for (const a of detail.buffs?.auras ?? []) {
    // duplicate aura names can appear (e.g. two "Lesser Ghoul" rows) — keep the larger
    const uptimePct = (100 * a.uptimeMs) / (detail.buffs.totalTimeMs || activeMs);
    const activeUptimePct = engagedMs
      ? (100 * intersectMs(a.bands ?? [], engaged)) / engagedMs
      : null;
    const prev = auras.get(a.name);
    if (!prev || prev.uptimePct < uptimePct) {
      auras.set(a.name, { uptimePct, activeUptimePct, uses: a.uses });
    }
  }

  const damageShare = new Map();
  const totalDamage = detail.damage?.totalDamage || 1;
  for (const a of detail.damage?.abilities ?? []) {
    damageShare.set(a.name, a.total / totalDamage);
  }

  const deaths = (detail.deaths?.deaths ?? []).map((d) => ({
    atMs: d.timestamp != null && fight.startTime != null ? d.timestamp - fight.startTime : null,
    topAbility: d.topAbility,
  }));

  const totalCasts = detail.casts?.totalCasts ?? 0;
  const deathCoil = abilities.get('Death Coil')?.casts ?? 0;
  const epidemic = abilities.get('Epidemic')?.casts ?? 0;

  return {
    fightDurMs,
    activeMs,
    engagedMs,
    totalCasts,
    totalCPM: totalCasts / minutes,
    abilities,
    auras,
    damageShare,
    deaths,
    downtime,
    spender: {
      deathCoil,
      epidemic,
      epidemicShare: deathCoil + epidemic ? epidemic / (deathCoil + epidemic) : null,
    },
    rpWaste: computeRpWaste(detail.resourceEvents ?? []),
  };
}

// WCL scales Runic Power x10 in resourcechange events (maxResourceAmount
// 1000 = the real 100 RP cap) — verified against a real payload.
const RP_SCALE = 10;

/**
 * `resourceChange` is the net amount actually added (already clipped to the
 * cap); `waste` is the extra that would have been added if not capped. So
 * "% of potential generation lost" = waste / (net + waste).
 */
function computeRpWaste(resourceEvents) {
  let netGain = 0;
  let waste = 0;
  for (const e of resourceEvents) {
    netGain += e.gain;
    waste += e.waste;
  }
  const potential = netGain + waste;
  return {
    netGain: netGain / RP_SCALE,
    waste: waste / RP_SCALE,
    wastePct: potential ? (100 * waste) / potential : null,
    events: resourceEvents.length,
  };
}

/** Fight span minus idle windows -> sorted non-overlapping absolute windows. */
function engagedWindows(fight, idleWindows) {
  const start = fight.startTime ?? null;
  const end = fight.endTime ?? null;
  if (start == null || end == null) return [];
  const idles = (idleWindows ?? [])
    .map((w) => ({ start: w.startAbsMs, end: w.startAbsMs + w.durMs }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = start;
  for (const idle of idles) {
    if (idle.start > cursor) out.push({ start: cursor, end: Math.min(idle.start, end) });
    cursor = Math.max(cursor, idle.end);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out;
}

/** Total overlap between aura bands and engaged windows (both absolute ms). */
function intersectMs(bands, engaged) {
  let total = 0;
  for (const band of bands) {
    for (const w of engaged) {
      const lo = Math.max(band.startTime, w.start);
      const hi = Math.min(band.endTime, w.end);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

/** Gaps > 5s with zero casts, fight-relative. Includes lead-in and tail. */
function computeDowntime(castEvents, fight) {
  const start = fight.startTime ?? null;
  const end = fight.endTime ?? null;
  if (start == null || end == null || !castEvents.length) {
    return { totalMs: 0, count: 0, windows: [], idlePct: null };
  }
  const stamps = castEvents.map((c) => c.timestamp);
  const windows = [];
  let prev = start;
  for (const t of [...stamps, end]) {
    const gap = t - prev;
    if (gap > DOWNTIME_GAP_MS) {
      windows.push({ startRelMs: prev - start, startAbsMs: prev, durMs: gap });
    }
    prev = Math.max(prev, t);
  }
  const totalMs = windows.reduce((acc, w) => acc + w.durMs, 0);
  const byDuration = [...windows].sort((a, b) => b.durMs - a.durMs);
  return {
    totalMs,
    count: windows.length,
    windows: byDuration.slice(0, 8),
    allWindows: windows,
    idlePct: (100 * totalMs) / (end - start),
  };
}

/** Median of a numeric array (null on empty). */
export function median(nums) {
  const s = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
