// High-level API helpers combining queries + parsing.
import { gql, dumpDebug } from './client.js';
import {
  ZONE_RANKINGS,
  ENCOUNTER_RANKINGS,
  CHARACTER_RANKINGS,
  ZONE_BRACKETS,
  REPORT_FIGHTS_ACTORS,
  REPORT_TABLE,
  REPORT_CAST_EVENTS,
  REPORT_RESOURCE_EVENTS,
} from './queries.js';
import { buildOverview } from '../parse/zoneRankings.js';
import { parseEncounterRankings, summarizeBestLevel } from '../parse/encounterRankings.js';
import { parseCharacterRankings } from '../parse/characterRankings.js';
import {
  parseCastsTable,
  parseBuffsTable,
  parseDamageTable,
  parseDeathsTable,
  parseCastEvents,
  parseResourceEvents,
} from '../parse/tables.js';

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
 * Per-dungeon overview. Combines:
 *  - zoneRankings playerscore (site Points / Runs columns)
 *  - zoneRankings dps byBracket (best DPS, key level, duration — exact)
 *  - encounterRankings per dungeon (site-accurate Best % / Median % at the
 *    displayed key level + report code of the best run + all logged runs)
 */
export async function fetchOverview({ name, serverSlug, serverRegion, zoneID }) {
  const base = { name, serverSlug, serverRegion, zoneID };
  const scoreChar = await fetchZoneRankings({ ...base, metric: 'playerscore' });
  const dpsChar = await fetchZoneRankings({ ...base, metric: 'dps', byBracket: true, role: 'DPS' });
  const overview = buildOverview(scoreChar.zoneRankings, dpsChar.zoneRankings);

  // Upgrade each dungeon with encounterRankings-derived site percentiles.
  for (const dungeon of overview.dungeons) {
    if (!dungeon.encounterID) continue;
    try {
      const er = await fetchMyEncounterRuns({ ...base, encounterID: dungeon.encounterID });
      const summary = summarizeBestLevel(er);
      dungeon.bestPercent = summary.bestPercent ?? dungeon.bestPercent;
      dungeon.medianPercent = summary.medianPercent ?? dungeon.medianPercent;
      dungeon.keyLevel = summary.keyLevel ?? dungeon.keyLevel;
      dungeon.runsAtLevel = summary.runsAtLevel;
      dungeon.bestRun = summary.bestRun;
    } catch (err) {
      dumpDebug('overview-encounterRankings-failed', {
        encounterID: dungeon.encounterID,
        error: String(err),
      });
    }
  }

  const pcts = overview.dungeons.map((d) => d.bestPercent).filter((v) => typeof v === 'number');
  const medians = overview.dungeons.map((d) => d.medianPercent).filter((v) => typeof v === 'number');
  overview.overall.bestPerformanceAverage = avg(pcts);
  overview.overall.medianPerformanceAverage = avg(medians);

  return {
    character: scoreChar.name ?? name,
    raw: { playerscore: scoreChar.zoneRankings, dps: dpsChar.zoneRankings },
    ...overview,
  };
}

/** All logged runs of my character on one encounter (parsed encounterRankings). */
export async function fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID }) {
  const data = await gql(ENCOUNTER_RANKINGS, {
    name,
    serverSlug,
    serverRegion,
    encounterID,
    metric: 'dps',
    byBracket: true,
    role: 'DPS',
  });
  const scalar = data?.characterData?.character?.encounterRankings;
  return parseEncounterRankings(scalar);
}

/** Zone bracket definition (cached). bracket arg of characterRankings is an index. */
export async function getZoneBrackets(zoneID) {
  const data = await gql(ZONE_BRACKETS, { zoneID });
  const b = data?.worldData?.zone?.brackets;
  if (!b || typeof b.min !== 'number') {
    dumpDebug('zone-brackets-unexpected', { zoneID, data });
    return { min: 2, max: 99, bucket: 1 }; // sane M+ default
  }
  return b;
}

