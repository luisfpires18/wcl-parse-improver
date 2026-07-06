// High-level API helpers combining queries + parsing.
import { gql, dumpDebug } from './client.js';
import { ZONE_RANKINGS } from './queries.js';
import { parseZoneRankings } from '../parse/zoneRankings.js';

/**
 * Fetch and parse the per-dungeon overview for a character.
 * @returns {{ character: string, raw: object, overall: object, dungeons: object[] }}
 */
export async function fetchOverview({ name, serverSlug, serverRegion, zoneID }) {
  const data = await gql(ZONE_RANKINGS, { name, serverSlug, serverRegion, zoneID });
  const character = data?.characterData?.character;
  if (!character) {
    dumpDebug('character-not-found', { name, serverSlug, serverRegion, zoneID, data });
    throw new Error(
      `Character not found: ${name} / ${serverSlug} / ${serverRegion}. Check spelling and server slug.`
    );
  }
  const { overall, dungeons } = parseZoneRankings(character.zoneRankings);
  return { character: character.name, raw: character.zoneRankings, overall, dungeons };
}
