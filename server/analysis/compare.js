// Compare my run metrics against the cohort (median across top-N runs) and
// produce a ranked, human-readable gap report.
//
// Severity is a rough estimate of % DPS impact so gaps can be ordered.
// The weights are documented heuristics, not truth — the honesty section
// reports how much of the real DPS gap they explain.
import { computeRunMetrics, median, IGNORED_ABILITIES } from './metrics.js';
import { adviceFor } from './advice.js';
import { buildTimeline, buildTimelineInfo } from './timeline.js';
import { buildSummary } from './summary.js';
import { buildParsePlan, describeParsePlan } from './parseTiers.js';

// Ability cast-count diffs below this share of damage are noise — skip.
const MIN_DAMAGE_SHARE = 0.01;
const MIN_UPTIME_DIFF_PP = 8;
const MIN_COHORT_UPTIME = 25;

export function buildReport(bundle) {
  const mine = computeRunMetrics(bundle.mine.detail);
  const cohortMetrics = bundle.cohort.map((c) => computeRunMetrics(c.detail));
  const myDps = bundle.mine.meta.dps ?? null;
  const cohortDps = bundle.cohort.map((c) => c.meta.dps).filter((v) => typeof v === 'number');
  const cohortMedianDps = median(cohortDps);
  // Negative gap = I'm ahead of the cohort (possible against a single weaker
  // player via compareTo, or an easier-level cohort). That's a valid, honest
  // number; downstream code must treat "no positive gap" specially rather
  // than dividing by it (see honesty.explainedPct below).
  const dpsGapPct =
    myDps != null && cohortMedianDps != null && cohortMedianDps > 0
      ? (100 * (cohortMedianDps - myDps)) / cohortMedianDps
      : null;

  const gaps = [];

  // 1) deaths
  const cohortDeaths = median(cohortMetrics.map((m) => m.deaths.length));
  if (mine.deaths.length > cohortDeaths) {
    const extra = mine.deaths.length - cohortDeaths;
    gaps.push(gap('deaths', 'Deaths', mine.deaths.length, cohortDeaths, 'deaths', extra * 4));
  }

  // 2) downtime
  const cohortIdle = median(cohortMetrics.map((m) => m.downtime.idlePct));
  if (mine.downtime.idlePct != null && cohortIdle != null && mine.downtime.idlePct > cohortIdle + 1) {
    gaps.push(
      gap('downtime', 'Idle time (gaps > 5s with zero casts)', round1(mine.downtime.idlePct), round1(cohortIdle), '% of fight',
        mine.downtime.idlePct - cohortIdle, { windows: mine.downtime.windows })
    );
  }

  // 3) total CPM
  const cohortCPM = median(cohortMetrics.map((m) => m.totalCPM));
  if (cohortCPM && mine.totalCPM < cohortCPM * 0.97) {
    const diffPct = (100 * (cohortCPM - mine.totalCPM)) / cohortCPM;
    gaps.push(gap('cpm', 'Total casts per minute', round1(mine.totalCPM), round1(cohortCPM), 'CPM', diffPct * 0.8));
  }

  // 4) per-ability cast diffs, weighted by the cohort's damage share
  const abilityRows = abilityDiffs(mine, cohortMetrics);
  for (const row of abilityRows) {
    if (Math.abs(row.severity) < 0.5) continue;
    if (row.severity > 0) {
      gaps.push(
        gap('ability', `${row.name} usage`, `${round1(row.myCpm)} CPM`, `${round1(row.cohortCpm)} CPM`, null, row.severity, {
          name: row.name,
          damageSharePct: round1(100 * row.share),
          myCasts: row.myCasts,
        })
      );
    }
  }

  // 5) aura uptimes — measured over ENGAGED time (fight minus idle windows),
  // so downtime/deaths don't double-count as buff-management failures.
  // Only auras I actually have are actionable; auras I never gained at all
  // are almost certainly group-comp buffs or talent differences.
  const buffSources = bundle.mine.detail.buffSources ?? {};
  const { actionable: uptimeRows, downtimeCaused, compOnly } = uptimeDiffs(mine, cohortMetrics, buffSources);
  for (const row of uptimeRows) {
    gaps.push(
      gap('uptime', `${row.name} uptime (active time)`, `${round1(row.mineActive)}%`, `${round1(row.cohortActive)}%`, null, row.activeDiff * 0.15, {
        name: row.name,
        rawMine: round1(row.mineRaw),
        rawCohort: round1(row.cohortRaw),
      })
    );
  }
  const compNotes = compOnly.map((row) => ({
    name: row.name,
    minePct: round1(row.mineRaw),
    cohortPct: round1(row.cohortRaw),
    external: row.external,
    note: row.external
      ? `${row.name} is applied by a groupmate, not cast by you (verified from the log's own apply/remove events)` +
        (row.mineRaw > 0
          ? ` — you had it at ${round1(row.mineRaw)}% because your own group's support gave it to you sometimes, ` +
            `their ${round1(row.cohortRaw)}% reflects theirs doing it more; not your play.`
          : `; cohort runs have it at ~${round1(row.cohortRaw)}% because their support classes provide it, yours didn't this run.`)
      : `Cohort runs have ${row.name} at ~${round1(row.cohortRaw)}% uptime; you never had it — likely a group buff from their comp or a talent difference, not directly actionable.`,
  }));
  const downtimeNotes = downtimeCaused.map((row) => ({
    name: row.name,
    mineRaw: round1(row.mineRaw),
    cohortRaw: round1(row.cohortRaw),
    mineActive: round1(row.mineActive),
    cohortActive: round1(row.cohortActive),
    note: `${row.name}: raw uptime ${round1(row.mineRaw)}% vs their ${round1(row.cohortRaw)}%, but while actively playing you keep it at ${round1(row.mineActive)}% vs their ${round1(row.cohortActive)}% — the loss comes from deaths/downtime, already counted above. Fix those, not the buff.`,
  }));

  // 6) spender mix (informational severity)
  const cohortEpidemicShare = median(cohortMetrics.map((m) => m.spender.epidemicShare));
  const cohortDeathCoilCasts = median(cohortMetrics.map((m) => m.spender.deathCoil));
  const cohortEpidemicCasts = median(cohortMetrics.map((m) => m.spender.epidemic));
  if (mine.spender.epidemicShare != null && cohortEpidemicShare != null) {
    const diff = Math.abs(mine.spender.epidemicShare - cohortEpidemicShare);
    if (diff > 0.1) {
      gaps.push(
        gap('spender', 'Epidemic share of RP spenders (cast-count based)',
          `${Math.round(100 * mine.spender.epidemicShare)}%`, `${Math.round(100 * cohortEpidemicShare)}%`, null, diff * 5)
      );
    }
  }

  // 7) Runic Power waste (overcapping) — WCL's own computed waste field,
  // not derived/guessed. Only flagged if I actually wasted a meaningful
  // share; the cohort's own waste (rarely zero even for top players) is the
  // baseline, not zero.
  const cohortWastePct = median(cohortMetrics.map((m) => m.rpWaste.wastePct).filter((v) => v != null));
  const cohortNetGain = median(cohortMetrics.map((m) => m.rpWaste.netGain));
  const cohortWasteAmount = median(cohortMetrics.map((m) => m.rpWaste.waste));
  if (mine.rpWaste.wastePct != null && cohortWastePct != null && mine.rpWaste.wastePct > cohortWastePct + 3) {
    const diff = mine.rpWaste.wastePct - cohortWastePct;
    gaps.push(
      gap('waste', 'Runic Power wasted to overcapping', `${round1(mine.rpWaste.wastePct)}%`, `${round1(cohortWastePct)}%`, null, diff * 0.5, {
        wastedAmount: round1(mine.rpWaste.waste),
      })
    );
  }

  gaps.sort((a, b) => b.severity - a.severity);
  for (const g of gaps) g.advice = adviceFor(g);

  // honesty: how much of the DPS gap do the rotational severities cover?
  // Deaths, idle time and total CPM overlap (a death causes idle causes low
  // CPM) — count only the largest of the throughput cluster, plus the rest
  // discounted, and never claim more than 95%.
  const sevOf = (cat) => gaps.filter((g) => g.category === cat).reduce((a, g) => a + g.severity, 0);
  const throughput = Math.max(sevOf('cpm'), sevOf('downtime')) + sevOf('deaths');
  const rest = (sevOf('ability') + sevOf('uptime') + sevOf('spender') + sevOf('waste')) * 0.6;
  const explained = throughput + rest;
  const offLevelCohort = bundle.cohort.filter((c) => c.detail.fight.keystoneLevel !== bundle.targetLevel);
  const honesty = {
    dpsGapPct: dpsGapPct != null ? round1(dpsGapPct) : null,
    // only meaningful when there's a positive gap to attribute; when I match
    // or beat the cohort (gap <= 0) there is nothing to "explain"
    explainedPct: dpsGapPct != null && dpsGapPct > 0 ? round1(Math.min(95, (100 * explained) / dpsGapPct)) : null,
    note:
      'Severity values are heuristic %-DPS estimates; overlapping causes are only counted once. ' +
      'The unexplained remainder is likely routing, pull size, group comp and funnel — ' +
      'things a parse comparison cannot see.' +
      (compNotes.length
        ? ` Note: the cohort also had ${compNotes.slice(0, 3).map((n) => n.name).join(', ')} from their group comp — a real slice of the gap sits there, not in your play.`
        : '') +
      (offLevelCohort.length
        ? ` Note: ${offLevelCohort.map((c) => `${c.meta.name} (+${c.detail.fight.keystoneLevel})`).join(', ')} ` +
          `logged their best run at a different key level than your +${bundle.targetLevel} — part of the DPS gap ` +
          `there is just higher key scaling, not skill.`
        : '') +
      (bundle.targetLevel !== bundle.params.level
        ? ` Note: you don't have a +${bundle.params.level} logged for this dungeon — this compares your closest ` +
          `available run instead, +${bundle.targetLevel}.`
        : ''),
  };

  const headline = {
    dungeon: bundle.mine.detail.fight.name,
    myKeyLevel: bundle.mine.detail.fight.keystoneLevel,
    cohortLevel: bundle.targetLevel,
    requestedLevel: bundle.params.level,
    myDps: myDps ? Math.round(myDps) : null,
    cohortMedianDps: cohortMedianDps ? Math.round(cohortMedianDps) : null,
    dpsGapPct: dpsGapPct != null ? round1(dpsGapPct) : null,
    myBestPercent: bundle.mine.meta.bestPercent != null ? round1(bundle.mine.meta.bestPercent) : null,
    cohortSize: bundle.cohort.length,
    cohortNames: bundle.cohort.map((c) => {
      const lvl = c.detail.fight.keystoneLevel;
      const levelNote = lvl && lvl !== bundle.targetLevel ? `, +${lvl} not +${bundle.targetLevel}` : '';
      return c.label ? `${c.meta.name} (${c.label}${levelNote})` : c.meta.name;
    }),
    // structured list for a UI dropdown — pick one to get a full 1:1 report
    // against just that player instead of the aggregate median
    cohortPlayers: bundle.cohort.map((c) => ({
      name: c.meta.name,
      label: c.label ?? null,
      keyLevel: c.detail.fight.keystoneLevel,
    })),
    compareTo: bundle.compareTo ?? null,
  };
  const timeline = bundle.cohort[0] ? buildTimeline(bundle.mine.detail, bundle.cohort[0].detail) : null;
  if (timeline) timeline.otherRoleLabel = bundle.cohort[0].label ?? null;
  const timelineInfo = buildTimelineInfo(timeline);

  const parsePlan = buildParsePlan({
    myBestPercent: bundle.mine.meta.bestPercent,
    overallBestPercent: bundle.mine.meta.overallBestPercent,
    overallBestLevel: bundle.mine.meta.overallBestLevel,
    myDps,
    history: bundle.mine.historyAtLevel,
    gaps,
    honestyExplainedPct: honesty.explainedPct,
  });
  parsePlan.text = describeParsePlan(parsePlan);

  return {
    headline,
    gaps,
    compNotes,
    downtimeNotes,
    timeline,
    timelineInfo,
    parsePlan,
    summary: buildSummary({ headline, gaps, honesty }),
    tables: {
      cpm: abilityRows.map((r) => ({
        name: r.name,
        myCasts: r.myCasts,
        myCpm: round1(r.myCpm),
        cohortCasts: round1(r.cohortCasts),
        cohortCpm: round1(r.cohortCpm),
        damageSharePct: round1(100 * r.share),
      })),
      uptimes: allUptimes(mine, cohortMetrics),
      downtime: {
        ...mine.downtime,
        idlePct: round1(mine.downtime.idlePct),
        cohortIdlePct: cohortIdle != null ? round1(cohortIdle) : null,
      },
      deaths: {
        mine: mine.deaths,
        cohortMedian: cohortDeaths,
        // per-player breakdown, not just the median — "0 deaths" hides
        // whether that's every single top run or a lucky one
        cohortByPlayer: bundle.cohort.map((c, i) => ({ name: c.meta.name, deaths: cohortMetrics[i].deaths.length })),
      },
      spender: {
        mine: mine.spender,
        cohortEpidemicShare,
        cohortDeathCoilCasts: cohortDeathCoilCasts != null ? round1(cohortDeathCoilCasts) : null,
        cohortEpidemicCasts: cohortEpidemicCasts != null ? round1(cohortEpidemicCasts) : null,
      },
      rpWaste: {
        mine: mine.rpWaste,
        cohortWastePct: cohortWastePct != null ? round1(cohortWastePct) : null,
        cohortNetGain: cohortNetGain != null ? round1(cohortNetGain) : null,
        cohortWasteAmount: cohortWasteAmount != null ? round1(cohortWasteAmount) : null,
      },
    },
    honesty,
  };
}

