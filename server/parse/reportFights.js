// Parse a REPORT_BOSS_FIGHTS payload: every boss fight in a report (kills AND
// wipes), grouped per encounter, so raid progression can be analysed even from
// logs with no kill. Trash (encounterID 0) is dropped. Shape is treated as
// optional throughout; unexpected payloads are dumped, not crashed on.
import { dumpDebug } from '../wcl/client.js';

// WCL raid difficulty ids. M+ (8) and other modes fall through to the raw id.
const DIFFICULTY_NAME = { 1: 'LFR', 3: 'Normal', 4: 'Heroic', 5: 'Mythic' };
export const difficultyName = (d) => DIFFICULTY_NAME[d] ?? (d != null ? `diff ${d}` : null);

export function parseReportFights(report) {
  if (!report || typeof report !== 'object') {
    dumpDebug('report-fights-not-object', { report });
    return { title: null, zone: null, startTime: null, fights: [], actors: [] };
  }
  const rawFights = Array.isArray(report.fights) ? report.fights : [];
  if (!Array.isArray(report.fights)) dumpDebug('report-fights-no-fights', report);

  const fights = rawFights
    .filter((f) => f && typeof f === 'object' && f.encounterID) // encounterID 0/null = trash
    .map((f) => ({
      id: numOrNull(f.id),
      encounterID: numOrNull(f.encounterID),
      name: f.name ?? '(unknown boss)',
      kill: Boolean(f.kill),
      difficulty: numOrNull(f.difficulty),
      // % boss health REMAINING at the end of the fight — 0 on a kill, higher =
      // wiped earlier. `bossPercentage` is the per-boss value in multi-boss
      // encounters; fall back to it when fightPercentage is absent.
      pctRemaining: firstNum(f.fightPercentage, f.bossPercentage),
      lastPhase: numOrNull(f.lastPhase),
      startTime: numOrNull(f.startTime),
      endTime: numOrNull(f.endTime),
      durationMs: f.endTime != null && f.startTime != null ? f.endTime - f.startTime : null,
    }));

  return {
    title: report.title ?? null,
    zone: report.zone ? { id: report.zone.id ?? null, name: report.zone.name ?? null } : null,
    startTime: numOrNull(report.startTime),
    fights,
    actors: report?.masterData?.actors ?? [],
  };
}

/**
 * Group fights by encounter+difficulty into one row per boss, ordered as first
 * seen. Each row summarises the pull count, whether it was ever killed, and the
 * best progress reached (lowest boss % remaining across attempts).
 */
export function groupByEncounter(fights) {
  const byKey = new Map();
  for (const f of fights) {
    const key = `${f.encounterID}:${f.difficulty ?? '?'}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        encounterID: f.encounterID,
        name: f.name,
        difficulty: f.difficulty,
        difficultyName: difficultyName(f.difficulty),
        attempts: [],
        pulls: 0,
        kills: 0,
        bestPctRemaining: null,
      });
    }
    const g = byKey.get(key);
    g.attempts.push(f);
    g.pulls += 1;
    if (f.kill) g.kills += 1;
    if (f.pctRemaining != null) {
      g.bestPctRemaining = g.bestPctRemaining == null ? f.pctRemaining : Math.min(g.bestPctRemaining, f.pctRemaining);
    }
  }
  return [...byKey.values()];
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function firstNum(...vs) {
  for (const v of vs) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
