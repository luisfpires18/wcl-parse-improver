// GraphQL query strings for the Warcraft Logs v2 client API.
// zoneRankings / encounterRankings / characterRankings / table / events are
// loosely-typed JSON scalars — parse them defensively (see server/parse/).

// specName narrows the character's own rankings to a single spec (e.g. only
// Havoc, not Devourer). Optional — null returns the character's best across
// all specs (the old behaviour).
export const ZONE_RANKINGS = `
query ZoneRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!, $metric: CharacterPageRankingMetricType, $byBracket: Boolean, $role: RoleType, $specName: String) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      zoneRankings(zoneID: $zoneID, metric: $metric, byBracket: $byBracket, role: $role, specName: $specName)
    }
  }
}`;

// ranks[] = every logged run of this character on this encounter, with
// bracketData (key level), rankPercent (parse percentile within bracket)
// and report{code,fightID}.
export const ENCOUNTER_RANKINGS = `
query EncounterRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $encounterID: Int!, $metric: CharacterRankingMetricType, $byBracket: Boolean, $role: RoleType, $specName: String) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      encounterRankings(encounterID: $encounterID, metric: $metric, byBracket: $byBracket, role: $role, specName: $specName)
    }
  }
}`;

// bracket is an INDEX into the zone's bracket list, not the key level itself.
// For zone 47 (min level 2, bucket 1): bracketIndex = keyLevel - 1. Verified
// empirically: bracket 20 -> all bracketData 21, bracket 21 -> all 22.
export const CHARACTER_RANKINGS = `
query CharacterRankings($encounterID: Int!, $className: String!, $specName: String!, $bracket: Int, $page: Int, $metric: CharacterRankingMetricType) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(className: $className, specName: $specName, bracket: $bracket, page: $page, metric: $metric)
    }
  }
}`;

// Static game data — all 13 classes with their specs. `class.slug` is exactly
// the `className` that characterRankings expects ("DeathKnight"), and
// `spec.slug` is exactly the `specName` ("BeastMastery" — NOT the display name
// "Beast Mastery", which characterRankings silently answers with 0 rankings).
// Changes only on game patches, so the disk cache holds it indefinitely.
export const GAME_CLASSES = `
query GameClasses {
  gameData {
    classes {
      id
      name
      slug
      specs { id name slug }
    }
  }
}`;

// Who is signed in. Only answers on the /user endpoint, with a user token —
// on the public endpoint currentUser is always null.
export const CURRENT_USER = `
query CurrentUser {
  userData {
    currentUser {
      id
      name
      avatar
    }
  }
}`;

// The signed-in user's claimed characters — the whole point of logging in, and
// the only way characters get onto the roster. The server slug comes back
// correctly spelled (the one field a human typing a form reliably gets wrong),
// and zoneRankings.allStars says which specs actually have logged runs.
// One round trip for the entire roster.
//
// `role: Any` (not DPS) is what makes tanks and healers show up at all — with
// role: DPS, allStars only carries the character's damage specs. `playerscore`
// is the M+ score per spec: allStars[].points is the number people mean by "my
// rating" (the best spec's, not the sum).
//
// `gameData` is a Blizzard profile passthrough and the only source of item
// level. It is also enormous — asking for it takes the roster from ~75 KB to
// ~5.8 MB and 0.6s to 2.6s. That's affordable exactly because import is a
// button, not a page load. Don't move this query anywhere hot.
export const CURRENT_USER_CHARACTERS = `
query CurrentUserCharacters($zoneID: Int!) {
  userData {
    currentUser {
      id
      name
      avatar
      characters {
        id
        name
        level
        classID
        server {
          slug
          region { slug }
        }
        gameData
        zoneRankings(zoneID: $zoneID, metric: playerscore, role: Any)
      }
    }
  }
}`;

// Every zone of every expansion, with its difficulties — used to work out which
// zones are RAIDS (they have a Mythic difficulty; a dungeon zone has "Dungeon").
// Static game data, so the disk cache holds it until a patch adds a tier.
export const RAID_ZONES = `
query RaidZones {
  worldData {
    expansions {
      id
      name
      zones {
        id
        name
        frozen
        # a zone's partitions are its patch history ("12.0", "12.0.5", "12.0.7").
        # Next-patch content carries a "PTR"/"Beta" partition instead — that is
        # how a live raid is told apart from one that isn't out yet.
        partitions { id name compactName default }
        difficulties { id name }
        encounters { id name }
      }
    }
  }
}`;