function abilityDiffs(mine, cohortMetrics) {
  const names = new Set();
  for (const m of [mine, ...cohortMetrics]) for (const n of m.abilities.keys()) names.add(n);
  const rows = [];
  for (const name of names) {
    if (IGNORED_ABILITIES.has(name)) continue;
    const myCpm = mine.abilities.get(name)?.cpm ?? 0;
    const cohortCpm = median(cohortMetrics.map((m) => m.abilities.get(name)?.cpm ?? 0)) ?? 0;
    const cohortCasts = median(cohortMetrics.map((m) => m.abilities.get(name)?.casts ?? 0)) ?? 0;
    const share = median(cohortMetrics.map((m) => m.damageShare.get(name) ?? 0)) ?? 0;
    if (share < MIN_DAMAGE_SHARE && cohortCpm < 0.5 && myCpm < 0.5) continue;
    const relDiff = cohortCpm ? (cohortCpm - myCpm) / cohortCpm : myCpm ? -1 : 0;
    // severity ≈ missing casts × how much of their damage this ability carries
    const severity = relDiff * Math.max(share, 0.005) * 100;
    rows.push({
      name,
      myCasts: mine.abilities.get(name)?.casts ?? 0,
      myCpm,
      cohortCasts,
      cohortCpm,
      share,
      severity,
    });
  }
  rows.sort((a, b) => Math.abs(b.severity) - Math.abs(a.severity));
  return rows;
}

