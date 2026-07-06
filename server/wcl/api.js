// High-level API helpers combining queries + parsing.
import { gql, dumpDebug } from './client.js';
import { ZONE_RANKINGS } from './queries.js';
import { buildOverview } from '../parse/zoneRankings.js';

async function fetchZoneRankings({ name, serverSlug, serverRegion, zoneID, metric, byBracket, role }) {
  const data = await gql(ZONE_RANKINGS, {
    name,
    serverSlug,
    serverRegion,
    zoneID,
    metric,
    byBracket: byBracket ?? false,
    role: role ?? 'Any',
  });
  const character = data?.characterData?.character;
  if (!character) {
    dumpDebug('character-not-found', { name, serverSlug, serverRegion, zoneID, data });
    throw new Error(
      `Character not found: ${name} / ${serverSlug} / ${serverRegion}. Check spelling and server slug.`
    );
  }
  return character;
}

/**
 * Fetch and parse the per-dungeon overview for a character.
 * Combines two zoneRankings payloads:
 *  - playerscore (site's Points / Runs columns)
 *  - dps, byBracket, role DPS (parse percentiles among own spec at key level)
 */
export async function fetchOverview({ name, serverSlug, serverRegion, zoneID }) {
  const base = { name, serverSlug, serverRegion, zoneID };
  const scoreChar = await fetchZoneRankings({ ...base, metric: 'playerscore' });
  const dpsChar = await fetchZoneRankings({ ...base, metric: 'dps', byBracket: true, role: 'DPS' });
  const overview = buildOverview(scoreChar.zoneRankings, dpsChar.zoneRankings);
  return {
    character: scoreChar.name ?? name,
    raw: { playerscore: scoreChar.zoneRankings, dps: dpsChar.zoneRankings },
    ...overview,
  };
}
