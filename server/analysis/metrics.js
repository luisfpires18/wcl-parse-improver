// Per-run rotational metrics derived from a fetchRunDetail() result.
// No patch-specific rotation knowledge: everything is computed from what the
// run data itself contains, so the tool survives game patches.

const DOWNTIME_GAP_MS = 5000;

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

  const auras = new Map();
  for (const a of detail.buffs?.auras ?? []) {
    // duplicate aura names can appear (e.g. two "Lesser Ghoul" rows) — keep the larger
    const uptimePct = (100 * a.uptimeMs) / (detail.buffs.totalTimeMs || activeMs);
    const prev = auras.get(a.name);
    if (!prev || prev.uptimePct < uptimePct) auras.set(a.name, { uptimePct, uses: a.uses });
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

  const downtime = computeDowntime(detail.castEvents ?? [], fight);

  const totalCasts = detail.casts?.totalCasts ?? 0;
  const deathCoil = abilities.get('Death Coil')?.casts ?? 0;
  const epidemic = abilities.get('Epidemic')?.casts ?? 0;

  return {
    fightDurMs,
    activeMs,
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
  };
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
    if (gap > DOWNTIME_GAP_MS) windows.push({ startRelMs: prev - start, durMs: gap });
    prev = Math.max(prev, t);
  }
  const totalMs = windows.reduce((acc, w) => acc + w.durMs, 0);
  windows.sort((a, b) => b.durMs - a.durMs);
  return {
    totalMs,
    count: windows.length,
    windows: windows.slice(0, 8),
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
