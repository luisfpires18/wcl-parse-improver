// High-level API helpers combining queries + parsing.
import { gql, dumpDebug, readDerivedCache, writeDerivedCache } from './client.js';
import {
  ZONE_RANKINGS,
  ENCOUNTER_RANKINGS,
  CHARACTER_RANKINGS,
  ZONE_BRACKETS,
  GAME_CLASSES,
  CURRENT_USER,
  CURRENT_USER_CHARACTERS,
  REPORT_FIGHTS_ACTORS,
  REPORT_BOSS_FIGHTS,
  RAID_CHARACTER_RANKINGS,
  REPORT_TABLE,
  REPORT_FIGHT_DEATHS,
  REPORT_ENEMY_ACTORS,
  REPORT_DAMAGE_TAKEN_GRAPH,
  REPORT_CAST_EVENTS,
  REPORT_RESOURCE_EVENTS,
  REPORT_BUFF_SOURCE_EVENTS,
  REPORT_DAMAGE_EVENTS,
  REPORT_COMBATANT_INFO,
} from './queries.js';
import { roleOf } from './specs.js';
import { buildOverview } from '../parse/zoneRankings.js';
import { parseEncounterRankings, summarizeBestLevel } from '../parse/encounterRankings.js';
import { parseCharacterRankings } from '../parse/characterRankings.js';
import { parseReportFights, difficultyName } from '../parse/reportFights.js';
import { sumGraphSeries, buildHealthCurve, resolveBossActor } from '../parse/bossHealth.js';
import {
  parseCastsTable,
  parseBuffsTable,
  parseDamageTable,
  parseDeathsTable,
  parseCastEvents,
  parseResourceEvents,
  parseFightDeaths,
  classifyBuffSources,
  binDamageEvents,
} from '../parse/tables.js';

// WCL answers `specName: null` with an Internal server error — the argument
// must be omitted entirely to mean "all specs", not passed as null. Exported
// only so a test can pin this down; it is otherwise an internal detail.
export const withSpec = (vars, specName) => (specName ? { ...vars, specName } : vars);

