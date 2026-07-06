// GraphQL query strings for the Warcraft Logs v2 client API.
// zoneRankings / encounterRankings / characterRankings / table / events are
// loosely-typed JSON scalars — parse them defensively (see server/parse/).

export const ZONE_RANKINGS = `
query ZoneRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!, $metric: CharacterPageRankingMetricType, $byBracket: Boolean, $role: RoleType) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      zoneRankings(zoneID: $zoneID, metric: $metric, byBracket: $byBracket, role: $role)
    }
  }
}`;

// ranks[] = every logged run of this character on this encounter, with
// bracketData (key level), rankPercent (parse percentile within bracket)
// and report{code,fightID}.
export const ENCOUNTER_RANKINGS = `
query EncounterRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $encounterID: Int!, $metric: CharacterRankingMetricType, $byBracket: Boolean, $role: RoleType) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      encounterRankings(encounterID: $encounterID, metric: $metric, byBracket: $byBracket, role: $role)
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
      masterData(translate: true) { actors(type: "Player") { id name subType server } }
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
