// Which raids exist, and how the character parsed in each.
//
// The raid view used to be paste-a-log-only: you had to find a report URL before
// the tool would tell you anything. But your ranked KILLS are already on WCL — the
// same place the M+ overview reads from — so the default should be "here are all
// your raids and what you parsed", with the log paste kept for the one thing
// rankings genuinely cannot show: wipes.
import { gql, dumpDebug } from './client.js';
import { RAID_ZONES, ZONE_RANKINGS } from './queries.js';
import { withSpec } from './api.js';

// "Complete Raids (…)" roll-up zones live at 5xx and aggregate several raids into
// one pseudo-zone; they are not a raid you can go to.
const AGGREGATE_ZONE_MIN = 500;
const NOT_A_REAL_RAID = /\bPTR\b|\bBeta\b|Dummy/i;

// A zone's PARTITIONS are its patch history: a live raid carries real patch
// numbers ("12.0", "12.0.5", "12.0.7"), while content for the NEXT patch carries
// a "PTR"/"Beta" partition instead. That is the honest signal for "is this raid
// actually out" — the WCL API happily lists 12.1 raids months early, and matching
// on the zone NAME can't tell them apart ("The Venomous Abyss" looks like any
// other raid; only its PTR partition gives it away).
const UNRELEASED_PARTITION = /PTR|Beta|Alpha/i;

/** The patch a zone is currently on, e.g. "12.0.7". Null when it has no partitions. */
function currentPatchOf(zone) {
  const parts = zone?.partitions ?? [];
  if (!parts.length) return null;
  const def = parts.find((p) => p.default) ?? parts[parts.length - 1];
  return def?.compactName ?? def?.name ?? null;
}

/**
 * LIVE raid zones of the current expansion, newest first.
 *
 * A zone is a raid because it HAS Mythic difficulty — a dungeon zone reports
 * "Dungeon" instead. It is LIVE because its default partition is a real patch
 * rather than a PTR one. Both derived from the API, so a new tier needs no code
 * change and next-patch content never leaks in.
 */
export async function fetchRaidZones({ refresh = false } = {}) {
  const data = await gql(RAID_ZONES, {}, { noCache: refresh });
  const expansions = data?.worldData?.expansions ?? [];
  if (!expansions.length) {
    dumpDebug('raid-zones-empty', { data });
    return [];
  }
  const current = [...expansions].sort((a, b) => b.id - a.id)[0];

  const zones = (current.zones ?? []).filter((z) => {
    if (!z?.id || z.id >= AGGREGATE_ZONE_MIN) return false;
    if (NOT_A_REAL_RAID.test(z.name ?? '')) return false;
    const diffs = (z.difficulties ?? []).map((d) => d.name);
    if (!diffs.includes('Mythic')) return false; // a dungeon zone has "Dungeon"

    // Not out yet: no patch history at all, or its live partition is a PTR.
    const patch = currentPatchOf(z);
    if (!patch || UNRELEASED_PARTITION.test(patch)) return false;
    return true;
  });

  // The same raid can appear twice (a frozen past partition + the live one).
  // Keep the newest.
  const byName = new Map();
  for (const z of zones.sort((a, b) => b.id - a.id)) {
    if (!byName.has(z.name)) {
      byName.set(z.name, {
        id: z.id,
        name: z.name,
        patch: currentPatchOf(z),
        encounters: (z.encounters ?? []).map((e) => ({ id: e.id, name: e.name })),
      });
    }
  }
  return [...byName.values()];
}

/**
 * The character's parses across every raid of the current expansion.
 *
 * Uses metric:dps unbracketed — a raid "bracket" is ITEM LEVEL, and bracketing
 * across kills as you gear up makes the percentiles incomparable (the same trap
 * that made the raid parse ladder run backwards).
 */
export async function fetchRaidOverview({ name, serverSlug, serverRegion, specName = null, refresh = false }) {
  const zones = await fetchRaidZones({ refresh });
  const out = [];

  for (const zone of zones) {
    try {
      const data = await gql(
        ZONE_RANKINGS,
        withSpec(
          { name, serverSlug, serverRegion, zoneID: zone.id, metric: 'dps', byBracket: false, role: 'DPS' },
          specName
        ),
        { noCache: refresh }
      );
      const zr = data?.characterData?.character?.zoneRankings;
      const ranked = (zr?.rankings ?? []).filter((r) => r?.encounter?.id);

      // A raid you've never entered returns no rankings at all. Don't drop it —
      // list its bosses from the zone itself, so you can still see what's left.
      const bosses = ranked.length
        ? ranked.map((r) => ({
            encounterID: r.encounter.id,
            name: r.encounter.name ?? '(unknown boss)',
            kills: num(r.totalKills) ?? 0,
            bestPercent: num(r.rankPercent),
            medianPercent: num(r.medianPercent),
            bestDps: num(r.bestAmount),
          }))
        : zone.encounters.map((e) => ({
            encounterID: e.id,
            name: e.name,
            kills: 0,
            bestPercent: null,
            medianPercent: null,
            bestDps: null,
          }));

      out.push({
        zoneID: zone.id,
        zoneName: zone.name,
        patch: zone.patch,
        bestAverage: num(zr?.bestPerformanceAverage),
        bosses,
        killedCount: bosses.filter((b) => b.kills > 0).length,
        bossCount: bosses.length,
      });
    } catch (err) {
      dumpDebug('raid-overview-zone-failed', { zone: zone.id, error: String(err) });
    }
  }

  // raids you've actually set foot in first
  return out.sort((a, b) => b.killedCount - a.killedCount || b.zoneID - a.zoneID);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
