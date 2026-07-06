// Parse the worldData.encounter.characterRankings JSON scalar: top players
// of a class/spec on one encounter at one keystone bracket.
// Shape verified against fixtures/characterRankings-pit-21.json.
import { dumpDebug } from '../wcl/client.js';

export function parseCharacterRankings(scalar) {
  if (!scalar || typeof scalar !== 'object') {
    dumpDebug('characterRankings-not-object', { scalar });
    return { page: null, hasMorePages: false, count: 0, entries: [] };
  }
  const rankings = Array.isArray(scalar.rankings) ? scalar.rankings : [];
  if (!Array.isArray(scalar.rankings)) dumpDebug('characterRankings-no-rankings', scalar);

  return {
    page: scalar.page ?? null,
    hasMorePages: Boolean(scalar.hasMorePages),
    count: typeof scalar.count === 'number' ? scalar.count : rankings.length,
    entries: rankings
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        name: r.name ?? null,
        className: r.class ?? null,
        spec: r.spec ?? null,
        dps: numOrNull(r.amount),
        durationMs: numOrNull(r.duration),
        keyLevel: numOrNull(r.bracketData),
        score: numOrNull(r.score),
        medal: r.medal ?? null,
        affixes: Array.isArray(r.affixes) ? r.affixes : [],
        server: r.server
          ? { name: r.server.name ?? null, region: r.server.region ?? null }
          : null,
        report: r.report
          ? { code: r.report.code ?? null, fightID: r.report.fightID ?? null }
          : null,
      })),
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