function uptimeDiffs(mine, cohortMetrics, buffSources = {}) {
  const actionable = [];
  const downtimeCaused = [];
  const compOnly = [];
  for (const [name, cohort] of cohortAuraMedians(cohortMetrics)) {
    if (IGNORED_ABILITIES.has(name)) continue;
    if (cohort.raw < MIN_COHORT_UPTIME) continue;
    const mineAura = mine.auras.get(name);
    const mineRaw = mineAura?.uptimePct ?? 0;
    const mineActive = mineAura?.activeUptimePct ?? mineRaw;
    const rawDiff = cohort.raw - mineRaw;
    const activeDiff = (cohort.active ?? cohort.raw) - mineActive;
    if (rawDiff < MIN_UPTIME_DIFF_PP && activeDiff < MIN_UPTIME_DIFF_PP) continue;

    const row = {
      name,
      mineRaw,
      cohortRaw: cohort.raw,
      mineActive,
      cohortActive: cohort.active ?? cohort.raw,
      rawDiff,
      activeDiff,
    };
    // externally-applied (verified from real apply/remove events: someone
    // else's sourceID, never mine) — a raid/party buff, not a personal habit,
    // regardless of how much uptime I happened to get from it
    const src = buffSources[name];
    const isExternal = src && src.foreign > 0 && src.self === 0;
    // never gained the aura at all -> most likely also external (group buff
    // or a talent difference); report separately, don't rank as an
    // actionable gap
    if (isExternal || !mineAura || (mineRaw === 0 && (mineAura.uses ?? 0) === 0)) {
      compOnly.push({ ...row, external: Boolean(isExternal) });
    } else if (activeDiff < MIN_UPTIME_DIFF_PP / 2) {
      // big raw gap but fine while actively playing -> the loss is downtime/
      // deaths, which are already ranked as their own gaps
      downtimeCaused.push(row);
    } else {
      actionable.push(row);
    }
  }
  actionable.sort((a, b) => b.activeDiff - a.activeDiff);
  downtimeCaused.sort((a, b) => b.rawDiff - a.rawDiff);
  compOnly.sort((a, b) => b.rawDiff - a.rawDiff);
  return {
    actionable: actionable.slice(0, 8),
    downtimeCaused: downtimeCaused.slice(0, 8),
    compOnly: compOnly.slice(0, 10),
  };
}

