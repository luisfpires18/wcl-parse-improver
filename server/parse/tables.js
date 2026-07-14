// Parsers for report table JSON scalars (Casts / Buffs / DamageDone / Deaths)
// and the cast-events stream. Shapes verified against fixtures/table-*.json.
import { dumpDebug } from '../wcl/client.js';

/** Casts table -> per-ability cast counts. */
export function parseCastsTable(table) {
  const d = dataOf(table, 'casts');
  const entries = Array.isArray(d?.entries) ? d.entries : [];
  const abilities = entries
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      name: e.name ?? '(unknown)',
      guid: e.guid ?? null,
      casts: numOr0(e.total),
      abilityIcon: e.abilityIcon ?? null,
    }))
    .sort((a, b) => b.casts - a.casts);
  return {
    totalTimeMs: numOrNull(d?.totalTime),
    abilities,
    totalCasts: abilities.reduce((acc, a) => acc + a.casts, 0),
  };
}

/** Buffs table -> per-aura uptimes. */
export function parseBuffsTable(table) {
  const d = dataOf(table, 'buffs');
  const auras = Array.isArray(d?.auras) ? d.auras : [];
  return {
    totalTimeMs: numOrNull(d?.totalTime),
    auras: auras
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        name: a.name ?? '(unknown)',
        guid: a.guid ?? null,
        // the icon is how a potion is identified (see analysis/potions.js) — a name
        // prefix misses "Light's Potential"
        abilityIcon: a.abilityIcon ?? null,
        uptimeMs: numOr0(a.totalUptime),
        uses: numOr0(a.totalUses),
        // report-relative [start,end] application windows; needed for
        // active-time uptime (intersection with engaged windows)
        bands: Array.isArray(a.bands)
          ? a.bands
              .filter((b) => b && typeof b.startTime === 'number' && typeof b.endTime === 'number')
              .map((b) => ({ startTime: b.startTime, endTime: b.endTime }))
          : [],
      }))
      .sort((a, b) => b.uptimeMs - a.uptimeMs),
  };
}

/** DamageDone table -> per-ability damage (composite entries fold pets in). */
export function parseDamageTable(table) {
  const d = dataOf(table, 'damage');
  const entries = Array.isArray(d?.entries) ? d.entries : [];
  const abilities = entries
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      name: e.name ?? '(unknown)',
      guid: e.guid ?? null,
      total: numOr0(e.total),
      hits: numOr0(e.hitCount),
      composite: Boolean(e.composite),
    }))
    .sort((a, b) => b.total - a.total);
  return {
    totalTimeMs: numOrNull(d?.totalTime),
    abilities,
    totalDamage: abilities.reduce((acc, a) => acc + a.total, 0),
  };
}

/**
 * Bin DamageDone events into a compact DPS-over-time series.
 *
 * `events(dataType: DamageDone, sourceID: <player>)` already folds in the
 * player's pets (verified: Magus/ghoul abilities appear under the player's
 * sourceID), so a single fetch covers total output. `amount` is effective
 * (post-mitigation) damage; the absolute level differs slightly from the
 * DamageDone *table* total (different overkill/cap accounting), so this is
 * used for the curve SHAPE, not to restate the parse number.
 *
 * @returns {{ binMs:number, points:{tSec:number,dps:number}[], totalDamage:number }}
 */
export function binDamageEvents(eventPages, fight, binMs = 5000) {
  const start = fight?.startTime ?? null;
  const end = fight?.endTime ?? null;
  if (start == null || end == null || end <= start) {
    return { binMs, points: [], totalDamage: 0 };
  }
  const nBins = Math.max(1, Math.ceil((end - start) / binMs));
  const buckets = new Array(nBins).fill(0);
  let totalDamage = 0;
  for (const page of eventPages) {
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const ev of data) {
      if (ev?.type !== 'damage' || typeof ev.timestamp !== 'number') continue;
      const amount = numOr0(ev.amount);
      if (amount <= 0) continue;
      const i = Math.min(nBins - 1, Math.max(0, Math.floor((ev.timestamp - start) / binMs)));
      buckets[i] += amount;
      totalDamage += amount;
    }
  }
  const binSec = binMs / 1000;
  const points = buckets.map((dmg, i) => ({ tSec: i * binSec, dps: dmg / binSec }));
  return { binMs, points, totalDamage };
}

