// Build the eight-section report: my run vs ONE other player.
//
// This file used to compare against the MEDIAN of a 5-7 player cohort. That is
// gone. Every section of the report is a 1:1 comparison, so the medians bought
// nothing but cost six extra run fetches — and they lied: picking a player from
// the dropdown narrowed the cohort to that one person, at which point every
// "cohort median" was really just their number, still labelled as a median.
//
// Gap severity is a rough estimate of % DPS impact, used only to ORDER the gaps.
// The weights are documented heuristics, not truth.
import { computeRunMetrics, IGNORED_ABILITIES } from './metrics.js';
import { adviceFor } from './advice.js';
import { buildTimeline } from './timeline.js';
import { buildParsePlan, describeParsePlan } from './parseTiers.js';
import { compareResource } from './resources.js';
import { buildConsumables } from './consumables.js';
import { rotationComposition, castOrder } from './spikes.js';

// Ability cast-count diffs below this share of damage are noise — skip.
const MIN_DAMAGE_SHARE = 0.01;
const MIN_UPTIME_DIFF_PP = 8;
const MIN_THEIR_UPTIME = 25;

/** Fight duration in ms from a run detail (keystone time, else span). */
function fightDurationMs(detail) {
  const f = detail?.fight ?? {};
  if (typeof f.keystoneTime === 'number' && f.keystoneTime > 0) return f.keystoneTime;
  if (typeof f.endTime === 'number' && typeof f.startTime === 'number') return f.endTime - f.startTime;
  return null;
}

export function buildReport(bundle) {
  const className = bundle.params?.className ?? 'DeathKnight';
  const specName = bundle.params?.specName ?? 'Unholy';

  const mineDetail = bundle.mine.detail;
  const otherDetail = bundle.other.detail;
  const otherName = bundle.other.meta.name;

  const mine = computeRunMetrics(mineDetail);
  const them = computeRunMetrics(otherDetail);
  const buffSources = mineDetail.buffSources ?? {};

  const myDps = bundle.mine.meta.dps ?? null;
  const theirDps = bundle.other.meta.dps ?? null;
  const dpsGapPct = myDps != null && theirDps ? (100 * (theirDps - myDps)) / theirDps : null;

  const gaps = buildGaps(mine, them, buffSources);
  for (const g of gaps) g.advice = adviceFor(g);

  const timeline = buildTimeline(mineDetail, otherDetail, buffSources);
  if (timeline) timeline.otherRoleLabel = null;

  const rotation = rotationComposition(mineDetail, otherDetail);

  const statPriorityNote =
    className === 'DeathKnight' && specName === 'Unholy'
      ? "Unholy's stat priority is Mastery > Crit > Haste > Versatility, so match the flask to that."
      : null;

  const parse = buildParsePlan({
    myBestPercent: bundle.mine.meta.bestPercent,
    overallBestPercent: bundle.mine.meta.overallBestPercent,
    overallBestLevel: bundle.mine.meta.overallBestLevel,
    myDps,
    history: bundle.mine.historyAtLevel,
    gaps,
  });
  parse.text = describeParsePlan(parse);

  return {
    headline: {
      title: mineDetail.fight.name,
      subtitle: `+${mineDetail.fight.keystoneLevel}`,
      myKeyLevel: mineDetail.fight.keystoneLevel,
      requestedLevel: bundle.params.level,
      targetLevel: bundle.targetLevel,
      myDps: myDps ? Math.round(myDps) : null,
      theirDps: theirDps ? Math.round(theirDps) : null,
      dpsGapPct: round1(dpsGapPct),
      myBestPercent: round1(bundle.mine.meta.bestPercent),
      otherLabel: otherName,
    },
    // 1 — the picker
    compare: { ...bundle.players, level: bundle.targetLevel },
    // 2 + 3 — cast order and rotation timeline
    castOrder: { mine: castOrder(mineDetail), them: castOrder(otherDetail) },
    timeline,
    rotationMatch: { spellMixPct: rotation.similarityPct, castOrderPct: rotation.sequencePct },
    // 4
    consumables: buildConsumables(mineDetail, otherDetail, otherName, buffSources, statPriorityNote),
    // 5
    parse,
    // 6
    gaps,
    // 7
    resources: compareResource(mineDetail.resourceEvents ?? [], otherDetail.resourceEvents ?? []),
    // 8
    abilities: buildAbilityTable(mineDetail, otherDetail, otherName),
  };
}