function allUptimes(mine, cohortMetrics) {
  const rows = [];
  for (const [name, cohort] of cohortAuraMedians(cohortMetrics)) {
    if (IGNORED_ABILITIES.has(name)) continue;
    const mineAura = mine.auras.get(name);
    const mineRaw = mineAura?.uptimePct ?? 0;
    if (cohort.raw < 5 && mineRaw < 5) continue;
    rows.push({
      name,
      minePct: round1(mineRaw),
      mineActivePct: round1(mineAura?.activeUptimePct ?? mineRaw),
      myUses: mineAura?.uses ?? 0,
      cohortPct: round1(cohort.raw),
      cohortActivePct: round1(cohort.active ?? cohort.raw),
      cohortUses: round1(cohort.uses),
      diffPp: round1(cohort.raw - mineRaw),
    });
  }
  rows.sort((a, b) => b.diffPp - a.diffPp);
  return rows;
}

function cohortAuraMedians(cohortMetrics) {
  const names = new Set();
  for (const m of cohortMetrics) for (const n of m.auras.keys()) names.add(n);
  const out = new Map();
  for (const name of names) {
    out.set(name, {
      raw: median(cohortMetrics.map((m) => m.auras.get(name)?.uptimePct ?? 0)) ?? 0,
      active: median(
        cohortMetrics.map((m) => {
          const a = m.auras.get(name);
          return a ? (a.activeUptimePct ?? a.uptimePct) : 0;
        })
      ),
      uses: median(cohortMetrics.map((m) => m.auras.get(name)?.uses ?? 0)) ?? 0,
    });
  }
  return out;
}

function gap(category, title, mine, cohort, unit, severity, extra = {}) {
  return { category, title, mine, cohort, unit, severity: round1(Math.max(0, severity)), ...extra };
}

function round1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
}