export const ZONE_BRACKETS = `
query ZoneBrackets($zoneID: Int!) {
  worldData {
    zone(id: $zoneID) {
      name
      brackets { type min max bucket }
    }
  }
}`;

export const REPORT_FIGHTS_ACTORS = `
query ReportFightsActors($code: String!, $fightIDs: [Int!]) {
  reportData {
    report(code: $code) {
      fights(fightIDs: $fightIDs) { id startTime endTime keystoneLevel keystoneTime kill name }
      masterData(translate: true) {
        actors(type: "Player") { id name subType server }
        abilities { gameID name }
      }
    }
  }
}`;

// All boss fights in a report — kills AND wipes — for raid progression. Unlike
// REPORT_FIGHTS_ACTORS (which pins specific fightIDs), this lists every fight so
// wipes (kill:false), which never appear in any ranking, are discoverable.
// `fightPercentage` = boss health % REMAINING when the fight ended (0 on a kill);
// `bossPercentage` is the same for the current boss in multi-boss encounters.
// Trash fights come back with encounterID 0 and are filtered out downstream.
export const REPORT_BOSS_FIGHTS = `
query ReportBossFights($code: String!, $encounterID: Int) {
  reportData {
    report(code: $code) {
      title
      startTime
      zone { id name }
      fights(encounterID: $encounterID, translate: true) {
        id
        encounterID
        name
        kill
        difficulty
        fightPercentage
        bossPercentage
        lastPhase
        startTime
        endTime
      }
      masterData(translate: true) {
        actors(type: "Player") { id name subType server }
      }
    }
  }
}`;

// Top ranked players on a RAID boss at a given difficulty (3 Normal / 4 Heroic /
// 5 Mythic). Mirrors CHARACTER_RANKINGS but keyed by `difficulty` instead of the
// M+ `bracket` (keystone level) — raids have no keystones. Only KILLS are ranked,
// so this is the kill benchmark, never a wipe cohort.
export const RAID_CHARACTER_RANKINGS = `
query RaidCharacterRankings($encounterID: Int!, $className: String!, $specName: String!, $difficulty: Int, $page: Int, $metric: CharacterRankingMetricType) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(className: $className, specName: $specName, difficulty: $difficulty, page: $page, metric: $metric)
    }
  }
}`;

export const REPORT_TABLE = `
query ReportTable($code: String!, $fightIDs: [Int!], $dataType: TableDataType!, $sourceID: Int!) {
  reportData {
    report(code: $code) {
      table(fightIDs: $fightIDs, dataType: $dataType, sourceID: $sourceID)
    }
  }
}`;

// Gear (with enchants + gems) at pull start, for every player. CombatantInfo is a
// per-player snapshot event; we pick the one matching the actor's sourceID. This
// is the only source of gear — the tables carry none. The gear check reads it.
export const REPORT_COMBATANT_INFO = `
query ReportCombatantInfo($code: String!, $fightIDs: [Int!]) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: CombatantInfo, limit: 100) { data }
    }
  }
}`;

// Enemy (NPC) actors + fight timing — used to resolve which NPC is the boss so
// its health curve can be reconstructed. Player actors come from
// REPORT_FIGHTS_ACTORS; this is the enemy side.
export const REPORT_ENEMY_ACTORS = `
query ReportEnemyActors($code: String!, $fightIDs: [Int!]) {
  reportData {
    report(code: $code) {
      fights(fightIDs: $fightIDs) { id name startTime endTime kill fightPercentage bossPercentage }
      masterData(translate: true) {
        actors(type: "NPC") { id name gameID }
      }
    }
  }
}`;

// Binned damage-TAKEN on one target (the boss), server-side aggregated into
// per-source series. Summing the series bin-by-bin gives total damage on the
// boss over time — which, calibrated against WCL's own fightPercentage (how much
// boss health was left when the fight ended), yields a boss-health curve without
// pulling the raw multi-MB event stream. WCL exposes no direct boss-HP field
// (verified: damage/resource events carry no hitPoints for enemies).
export const REPORT_DAMAGE_TAKEN_GRAPH = `
query ReportDamageTakenGraph($code: String!, $fightIDs: [Int!], $targetID: Int, $startTime: Float, $endTime: Float) {
  reportData {
    report(code: $code) {
      graph(fightIDs: $fightIDs, dataType: DamageTaken, targetID: $targetID, startTime: $startTime, endTime: $endTime)
    }
  }
}`;