/** Top spec players on an encounter at an exact keystone level. */
export async function fetchTopRuns({
  encounterID,
  zoneID,
  keyLevel,
  className = 'DeathKnight',
  specName = 'Unholy',
  page = 1,
}) {
  const brackets = await getZoneBrackets(zoneID);
  const bracketIndex = Math.round((keyLevel - brackets.min) / (brackets.bucket || 1)) + 1;
  const data = await gql(CHARACTER_RANKINGS, {
    encounterID,
    className,
    specName,
    bracket: bracketIndex,
    page,
    metric: 'dps',
  });
  const parsed = parseCharacterRankings(data?.worldData?.encounter?.characterRankings);
  // trust but verify the bracket->level mapping
  const offLevel = parsed.entries.filter((e) => e.keyLevel !== keyLevel);
  if (offLevel.length) {
    dumpDebug('characterRankings-bracket-mismatch', {
      encounterID,
      keyLevel,
      bracketIndex,
      sample: offLevel.slice(0, 3),
    });
  }
  return parsed;
}

/**
 * Full per-player detail for one fight: fight timing, actor resolution,
 * the four tables and the cast-event stream.
 */
export async function fetchRunDetail({ code, fightID, playerName }) {
  const rd = await gql(REPORT_FIGHTS_ACTORS, { code, fightIDs: [fightID] });
  const report = rd?.reportData?.report;
  const fight = report?.fights?.[0];
  const actors = report?.masterData?.actors ?? [];
  if (!fight) {
    dumpDebug('report-no-fight', { code, fightID, rd });
    throw new Error(`Report ${code} has no fight ${fightID}`);
  }
  const actor = resolveActor(actors, playerName);
  if (!actor) {
    dumpDebug('actor-not-resolved', { code, fightID, playerName, actors });
    throw new Error(`Player ${playerName} not found in report ${code}`);
  }

  const tableVars = { code, fightIDs: [fightID], sourceID: actor.id };
  const [castsT, buffsT, damageT, deathsT] = [
    await gql(REPORT_TABLE, { ...tableVars, dataType: 'Casts' }),
    await gql(REPORT_TABLE, { ...tableVars, dataType: 'Buffs' }),
    await gql(REPORT_TABLE, { ...tableVars, dataType: 'DamageDone' }),
    await gql(REPORT_TABLE, { ...tableVars, dataType: 'Deaths' }),
  ];

  const castPages = await paginateEvents(REPORT_CAST_EVENTS, { code, fightID, sourceID: actor.id, fight });
  const resourcePages = await paginateEvents(REPORT_RESOURCE_EVENTS, { code, fightID, sourceID: actor.id, fight });

  return {
    code,
    fightID,
    fight: {
      startTime: fight.startTime,
      endTime: fight.endTime,
      keystoneLevel: fight.keystoneLevel ?? null,
      keystoneTime: fight.keystoneTime ?? null,
      name: fight.name ?? null,
    },
    player: { id: actor.id, name: actor.name, class: actor.subType, server: actor.server },
    casts: parseCastsTable(rdTable(castsT)),
    buffs: parseBuffsTable(rdTable(buffsT)),
    damage: parseDamageTable(rdTable(damageT)),
    deaths: parseDeathsTable(rdTable(deathsT)),
    castEvents: parseCastEvents(castPages),
    resourceEvents: parseResourceEvents(resourcePages),
  };
}

function rdTable(resp) {
  return resp?.reportData?.report?.table;
}

/** Page through an events(...) query via nextPageTimestamp. */
async function paginateEvents(query, { code, fightID, sourceID, fight }) {
  const pages = [];
  let startTime = fight.startTime;
  for (let i = 0; i < 20; i++) {
    const resp = await gql(query, { code, fightIDs: [fightID], sourceID, startTime, endTime: fight.endTime });
    const pageData = resp?.reportData?.report?.events;
    if (!pageData) break;
    pages.push(pageData);
    if (!pageData.nextPageTimestamp) break;
    startTime = pageData.nextPageTimestamp;
  }
  return pages;
}

/** Match an actor by name; tolerate diacritics/server decorations. */
function resolveActor(actors, playerName) {
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  return (
    actors.find((a) => a.name === playerName) ??
    actors.find((a) => norm(a.name) === norm(playerName)) ??
    null
  );
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}
