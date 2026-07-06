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
      composite: Boolean(e.composite),
    }))
    .sort((a, b) => b.total - a.total);
  return {
    totalTimeMs: numOrNull(d?.totalTime),
    abilities,
    totalDamage: abilities.reduce((acc, a) => acc + a.total, 0),
  };
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

// Runic Power's resourceChangeType id, verified against a real payload (see
// server/wcl/queries.js REPORT_RESOURCE_EVENTS for how this was confirmed).
const RUNIC_POWER_TYPE = 6;

/**
 * Resource (Runic Power) generation events -> gain + waste per event.
 * Filters to the player's own resource only (sourceID === targetID) so a
 * pet's separate resource pool (seen under a different resourceChangeType)
 * never leaks in.
 */
export function parseResourceEvents(eventPages) {
  const events = [];
  for (const page of eventPages) {
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const ev of data) {
      if (
        ev?.type === 'resourcechange' &&
        ev.resourceChangeType === RUNIC_POWER_TYPE &&
        ev.sourceID === ev.targetID &&
        typeof ev.timestamp === 'number'
      ) {
        events.push({
          timestamp: ev.timestamp,
          gain: numOr0(ev.resourceChange),
          waste: numOr0(ev.waste),
          abilityGameID: ev.abilityGameID ?? null,
        });
      }
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
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