// --- section 6: what stands out ---------------------------------------------

function buildGaps(mine, them, buffSources) {
  const gaps = [];

  if (mine.deaths.length > them.deaths.length) {
    const extra = mine.deaths.length - them.deaths.length;
    gaps.push(gap('deaths', 'Deaths', mine.deaths.length, them.deaths.length, 'deaths', extra * 4));
  }

  if (mine.downtime.idlePct != null && them.downtime.idlePct != null && mine.downtime.idlePct > them.downtime.idlePct + 1) {
    gaps.push(
      gap('downtime', 'Idle time (gaps > 5s with zero casts)', round1(mine.downtime.idlePct), round1(them.downtime.idlePct), '% of fight',
        mine.downtime.idlePct - them.downtime.idlePct, { windows: mine.downtime.windows })
    );
  }

  if (them.totalCPM && mine.totalCPM < them.totalCPM * 0.97) {
    const diffPct = (100 * (them.totalCPM - mine.totalCPM)) / them.totalCPM;
    gaps.push(gap('cpm', 'Total casts per minute', round1(mine.totalCPM), round1(them.totalCPM), 'CPM', diffPct * 0.8));
  }

  for (const row of abilityDiffs(mine, them)) {
    if (row.severity < 0.5) continue;
    gaps.push(
      gap('ability', `${row.name} usage`, `${round1(row.myCpm)} CPM`, `${round1(row.theirCpm)} CPM`, null, row.severity, {
        name: row.name,
        damageSharePct: round1(100 * row.share),
        myCasts: row.myCasts,
      })
    );
  }

  // Aura uptimes I could actually control. Buffs a groupmate applied are NOT my
  // play — they belong in the consumables/party-buffs section, and flagging them
  // here would send the player hunting for a rotation mistake that never existed.
  for (const row of uptimeDiffs(mine, them, buffSources)) {
    gaps.push(
      gap('uptime', `${row.name} uptime (active time)`, `${round1(row.mineActive)}%`, `${round1(row.theirActive)}%`, null, row.activeDiff * 0.15, {
        name: row.name,
      })
    );
  }

  if (mine.resource?.wastePct != null && them.resource?.wastePct != null && mine.resource.wastePct > them.resource.wastePct + 3) {
    const diff = mine.resource.wastePct - them.resource.wastePct;
    gaps.push(
      gap('waste', `${mine.resource.name} wasted to overcapping`, `${round1(mine.resource.wastePct)}%`, `${round1(them.resource.wastePct)}%`, null, diff * 0.5, {
        resource: mine.resource.name,
        wastedAmount: round1(mine.resource.waste),
      })
    );
  }

  return gaps.sort((a, b) => b.severity - a.severity);
}

function abilityDiffs(mine, them) {
  const names = new Set([...mine.abilities.keys(), ...them.abilities.keys()]);
  const rows = [];
  for (const name of names) {
    if (IGNORED_ABILITIES.has(name)) continue;
    const myCpm = mine.abilities.get(name)?.cpm ?? 0;
    const theirCpm = them.abilities.get(name)?.cpm ?? 0;
    const share = them.damageShare.get(name) ?? 0;
    if (share < MIN_DAMAGE_SHARE && theirCpm < 0.5 && myCpm < 0.5) continue;
    const relDiff = theirCpm ? (theirCpm - myCpm) / theirCpm : 0;
    rows.push({
      name,
      myCasts: mine.abilities.get(name)?.casts ?? 0,
      myCpm,
      theirCpm,
      share,
      // severity ≈ missing casts × how much of their damage this ability carries
      severity: relDiff * Math.max(share, 0.005) * 100,
    });
  }
  return rows.sort((a, b) => b.severity - a.severity);
}

