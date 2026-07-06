// GraphQL query strings for the Warcraft Logs v2 client API.
// zoneRankings / characterRankings / table / events are loosely-typed JSON
// scalars — parse them defensively (see server/parse/).

export const ZONE_RANKINGS = `
query ZoneRankings($name: String!, $serverSlug: String!, $serverRegion: String!, $zoneID: Int!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      name
      zoneRankings(zoneID: $zoneID)
    }
  }
}`;

export const CHARACTER_RANKINGS = `
query CharacterRankings($encounterID: Int!, $className: String!, $specName: String!, $bracket: Int!, $page: Int!) {
  worldData {
    encounter(id: $encounterID) {
      name
      characterRankings(className: $className, specName: $specName, bracket: $bracket, page: $page)
    }
  }
}`;

export const REPORT_ACTORS = `
query ReportActors($code: String!) {
  reportData {
    report(code: $code) {
      masterData(translate: true) {
        actors(type: "Player") {
          id
          name
          subType
        }
      }
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

export const REPORT_EVENTS = `
query ReportEvents($code: String!, $fightIDs: [Int!], $dataType: EventDataType!, $sourceID: Int!, $startTime: Float, $endTime: Float) {
  reportData {
    report(code: $code) {
      events(fightIDs: $fightIDs, dataType: $dataType, sourceID: $sourceID, startTime: $startTime, endTime: $endTime) {
        data
        nextPageTimestamp
      }
    }
  }
}`;