/** Deaths table -> death timestamps (report-relative ms) + killing blows. */
export function parseDeathsTable(table) {
  const d = dataOf(table, 'deaths');
  const entries = Array.isArray(d?.entries) ? d.entries : [];
  return {
    deaths: entries
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        timestamp: numOrNull(e.timestamp),
        // biggest contributing damage ability, when present
        topAbility: e.damage?.abilities?.[0]?.name ?? null,
      })),
  };
}

/**
 * Whole-raid Deaths table (no sourceID) -> one row per death, keeping the
 * player, actor id, absolute timestamp and which fight it belongs to. Used to
 * reconstruct each pull's death cascade so a player's death can be placed
 * relative to the raid's (died early vs went down with everyone).
 */
export function parseFightDeaths(table) {
  const d = dataOf(table, 'deaths');
  const entries = Array.isArray(d?.entries) ? d.entries : [];
  return entries
    .filter((e) => e && typeof e === 'object' && typeof e.timestamp === 'number')
    .map((e) => ({
      name: e.name ?? null,
      id: numOrNull(e.id),
      timestamp: e.timestamp,
      fight: numOrNull(e.fight),
    }));
}

/** Cast events stream -> ordered cast timestamps (type "cast" only). */
export function parseCastEvents(eventPages) {
  const casts = [];
  for (const page of eventPages) {
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const ev of data) {
      if (ev?.type === 'cast' && typeof ev.timestamp === 'number') {
        casts.push({ timestamp: ev.timestamp, abilityGameID: ev.abilityGameID ?? null });
      }
    }
  }
  casts.sort((a, b) => a.timestamp - b.timestamp);
  return casts;
}

/**
 * Resource-generation events -> { type, gain, waste } per event.
 *
 * This used to hard-filter to resourceChangeType 6 (Runic Power), which made the
 * whole resource feature Death-Knight-only. It now keeps EVERY resource type and
 * lets the analysis layer work out which one is the spec's (see
 * analysis/resources.js) — the log already says which resource a class uses, so
 * nothing needs to be hardcoded per class.
 *
 * Still filtered to the player's OWN resource (sourceID === targetID): a pet has
 * its own separate pool under a different type, and that is not the player's
 * resource management.
 *
 * `resourceChange` is the net amount actually added (already clipped to the cap);
 * `waste` is the extra that would have been added had the cap not stopped it.
 */
export function parseResourceEvents(eventPages) {
  const events = [];
  for (const page of eventPages) {
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const ev of data) {
      if (ev?.type === 'resourcechange' && ev.sourceID === ev.targetID && typeof ev.timestamp === 'number') {
        events.push({
          timestamp: ev.timestamp,
          type: numOrNull(ev.resourceChangeType),
          gain: numOr0(ev.resourceChange),
          waste: numOr0(ev.waste),
          maxAmount: numOrNull(ev.maxResourceAmount),
          abilityGameID: ev.abilityGameID ?? null,
        });
      }
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

/**
 * Classify each aura name as self-applied or externally-applied, from real
 * apply/remove/refresh events (not guessed). For every event whose
 * abilityGameID resolves to a name via `abilityNameByGameID`, count whether
 * the event's own sourceID is the player themselves or someone else.
 * A name with any foreign-sourced event and zero self-sourced ones is a
 * buff the player cannot personally control (a raid/party utility buff).
 */
export function classifyBuffSources(eventPages, myActorId, abilityNameByGameID) {
  // plain object, not a Map — this gets written to fixture JSON and read
  // back in tests/CLI scripts, and a Map silently flattens to `{}` through
  // JSON.stringify/parse
  const byName = {};
  for (const page of eventPages) {
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const ev of data) {
      if (
        (ev?.type === 'applybuff' || ev?.type === 'applybuffstack' || ev?.type === 'removebuff') &&
        typeof ev.sourceID === 'number' &&
        typeof ev.abilityGameID === 'number'
      ) {
        const name = abilityNameByGameID.get(ev.abilityGameID);
        if (!name) continue;
        const entry = byName[name] ?? { self: 0, foreign: 0 };
        if (ev.sourceID === myActorId) entry.self += 1;
        else entry.foreign += 1;
        byName[name] = entry;
      }
    }
  }
  return byName;
}

function dataOf(table, label) {
  const d = table?.data ?? table;
  if (!d || typeof d !== 'object') {
    dumpDebug(`table-${label}-unexpected`, { table });
    return null;
  }
  return d;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function numOr0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