function uptimeDiffs(mine, them, buffSources) {
  const out = [];
  for (const [name, theirAura] of them.auras) {
    if (IGNORED_ABILITIES.has(name)) continue;
    if (theirAura.uptimePct < MIN_THEIR_UPTIME) continue;

    // applied by a groupmate, never by me => their comp, not my rotation
    const src = buffSources[name];
    if (src && src.foreign > 0 && src.self === 0) continue;

    const mineAura = mine.auras.get(name);
    if (!mineAura) continue; // never had it at all — a talent difference, not a habit

    const mineActive = mineAura.activeUptimePct ?? mineAura.uptimePct;
    const theirActive = theirAura.activeUptimePct ?? theirAura.uptimePct;
    const activeDiff = theirActive - mineActive;
    // measured over ENGAGED time, so downtime and deaths don't masquerade as
    // buff-management failures (those are already their own gaps above)
    if (activeDiff < MIN_UPTIME_DIFF_PP) continue;

    out.push({ name, mineActive, theirActive, activeDiff });
  }
  return out.sort((a, b) => b.activeDiff - a.activeDiff).slice(0, 8);
}

// --- section 8: per-ability, mine vs them ------------------------------------

/**
 * One table, casts AND damage, 1:1. Replaces two overlapping tables — a
 * "per-ability casts vs cohort median" and a separate "damage done" — that showed
 * the same abilities twice against two different baselines.
 */
export function buildAbilityTable(mineDetail, otherDetail, otherName) {
  const side = (detail) => {
    const durSec = (fightDurationMs(detail) ?? 0) / 1000;
    const casts = new Map((detail.casts?.abilities ?? []).map((a) => [a.name, a.casts]));
    const byName = new Map();
    for (const a of detail.damage?.abilities ?? []) {
      byName.set(a.name, {
        amount: a.total,
        hits: a.hits ?? 0,
        casts: casts.get(a.name) ?? 0,
        dps: durSec > 0 ? a.total / durSec : 0,
      });
    }
    // abilities that cost a global but deal no damage still matter — they're where
    // the globals went
    for (const [name, c] of casts) {
      if (!byName.has(name)) byName.set(name, { amount: 0, hits: 0, casts: c, dps: 0 });
    }
    return { byName, totalDamage: detail.damage?.totalDamage ?? 0, totalDps: durSec > 0 ? (detail.damage?.totalDamage ?? 0) / durSec : 0 };
  };
  const m = side(mineDetail);
  const o = side(otherDetail);

  const rows = [];
  for (const name of new Set([...m.byName.keys(), ...o.byName.keys()])) {
    if (IGNORED_ABILITIES.has(name)) continue;
    const a = m.byName.get(name);
    const b = o.byName.get(name);
    rows.push({
      name,
      myCasts: a?.casts ?? 0,
      theirCasts: b?.casts ?? 0,
      castDiff: (a?.casts ?? 0) - (b?.casts ?? 0),
      myAmount: a?.amount ?? 0,
      theirAmount: b?.amount ?? 0,
      myDps: Math.round(a?.dps ?? 0),
      theirDps: Math.round(b?.dps ?? 0),
    });
  }
  rows.sort((x, y) => Math.max(y.myAmount, y.theirAmount) - Math.max(x.myAmount, x.theirAmount));

  return {
    otherLabel: otherName,
    rows,
    totals: {
      myDamage: m.totalDamage,
      myDps: Math.round(m.totalDps),
      theirDamage: o.totalDamage,
      theirDps: Math.round(o.totalDps),
    },
  };
}

function gap(category, title, mine, other, unit, severity, extra = {}) {
  return { category, title, mine, cohort: other, unit, severity: round1(Math.max(0, severity)), ...extra };
}

function round1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
}