async function fetchZoneRankings({ name, serverSlug, serverRegion, zoneID, metric, byBracket, role, specName, refresh }) {
  const data = await gql(
    ZONE_RANKINGS,
    withSpec(
      {
        name,
        serverSlug,
        serverRegion,
        zoneID,
        metric,
        byBracket: byBracket ?? false,
        role: role ?? 'Any',
      },
      specName
    ),
    { noCache: refresh }
  );
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
 *
 * `refresh` bypasses the disk cache for these ranking queries only — use it
 * after logging new runs. Report *contents* never change, so this stays
 * cheap; a new best run simply yields a new report code that's a cache miss.
 */
export async function fetchOverview({ name, serverSlug, serverRegion, zoneID, specName = null, refresh = false }) {
  const base = { name, serverSlug, serverRegion, zoneID, specName, refresh };
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

/**
 * All logged runs of my character on one encounter (parsed encounterRankings).
 *
 * `byBracket` makes rankPercent relative to the run's bracket. For M+ that's the
 * KEY LEVEL, which is what we want — a +20 parse is only comparable to other +20s.
 * For a RAID the bracket is ITEM LEVEL, and bracketing there is actively harmful:
 * each kill lands in a different ilvl bracket as you gear up, so the resulting
 * percentiles are each measured against a different population and the
 * DPS<->percentile relationship they imply is garbage (it produced "blue needs
 * LESS DPS than the green kill you just did"). Raid callers pass byBracket:false
 * to get the plain, population-wide percentile.
 */
export async function fetchMyEncounterRuns({ name, serverSlug, serverRegion, encounterID, specName = null, byBracket = true, refresh = false }) {
  const data = await gql(
    ENCOUNTER_RANKINGS,
    withSpec(
      {
        name,
        serverSlug,
        serverRegion,
        encounterID,
        metric: 'dps',
        byBracket,
        role: 'DPS',
      },
      specName
    ),
    { noCache: refresh }
  );
  const scalar = data?.characterData?.character?.encounterRankings;
  return parseEncounterRankings(scalar);
}

/**
 * All classes + their specs, keyed by classID (which is what Character.classID
 * holds). Game data only changes on patches, so this sits in the disk cache.
 *
 * @returns {Promise<Map<number, {id:number, slug:string, name:string, specs:{name:string, slug:string}[]}>>}
 */
export async function fetchGameClasses({ refresh = false } = {}) {
  const data = await gql(GAME_CLASSES, {}, { noCache: refresh });
  const classes = data?.gameData?.classes;
  if (!Array.isArray(classes) || !classes.length) {
    dumpDebug('game-classes-unexpected', { data });
    throw new Error('Could not load class list from Warcraft Logs');
  }
  return new Map(
    classes.map((c) => [
      c.id,
      {
        id: c.id,
        slug: c.slug,
        name: c.name,
        specs: (c.specs ?? []).map((s) => ({ name: s.name, slug: s.slug })),
      },
    ])
  );
}

/**
 * The best M+ score per spec, from zoneRankings.allStars.
 *
 * allStars can carry the SAME spec more than once — one entry per partition (a
 * mid-season rebalance splits the season's rankings in two). Left alone that
 * shows up as "Enhancement, Enhancement" on the roster. We keep the highest
 * score per spec, which is also the number the player would quote.
 */
function bestScorePerSpec(zoneRankings) {
  const best = new Map();
  for (const a of zoneRankings?.allStars ?? []) {
    const points = a?.points ?? 0;
    if (!a?.spec) continue;
    if (!best.has(a.spec) || points > best.get(a.spec)) best.set(a.spec, points);
  }
  return best;
}

/**
 * Turn a raw Character (classID + zoneRankings) into the shape the roster renders.
 *
 * `specs[].slug` is what every downstream API call must use as `specName`;
 * `specs[].name` is display-only. `hasLogs` comes from zoneRankings.allStars,
 * which reports specs in slug form — and, since we ask with `role: Any`, covers
 * tank and healer specs too, not only damage ones.
 */
function describeCharacter(character, klass) {
  const scores = bestScorePerSpec(character.zoneRankings);

  const specs = klass.specs.map((s) => ({
    name: s.name,
    slug: s.slug,
    role: roleOf(klass.slug, s.slug),
    hasLogs: scores.has(s.slug),
    points: scores.get(s.slug) ?? null,
  }));

  // What the player means by "my rating": the best spec's score, not the sum of
  // every spec they have ever pressed a button in.
  const played = specs.filter((s) => s.hasLogs);
  const mplusRating = played.length ? Math.max(...played.map((s) => s.points ?? 0)) : null;

  return {
    name: character.name,
    classID: character.classID,
    className: klass.slug, // what the API wants
    classLabel: klass.name, // what the user reads
    specs,
    mplusRating,
  };
}

/**
 * Who owns this token. The /user endpoint is the only one that answers
 * currentUser — on the public endpoint it comes back null, which is why a
 * missing user here means the token is wrong, not that the account is empty.
 */
export async function fetchCurrentUser(userToken) {
  const data = await gql(CURRENT_USER, {}, { userToken });
  const user = data?.userData?.currentUser;
  if (!user?.id) {
    dumpDebug('current-user-unexpected', { data });
    throw new Error('Warcraft Logs did not say who signed in — the token may be invalid.');
  }
  return { id: String(user.id), name: user.name ?? 'Unknown', avatar: user.avatar ?? null };
}

/**
 * Every character the signed-in user has claimed on their WCL profile, already
 * in the detected shape — this is the manual add form, answered from the source.
 * A character whose class we can't resolve is skipped rather than fatal: one odd
 * entry should not sink the whole import.
 */
export async function fetchClaimedCharacters({ userToken, zoneID }) {
  const data = await gql(CURRENT_USER_CHARACTERS, { zoneID }, { userToken });
  const user = data?.userData?.currentUser;
  if (!user?.id) {
    dumpDebug('current-user-unexpected', { data });
    throw new Error('Warcraft Logs did not say who signed in — the token may be invalid.');
  }

  const classes = await fetchGameClasses();
  const characters = [];
  const skipped = [];

  for (const c of user.characters ?? []) {
    const server = c?.server?.slug;
    const region = c?.server?.region?.slug;
    const klass = classes.get(c?.classID);
    if (!klass) {
      skipped.push({ name: c?.name ?? '?', server, reason: `unknown class ID ${c?.classID}` });
      continue;
    }
    if (!server || !region) {
      skipped.push({ name: c.name, reason: 'no server on the WCL profile' });
      continue;
    }
    // Item level is only in the Blizzard passthrough. `average_item_level`
    // counts what's in the bags for empty slots; `equipped_item_level` is what
    // the character is actually wearing, which is the honest number.
    const profile = c?.gameData?.global ?? {};
    characters.push({
      ...describeCharacter(c, klass),
      server,
      region: region.toUpperCase(),
      level: c.level ?? profile.level ?? null,
      itemLevel: profile.equipped_item_level ?? profile.average_item_level ?? null,
      zone: zoneID,
    });
  }

  return {
    user: { id: String(user.id), name: user.name ?? 'Unknown', avatar: user.avatar ?? null },
    characters,
    skipped,
  };
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
  refresh = false,
}) {
  const brackets = await getZoneBrackets(zoneID); // bracket defs never change — always cached
  const bracketIndex = Math.round((keyLevel - brackets.min) / (brackets.bucket || 1)) + 1;
  const data = await gql(
    CHARACTER_RANKINGS,
    {
      encounterID,
      className,
      specName,
      bracket: bracketIndex,
      page,
      metric: 'dps',
    },
    { noCache: refresh }
  );
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
 * Every boss fight in a report — kills AND wipes — plus the report's actors.
 * `encounterID` (optional) narrows to one boss at the API level. This is the
 * only path to no-kill data: wipes are absent from every ranking.
 */
export async function fetchReportFights({ code, encounterID = null, refresh = false }) {
  const vars = encounterID ? { code, encounterID } : { code };
  const data = await gql(REPORT_BOSS_FIGHTS, vars, { noCache: refresh });
  const report = data?.reportData?.report;
  if (!report) {
    dumpDebug('report-fights-null', { code, encounterID, data });
    throw new Error(`Report ${code} not found or has no fights (check the code).`);
  }
  return parseReportFights(report);
}

/**
 * Every player's deaths across a set of fights, grouped by fight id. One call
 * covers a whole raid night's analysed pulls (each death carries its `fight`),
 * so placing a player's death against the raid's cascade costs a single query.
 * @returns {Map<number, {name:string, id:number, timestamp:number}[]>}
 */
export async function fetchFightDeaths({ code, fightIDs, refresh = false }) {
  const data = await gql(REPORT_FIGHT_DEATHS, { code, fightIDs }, { noCache: refresh });
  const deaths = parseFightDeaths(data?.reportData?.report?.table);
  const byFight = new Map();
  for (const d of deaths) {
    if (d.fight == null) continue;
    if (!byFight.has(d.fight)) byFight.set(d.fight, []);
    byFight.get(d.fight).push(d);
  }
  return byFight;
}

/**
 * Boss health % over time for one fight (works on wipes as well as kills).
 * Cached as a derived value — the underlying graph is already binned by WCL, but
 * this saves the round trip and the calibration.
 * @returns {Promise<{points:{tSec,pct}[], endPct:number, boss:string}|null>}
 */
export async function fetchBossHealth({ code, fightID, refresh = false }) {
  const cacheKey = `bosshp-${code}-${fightID}`;
  if (!refresh) {
    const cached = readDerivedCache(cacheKey);
    if (cached) return cached;
  }

  const meta = await gql(REPORT_ENEMY_ACTORS, { code, fightIDs: [fightID] }, { noCache: refresh });
  const report = meta?.reportData?.report;
  const fight = report?.fights?.[0];
  if (!fight) {
    dumpDebug('boss-health-no-fight', { code, fightID });
    return null;
  }
  const boss = resolveBossActor(report?.masterData?.actors ?? [], fight.name);
  if (!boss) return null;

  const g = await gql(
    REPORT_DAMAGE_TAKEN_GRAPH,
    { code, fightIDs: [fightID], targetID: boss.id, startTime: fight.startTime, endTime: fight.endTime },
    { noCache: refresh }
  );
  const summed = sumGraphSeries(g?.reportData?.report?.graph);
  const pctRemaining = firstNum(fight.fightPercentage, fight.bossPercentage, fight.kill ? 0 : null);
  const curve = buildHealthCurve({ summed, fightStart: fight.startTime, pctRemaining });
  if (!curve) return null;

  const out = { points: curve.points, endPct: curve.endPct, boss: boss.name };
  writeDerivedCache(cacheKey, out);
  return out;
}

const firstNum = (...vs) => {
  for (const v of vs) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
};

/**
 * Ranked KILLS of a raid boss at a difficulty. One cheap, cached call — it fills
 * the opponent dropdown. This used to fetch the whole page and then throw away
 * every entry but the first, so the raid view had no picker at all.
 *
 * Kills only: a wipe appears in no ranking anywhere.
 */
export async function fetchRaidRankings({ encounterID, className, specName, difficulty, page = 1, refresh = false }) {
  const data = await gql(
    RAID_CHARACTER_RANKINGS,
    { encounterID, className, specName, difficulty, page, metric: 'dps' },
    { noCache: refresh }
  );
  const parsed = parseCharacterRankings(data?.worldData?.encounter?.characterRankings);
  const entries = parsed.entries.filter((e) => e.name && e.report?.code && e.report?.fightID != null);
  if (!entries.length) {
    throw new Error(`No ranked ${difficultyName(difficulty) ?? ''} kill for encounter ${encounterID} / ${specName}`);
  }
  return entries;
}

/**
 * One ranked opponent + their full run detail. Defaults to the #1 parse; pass
 * `compareTo` to pick anyone else off the ranked page.
 */
export async function fetchRaidBenchmark({ encounterID, className, specName, difficulty, compareTo = null, refresh = false }) {
  const entries = await fetchRaidRankings({ encounterID, className, specName, difficulty, refresh });
  const norm = (s) => String(s ?? '').trim().toLowerCase();

  let pick = entries[0];
  if (compareTo) {
    // Never substitute silently. This used to fall back to entries[0] when the
    // requested player wasn't on the ranked page, so you could pick one player
    // from the dropdown and be shown a DIFFERENT player's casts and cooldowns —
    // then reasonably conclude "their potion isn't showing" when in fact you were
    // looking at someone else entirely.
    const found = entries.find((e) => norm(e.name) === norm(compareTo));
    if (!found) {
      const err = new Error(
        `${compareTo} isn't among the ranked ${difficultyName(difficulty) ?? ''} kills for this boss, so there's nothing to compare against. ` +
          `Pick someone from the list.`
      );
      err.status = 400;
      throw err;
    }
    pick = found;
  }

  const detail = await fetchRunDetail({ code: pick.report.code, fightID: pick.report.fightID, playerName: pick.name, includeGear: true });
  return { name: pick.name, difficultyName: difficultyName(difficulty), dps: pick.dps, detail, entries };
}

/**
 * Full per-player detail for one fight: fight timing, actor resolution,
 * the four tables and the cast-event stream.
 *
 * `includeBuffSources` additionally fetches buff apply/remove events and
 * classifies each aura as self- or externally-applied (see
 * classifyBuffSources). Only needed for "mine" — the classification is a
 * property of the ability itself (can a DK ever self-cast it), not of one
 * specific run, so fetching it once is enough.
 */
export async function fetchRunDetail({ code, fightID, playerName, server = null, className = null, includeBuffSources = false, includeGear = false, lite = false, castsOnly = false }) {
  const rd = await gql(REPORT_FIGHTS_ACTORS, { code, fightIDs: [fightID] });
  const report = rd?.reportData?.report;
  const fight = report?.fights?.[0];
  const actors = report?.masterData?.actors ?? [];
  if (!fight) {
    dumpDebug('report-no-fight', { code, fightID, rd });
    throw new Error(`Report ${code} has no fight ${fightID}`);
  }
  const actor = resolveActor(actors, playerName, { server, className });
  if (!actor) {
    dumpDebug('actor-not-resolved', { code, fightID, playerName, actors });
    throw new Error(`Player ${playerName} not found in report ${code}`);
  }

  const tableVars = { code, fightIDs: [fightID], sourceID: actor.id };
  // `lite` skips the two heavy per-event paginations (casts + resources) and
  // the Buffs table — everything a per-pull output/consistency read doesn't
  // need. It cuts a full run's ~7 requests (with multi-page event streams) down
  // to 3 table calls, so every pull of a raid night can be analysed, not just a
  // sample. The full fetch is reserved for the one pull compared to a top parser.
  //
  // `castsOnly` is the opposite trade: keep everything castOrder() reads (the Casts
  // table names the presses, DamageDone separates fillers from cooldowns, Buffs
  // recovers potions with no cast event, and the event stream gives the order) and
  // drop the rest. It's what makes fetching TEN top players' rotations affordable:
  // ~5 requests each instead of ~7, with no death or resource data pulled that a
  // rotation-only view would never show.
  const castsT = await gql(REPORT_TABLE, { ...tableVars, dataType: 'Casts' });
  const damageT = await gql(REPORT_TABLE, { ...tableVars, dataType: 'DamageDone' });
  // NB: `lite` still fetches Deaths — per-pull death timing is the whole point of it.
  const deathsT = castsOnly ? null : await gql(REPORT_TABLE, { ...tableVars, dataType: 'Deaths' });
  const buffsT = lite ? null : await gql(REPORT_TABLE, { ...tableVars, dataType: 'Buffs' });

  const castPages = lite ? [] : await paginateEvents(REPORT_CAST_EVENTS, { code, fightID, sourceID: actor.id, fight });
  const resourcePages =
    lite || castsOnly ? [] : await paginateEvents(REPORT_RESOURCE_EVENTS, { code, fightID, sourceID: actor.id, fight });

  let buffSources = null;
  if (includeBuffSources && !lite) {
    const abilityNameByGameID = new Map(
      (report?.masterData?.abilities ?? []).map((a) => [a.gameID, a.name])
    );
    const buffSourcePages = await paginateEvents(REPORT_BUFF_SOURCE_EVENTS, {
      code,
      fightID,
      sourceID: actor.id,
      fight,
    });
    buffSources = classifyBuffSources(buffSourcePages, actor.id, abilityNameByGameID);
  }

  // Gear (with enchants + gems) for the gear check. One event query; only for the
  // full report path (mine + the compared player), never the lite per-pull scan.
  let gear = null;
  if (includeGear && !lite) {
    const ci = await gql(REPORT_COMBATANT_INFO, { code, fightIDs: [fightID] });
    gear = parseGear(ci?.reportData?.report?.events?.data ?? [], actor.id);
  }

  return {
    code,
    fightID,
    fight: {
      startTime: fight.startTime,
      endTime: fight.endTime,
      keystoneLevel: fight.keystoneLevel ?? null,
      keystoneTime: fight.keystoneTime ?? null,
      name: fight.name ?? null,
      // A completed M+ has no `kill` flag but always reads as a kill; a raid pull
      // does. Deaths only make sense as a gap on a kill (on a wipe everyone dies).
      kill: fight.kill ?? (fight.keystoneTime > 0),
    },
    player: { id: actor.id, name: actor.name, class: actor.subType, server: actor.server },
    casts: parseCastsTable(rdTable(castsT)),
    buffs: buffsT ? parseBuffsTable(rdTable(buffsT)) : { totalTimeMs: null, auras: [] },
    damage: parseDamageTable(rdTable(damageT)),
    deaths: deathsT ? parseDeathsTable(rdTable(deathsT)) : { deaths: [] },
    castEvents: parseCastEvents(castPages),
    resourceEvents: parseResourceEvents(resourcePages),
    buffSources,
    gear,
  };
}

function rdTable(resp) {
  return resp?.reportData?.report?.table;
}

// The CombatantInfo snapshot for one player, as a compact per-slot gear list.
// Cosmetic slots (shirt 3, tabard 17) carry no enchant or gem and are dropped.
const COSMETIC_SLOTS = new Set([3, 17]);
function parseGear(events, sourceID) {
  const info = events.find((e) => e?.sourceID === sourceID && Array.isArray(e.gear));
  if (!info) return null;
  const items = [];
  info.gear.forEach((it, slot) => {
    if (!it?.id || COSMETIC_SLOTS.has(slot)) return;
    items.push({
      slot,
      id: it.id,
      itemLevel: it.itemLevel ?? null,
      enchant: it.permanentEnchant ?? 0,
      gems: (it.gems ?? []).length,
    });
  });
  return items;
}

/**
 * DPS-over-time series for one player's run (the DPS line chart).
 * Fetches DamageDone events (sourceID = the player, which already folds in
 * their pets), bins into `binMs` buckets, and returns the compact series.
 *
 * The raw event stream is huge (~tens of thousands of events, ~15MB), so it
 * is fetched with noCache (never persisted) and only the small binned series
 * is cached, keyed by report+fight+bin.
 *
 * @returns {{ label, durationMs, binMs, points:{tSec,dps}[], totalDamage }}
 */
export async function fetchDamageSeries({ code, fightID, playerName, server = null, className = null, binMs = 5000 }) {
  // Key by player+server too: one report+fight can hold two same-named actors
  // (see resolveActor), so a player-agnostic key would serve the wrong toon's
  // cached series.
  const who = `${playerName}@${server ?? ''}`.toLowerCase();
  const cacheKey = `dps-${code}-${fightID}-${binMs}-${who}`;
  const cached = readDerivedCache(cacheKey);
  if (cached) return cached;

  const rd = await gql(REPORT_FIGHTS_ACTORS, { code, fightIDs: [fightID] });
  const report = rd?.reportData?.report;
  const fight = report?.fights?.[0];
  const actor = resolveActor(report?.masterData?.actors ?? [], playerName, { server, className });
  if (!fight || !actor) {
    dumpDebug('dps-series-unresolved', { code, fightID, playerName });
    throw new Error(`Cannot build DPS series: run ${code}#${fightID} / ${playerName} not resolved`);
  }

  // noCache: don't persist the multi-MB raw event blob — we cache the series below
  const pages = await paginateEvents(REPORT_DAMAGE_EVENTS, {
    code,
    fightID,
    sourceID: actor.id,
    fight,
    noCache: true,
  });
  const binned = binDamageEvents(pages, fight, binMs);
  const series = {
    label: actor.name,
    durationMs: fight.endTime - fight.startTime,
    ...binned,
  };
  writeDerivedCache(cacheKey, series);
  return series;
}

/** Page through an events(...) query via nextPageTimestamp. */
async function paginateEvents(query, { code, fightID, sourceID, fight, noCache = false }) {
  const pages = [];
  let startTime = fight.startTime;
  for (let i = 0; i < 20; i++) {
    const resp = await gql(query, { code, fightIDs: [fightID], sourceID, startTime, endTime: fight.endTime }, { noCache });
    const pageData = resp?.reportData?.report?.events;
    if (!pageData) break;
    pages.push(pageData);
    if (!pageData.nextPageTimestamp) break;
    startTime = pageData.nextPageTimestamp;
  }
  return pages;
}

/**
 * Match an actor by name; tolerate diacritics/server decorations. When a log
 * contains more than one actor with the same name — e.g. the user has a Death
 * Knight and a Demon Hunter both called "Unreally" that appear in the same
 * report — disambiguate by server, then class, using the caller's known
 * character. Without this the first same-named actor wins and the wrong toon's
 * (empty) casts get used, zeroing every "mine" metric.
 */
export function resolveActor(actors, playerName, { server = null, className = null } = {}) {
  const norm = (s) =>
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const slug = (s) => norm(s).replace(/[^a-z0-9]/g, ''); // "Grim Batol" ~ "grim-batol"
  const named = actors.filter((a) => a.name === playerName || norm(a.name) === norm(playerName));
  if (named.length <= 1) return named[0] ?? null;
  const wantServer = server ? slug(server) : null;
  const wantClass = className ? slug(className) : null;
  return (
    (wantServer && named.find((a) => slug(a.server) === wantServer)) ||
    (wantClass && named.find((a) => slug(a.subType) === wantClass)) ||
    named[0]
  );
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}