// The fight's player roster WITH SPEC. masterData.actors only carries the class
// (subType), never the spec — but a pasted log analysed against the wrong spec is
// worthless, so we need both. `playerDetails` in the Summary table has each
// player's class (`type`) and `specs`.
export const REPORT_SUMMARY = `
query ReportSummary($code: String!, $fightIDs: [Int!]) {
  reportData {
    report(code: $code) {
      table(fightIDs: $fightIDs, dataType: Summary)
    }
  }
}`;

// Deaths for the WHOLE raid across one or more fights (no sourceID → every
// player's deaths). Each entry carries a `fight` field, so one call over all
// analysed fightIDs returns the full death cascade per pull — used to tell "you
// died early (before the raid)" from "you went down with the raid".
export const REPORT_FIGHT_DEATHS = `
query ReportFightDeaths($code: String!, $fightIDs: [Int!]) {
  reportData {
    report(code: $code) {
      table(fightIDs: $fightIDs, dataType: Deaths)
    }
  }
}`;

export const REPORT_CAST_EVENTS = `
query ReportCastEvents($code: String!, $fightIDs: [Int!], $sourceID: Int!, $startTime: Float, $endTime: Float) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: Casts, sourceID: $sourceID, startTime: $startTime, endTime: $endTime) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

// Resource generation events. Each entry is a GAIN with WCL's own computed
// `waste` field (how much of that gain exceeded the resource cap) — verified
// against a real Pit of Saron payload: resourceChangeType 6 = the player's
// own Runic Power (maxResourceAmount 1000 = 100.0 RP scaled x10, sourceID
// always === targetID). No negative (spend) events appear in this stream —
// only generation, which is exactly what's needed for a waste metric.
// Other resourceChangeType values seen (e.g. 3, targetID = a pet) are a
// different actor's resource and are filtered out downstream, not ours.
export const REPORT_RESOURCE_EVENTS = `
query ReportResourceEvents($code: String!, $fightIDs: [Int!], $sourceID: Int!, $startTime: Float, $endTime: Float) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: Resources, sourceID: $sourceID, startTime: $startTime, endTime: $endTime) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

// DamageDone events for one player. sourceID = the player's actor id already
// folds in that player's pets (verified: Magus/ghoul abilities come back
// under the player's sourceID), so a single query covers total output. Used
// to build the DPS-over-time line; pages are large (a full run can be tens
// of thousands of events in one page), so this is a couple of requests, not
// hundreds. Bin immediately and cache only the small binned series — never
// the raw event blob (it can be ~15MB).
export const REPORT_DAMAGE_EVENTS = `
query ReportDamageEvents($code: String!, $fightIDs: [Int!], $sourceID: Int!, $startTime: Float, $endTime: Float) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: DamageDone, sourceID: $sourceID, startTime: $startTime, endTime: $endTime) {
        data
        nextPageTimestamp
      }
    }
  }
}`;

// Buff apply/remove/refresh events, sourceID here means "whose aura uptime
// we're viewing" (matches table(dataType:Buffs, sourceID) semantics) — each
// returned event ALSO carries its own sourceID, the actor who cast/applied
// it. Verified on a real payload: for Black Attunement (an Augmentation
// Evoker buff) every applybuff/removebuff event on me had event.sourceID
// pointing at a groupmate, never me; for a self-buff like Dark
// Transformation every event was self-sourced (72/72). That's the
// discriminator used to keep external raid buffs out of "fix your rotation"
// advice regardless of how much uptime I happened to have.
export const REPORT_BUFF_SOURCE_EVENTS = `
query ReportBuffSourceEvents($code: String!, $fightIDs: [Int!], $sourceID: Int!, $startTime: Float, $endTime: Float) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: Buffs, sourceID: $sourceID, startTime: $startTime, endTime: $endTime) {
        data
        nextPageTimestamp
      }
    }
  }
}`;
