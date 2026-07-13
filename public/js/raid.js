// The raid side: paste a log -> pick a boss -> per-pull output, death timing,
// rotation vs a top parser, and a per-pull DPS + rotation timeline.
//
// Raid data comes straight from a report rather than from rankings, because
// rankings only ever contain KILLS — a wipe appears in no ranking anywhere, and
// wipes are the whole point on progress.
import { $, esc, fmtK, fmtSec, fmtTime } from './util.js';
import { state, charQuery } from './state.js';
import {
  dpsChartSvg,
  wireDpsBrush,
  setCastWindow,
  castOrderSlot,
  renderTimelineSection,
  renderCastOrderCols,
  renderDamageDone,
} from './chart.js';

let raidState = { code: null, difficulty: '5', bosses: [] };

export function renderRaidCard() {
  const el = $('#raid');
  if (!el) return;
  el.innerHTML = `
    <div class="card">
      <h2>Raid progression <small>&mdash; analyse a log, kills or wipes</small></h2>
      <p><small>Paste a Warcraft Logs report link or its 16-char code. Reads
        <b>${esc(state.activeChar.name)}</b>'s output across every pull of a boss &mdash; even with no kill &mdash;
        flags how consistent your damage is pull to pull, and benchmarks it against a top kill.</small></p>
      <form id="raid-form" class="raid-form">
        <input id="raid-code" placeholder="warcraftlogs.com/reports/XXXXXXXX… or the code" required />
        <label class="spec-pick">difficulty
          <select id="raid-diff">
            <option value="5" selected>Mythic</option>
            <option value="4">Heroic</option>
            <option value="3">Normal</option>
          </select>
        </label>
        <button type="submit">Load bosses</button>
      </form>
      <div id="raid-status"></div>
      <div id="raid-bosses"></div>
      <div id="raid-result"></div>
    </div>`;
  $('#raid-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadRaidBosses();
  });
}

async function loadRaidBosses() {
  const code = $('#raid-code').value.trim();
  if (!code) return;
  raidState = { code, difficulty: $('#raid-diff').value, bosses: [] };
  $('#raid-status').textContent = 'Reading report…';
  $('#raid-bosses').innerHTML = '';
  $('#raid-result').innerHTML = '';
  try {
    const params = charQuery();
    params.set('code', code);
    params.set('difficulty', raidState.difficulty);
    const res = await fetch(`/api/raid/report?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    raidState.bosses = data.bosses || [];
    $('#raid-status').innerHTML = `<b>${esc(data.title || code)}</b>${data.zone?.name ? ` &middot; ${esc(data.zone.name)}` : ''}`;
    renderRaidBosses(raidState.bosses);
  } catch (err) {
    $('#raid-status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}

function renderRaidBosses(bosses) {
  const diff = Number(raidState.difficulty);
  const atDiff = bosses.filter((b) => b.difficulty === diff);
  const show = atDiff.length ? atDiff : bosses;
  if (!show.length) {
    $('#raid-bosses').innerHTML = `<p class="muted">No boss pulls found in this report${atDiff.length ? '' : ' at that difficulty'}.</p>`;
    return;
  }
  const rows = show
    .map((b) => {
      const prog = b.kills > 0 ? `<span class="p-orange">killed</span>` : b.bestPctRemaining != null ? `best ${b.bestPctRemaining}% left` : '—';
      return `<button type="button" class="mini raid-boss" data-encounter="${b.encounterID}" data-diff="${b.difficulty}">
        ${esc(b.name)} <small>&middot; ${esc(b.difficultyName || '')} &middot; ${b.pulls} pull${b.pulls === 1 ? '' : 's'} &middot; ${prog}</small></button>`;
    })
    .join('');
  $('#raid-bosses').innerHTML = `<div class="raid-boss-list">${rows}</div>`;
  $('#raid-bosses')
    .querySelectorAll('.raid-boss')
    .forEach((btn) => btn.addEventListener('click', () => loadRaidProgression(btn.dataset.encounter, btn.dataset.diff)));
}

async function loadRaidProgression(encounterID, difficulty) {
  $('#raid-result').innerHTML = `<p class="muted">Analysing every pull (fetches your casts per attempt &amp; the kill benchmark — up to ~20s the first time, cached after)…</p>`;
  try {
    const params = charQuery();
    params.set('code', raidState.code);
    params.set('encounter', encounterID);
    params.set('difficulty', difficulty);
    const res = await fetch(`/api/raid/report?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderRaidProgression(data);
  } catch (err) {
    $('#raid-result').innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}

function renderRaidProgression(data) {
  const p = data.progression;
  const c = p.consistency;
  // keep the night's context around so a selected pull can be placed against it
  raidState.consistency = c;
  // best = highest active DPS among COMPARABLE pulls only. A 30s wipe is spent
  // entirely inside the opener with every cooldown up, so it always wins on rate
  // — picking it would just hand back the shortest pull, not the best-played one.
  const best = p.rows.filter((r) => r.comparable).sort((a, b) => b.activeDps - a.activeDps)[0] ?? null;
  const verdictClass = c.verdict === 'tight' ? 'p-purple' : c.verdict === 'moderate' ? 'p-blue' : c.verdict === 'swingy' ? 'p-gray' : 'muted';
  // EVERY pull is listed and clickable, including ones with no aggregate metrics
  // — a 50-pull night must let you pick pull #37, not just the sample we fetched.
  const pulls = p.rows
    .map((r) => {
      const cls = [!r.analysed && 'unanalysed', r.burstWeighted && 'burst', r.kill && 'rot-big'].filter(Boolean).join(' ');
      const num = (v, fmt) => (r.analysed && v != null ? fmt(v) : '<span class="muted">—</span>');
      // a burst-weighted pull still shows its real DPS, but marked — so it can
      // never be mistaken for a bar the full-length pulls failed to clear
      const dps = r.burstWeighted
        ? `${fmtK(r.activeDps)} <small class="util" title="Ended in ${r.durationSec}s — entirely inside your opener, every cooldown up. Not comparable to a full-length pull.">burst</small>`
        : num(r.activeDps, fmtK);
      return `<tr class="clickable ${cls}" data-fight="${r.fightID}" title="Analyse pull #${r.fightID} against the top parser">
        <td>#${r.fightID}</td>
        <td>${r.kill ? '<span class="p-orange">kill</span>' : r.pctRemaining != null ? `${r.pctRemaining}% left` : 'wipe'}</td>
        <td class="num">${fmtTime((r.durationSec ?? 0) * 1000)}</td>
        <td class="num">${dps}</td>
        <td class="num">${num(r.cpm, (v) => v.toFixed(1))}</td>
        <td>${r.analysed ? deathCell(r) : '<span class="muted">—</span>'}</td>
        <td class="num">${num(r.idlePct, (v) => v.toFixed(0) + '%')}</td>
      </tr>`;
    })
    .join('');
  const dt = c.deathTiming || {};
  const benchLine = data.benchmark
    ? `<p class="table-note"><small>Benchmark: <b>${esc(data.benchmark.name)}</b> — top ${esc(data.benchmark.difficultyName || '')} kill.</small></p>`
    : `<p class="table-note"><small>No ranked kill benchmark available for this boss/spec yet — showing your own consistency only.</small></p>`;
  const sampled = c.analysedPulls != null && c.analysedPulls < c.pulls;
  $('#raid-result').innerHTML = `
    <h3>${esc(data.boss)} <small>&middot; ${esc(data.difficultyName || '')} &middot; ${c.pulls} pull${c.pulls === 1 ? '' : 's'}</small></h3>
    <p class="raid-verdict"><b class="${verdictClass}">${esc((c.verdict || '').replace('-', ' ').toUpperCase())}</b> output — ${esc(p.text)}</p>
    <div class="raid-stats">
      <span>Mean active DPS <b>${fmtK(c.meanActiveDps)}</b></span>
      <span>Best <b>${fmtK(c.bestActiveDps)}</b></span>
      <span>Worst <b>${fmtK(c.worstActiveDps)}</b></span>
      <span>Swing <b>${c.swingPct != null ? c.swingPct + '%' : '—'}</b></span>
      <span>Early deaths <b>${dt.earlyDeaths ?? 0}/${dt.scoredWipes ?? 0} wipes</b></span>
    </div>
    ${benchLine}
    <div id="raid-current" class="raid-current"></div>
    <p class="table-note"><small><b>Click any pull below</b> to analyse that specific pull — DPS over time, boss health, rotation timeline, cast order, and its rotation vs the top parser.
      ${
        sampled
          ? `The summary above is computed from the <b>${c.analysedPulls} longest</b> of ${c.pulls} pulls (each pull costs API calls); rows showing <span class="muted">—</span> have no summary stats yet, but you can still click them and they'll be analysed in full.`
          : `All ${c.pulls} pulls are included in the summary above.`
      }</small></p>
    <p><button id="raid-best-pull" class="mini accent">★ Analyse best pull${best ? ` (#${best.fightID} — ${fmtK(best.activeDps)})` : ''}</button></p>
    <table class="rot-table pull-table">
      <thead><tr><th>Pull</th><th>Result</th><th>Dur</th><th>Active DPS</th><th>CPM</th><th>Death</th><th>Idle</th></tr></thead>
      <tbody>${pulls}</tbody>
    </table>
    <div id="raid-pull-chart"></div>`;

  const pick = (fightID) => {
    const tr = $('#raid-result').querySelector(`tr[data-fight="${fightID}"]`);
    // mark the selected pull so it's obvious which one the analysis below is for
    $('#raid-result').querySelectorAll('tr.selected').forEach((x) => x.classList.remove('selected'));
    if (tr) tr.classList.add('selected');
    loadRaidPullChart(Number(fightID), data.encounterID, data.difficulty);
  };

  $('#raid-result')
    .querySelectorAll('tr.clickable[data-fight]')
    .forEach((tr) => tr.addEventListener('click', () => pick(tr.dataset.fight)));

  const bestBtn = $('#raid-best-pull');
  if (bestBtn) {
    bestBtn.disabled = !best;
    bestBtn.addEventListener('click', () => best && pick(best.fightID));
  }
}

/**
 * The verdict block is about the NIGHT (spread across pulls — that's what
 * "swingy" means and it's meaningless for one pull). This line sits under it and
 * re-anchors it to the pull you actually selected: where this pull lands against
 * your own mean/best, and against the top parser over the same window.
 */
function renderCurrentPull(data) {
  const el = $('#raid-current');
  if (!el) return;
  const o = data.output;
  const c = raidState.consistency;
  if (!o || !c) return;

  const bits = [];
  // A pull below the comparability floor is all-opener: every cooldown up, no
  // droughts. Say so instead of ranking it against full-length pulls.
  const isBurst = c.comparableFloorSec != null && o.durationSec != null && o.durationSec < c.comparableFloorSec;
  if (isBurst) {
    bits.push(
      `this pull lasted only <b>${o.durationSec}s</b> — it never left your opener, so its DPS is <b>burst-inflated</b> and not comparable to your full-length pulls (it's excluded from the numbers above)`
    );
  }
  const rel = (mine, ref) => (ref ? Math.round((1000 * (mine - ref)) / ref) / 10 : null);
  const vsMean = isBurst ? null : rel(o.activeDps, c.meanActiveDps);
  if (vsMean != null) {
    const where =
      c.bestActiveDps && o.activeDps >= c.bestActiveDps - 1
        ? ' — your <b>best</b> pull'
        : c.worstActiveDps && o.activeDps <= c.worstActiveDps + 1
          ? ' — your <b>worst</b> pull'
          : '';
    bits.push(
      vsMean >= 0
        ? `<b>${Math.abs(vsMean)}% above</b> your ${fmtK(c.meanActiveDps)} mean${where}`
        : `<b>${Math.abs(vsMean)}% below</b> your ${fmtK(c.meanActiveDps)} mean${where}`
    );
  }
  const b = data.benchmarkOutput;
  if (b?.activeDps && !isBurst) {
    const gap = Math.round((1000 * (b.activeDps - o.activeDps)) / b.activeDps) / 10;
    bits.push(
      gap > 0
        ? `<b>${gap}% under</b> ${esc(b.name)} over this same window`
        : `<b>${Math.abs(gap)}% above</b> ${esc(b.name)} over this same window`
    );
  }
  if (o.deathTiming === 'early') {
    bits.push(`you died <b>${o.diedBeforeRaidSec}s before the raid</b> here — lost uptime on this pull`);
  } else if (o.deathTiming === 'with-wipe') {
    bits.push(`you went down with the raid (not on you)`);
  } else if (o.deathTiming === 'survived' && !o.kill) {
    bits.push(`you survived the whole pull`);
  }

  el.innerHTML = `
    <p class="raid-current-line">
      <b class="p-blue">Pull #${o.fightID}</b> ${o.kill ? '<span class="p-orange">kill</span>' : `wipe at ${o.pctRemaining}%`} &middot;
      <b>${fmtK(o.activeDps)}</b> active DPS &middot; ${o.cpm != null ? o.cpm.toFixed(1) + ' CPM' : ''}
      ${bits.length ? `<br />${bits.join(' &middot; ')}.` : ''}
    </p>`;
}

// A wipe kills everyone — so a death only matters if it was EARLY (before the
// raid). Green = survived/killed, orange = died early (with the seconds of lost
// uptime), muted = went down with the raid (not the player's fault).
function deathCell(r) {
  if (r.kill) return '<span class="p-green">kill</span>';
  if (r.deathTiming === 'survived') return '<span class="p-green">survived</span>';
  if (r.deathTiming === 'early') {
    const secs = r.diedBeforeRaidSec != null ? ` <small>${r.diedBeforeRaidSec}s early</small>` : '';
    const nth = r.diedNth != null ? ` <small class="util">#${r.diedNth} to die</small>` : '';
    return `<span class="p-orange">early</span>${secs}${nth}`;
  }
  return '<span class="muted">with raid</span>';
}

// --- one pull, charted vs the top parser ---

async function loadRaidPullChart(fightID, encounterID, difficulty) {
  const root = $('#raid-pull-chart');
  if (!root) return;
  root.innerHTML = `<p class="muted">Loading pull #${fightID} — damage events for both runs (~15s first time, cached after)…</p>`;
  const cur = $('#raid-current');
  if (cur) cur.innerHTML = `<p class="raid-current-line muted">Analysing pull #${fightID}…</p>`;
  try {
    const params = charQuery();
    params.set('code', raidState.code);
    params.set('encounter', encounterID);
    params.set('difficulty', difficulty);
    params.set('fight', fightID);
    const res = await fetch(`/api/raid/pull?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const cur = $('#raid-pull-chart');
    if (!cur) return; // user switched pulls while loading
    renderRaidPullChart(data, cur);
    renderCurrentPull(data); // re-anchor the night's verdict to this pull
  } catch (err) {
    const cur = $('#raid-pull-chart');
    if (cur) cur.innerHTML = `<span class="error">Pull chart failed: ${esc(err.message)}</span>`;
  }
}

function renderRaidPullChart(data, root) {
  const sa = data.spikeAnalysis;
  const w = data.window || {};
  const view = {
    state: {
      order: sa?.rotation?.order ?? { mine: [], them: [] },
      otherLabel: data.otherLabel,
      durationSec: Math.max(data.mine.durationMs, data.other.durationMs) / 1000,
    },
  };
  // The honesty banner: a wipe is only ever compared to the slice of the kill
  // that covers the same chunk of boss health.
  const banner = w.truncated
    ? `<p class="raid-verdict"><b>Fair-window comparison.</b> Your pull took the boss from <b>100% → ${w.cutoffPct}%</b> and then wiped.
        So it's compared against only the matching slice of ${esc(data.otherLabel)}'s kill — the first <b>${fmtSec(w.theirCutoffSec)}</b>,
        which is where their boss also hit ${w.cutoffPct}% (their full kill ran ${fmtSec(w.theirFullSec)}). Same chunk of boss, same phases —
        everything below is measured over that window on both sides.</p>`
    : `<p class="raid-verdict"><b>Full-fight comparison.</b> Your pull was a <b>kill</b> (100% → 0%), so it's measured against ${esc(data.otherLabel)}'s
        entire kill — no truncation needed.</p>`;

  root.innerHTML = `
    <h3>Pull #${data.pull.id} <small>&middot; ${data.pull.kill ? 'kill' : `wipe at ${data.pull.pctRemaining}% boss health`} &middot; vs ${esc(data.otherLabel)}</small></h3>
    ${renderParse(data.parse)}
    ${banner}
    ${dpsChartSvg(data.mine, data.other, view, { bossHealth: data.bossHealth })}
    <p class="table-note"><small>5-second bins of effective damage (includes your pets). The <b>dashed lines</b> are boss health on the right axis —
      yours ends where you wiped, theirs at the same % — so you can see exactly where in the boss's health your output landed.
      Drag across the chart to inspect any window's rotation below.</small></p>
    ${castOrderSlot()}
    ${renderTimelineSection(data.timeline, data.timelineInfo)}
    ${renderRaidComparison(data.comparison)}`;

  wireDpsBrush(root, view);
  setCastWindow(root, view, 0, view.state.durationSec); // default: whole window
  root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- this pull's parse colour, and what the next colours cost ---

// **bold** -> <b>, so the server can emphasise the numbers that matter without
// shipping HTML (everything is escaped first).
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

function renderParse(p) {
  if (!p) return '';
  const cur = p.currentPercent;
  const chips = (p.tiers ?? [])
    .map((t) => {
      const sign = t.dpsDelta >= 0 ? '+' : '';
      return `<span class="tier-chip p-${t.tier}">${t.tier} ${t.threshold}%+<br>
        <small>${fmtK(t.needDps)} DPS &middot; ${sign}${t.pctDeltaNeeded}%</small></span>`;
    })
    .join('');

  const head = p.insufficientData
    ? `<b>Parse</b> ${cur != null ? `<b class="p-${p.currentTier}">${cur}%</b>` : '<span class="muted">unavailable</span>'}`
    : `<b>This pull:</b> <b class="p-${p.currentTier}">${cur}% ${esc(p.currentTier)}</b>
       <small>${p.projected ? '(projected — a wipe is never ranked)' : '(Warcraft Logs’ own number)'}</small>`;

  return `
    <div class="parse-plan">
      <h3>Parse &amp; next colour</h3>
      <p>${head}</p>
      ${chips ? `<div class="tier-chips">${chips}</div>` : ''}
      <p class="parse-plan-text">${md(p.text)}</p>
    </div>`;
}

// --- rotation vs the top parser, for the pull you picked ---

function renderRaidComparison(cmp) {
  if (!cmp?.rotation) return '';
  const rot = cmp.rotation;
  const rows = (rot.rows || [])
    .slice(0, 24)
    .map((r) => {
      const tag = r.kind === 'amp' ? ' <small class="util">amp</small>' : r.kind === 'util' ? ' <small class="util">util</small>' : '';
      const diff = `${r.diffPp > 0 ? '+' : ''}${r.diffPp}pp`;
      return `<tr class="${Math.abs(r.diffPp) >= 2 ? 'rot-big' : ''}"><td>${esc(r.name)}${tag}</td>
        <td class="num">${r.mine}</td><td class="num">${r.them}</td><td class="num">${diff}</td></tr>`;
    })
    .join('');
  const order = rot.order || { mine: [], them: [] };

  return `
    <h3>Rotation vs top parser <small>— pull #${cmp.myPullId}${cmp.myPullKill ? ' (a kill)' : ''} vs ${esc(cmp.against)}'s ${esc(cmp.difficultyName || '')} kill</small></h3>
    <p class="raid-verdict">${esc(rot.summary)}</p>
    <div class="raid-stats">
      <span>Spell mix <b>${rot.similarityPct}%</b></span>
      <span>Cast order <b>${rot.sequencePct}%</b></span>
      <span>Same rotation <b>${rot.sameRotation ? 'yes' : 'no'}</b></span>
    </div>
    <details open><summary>Per-ability cast counts — you vs ${esc(cmp.against)}</summary>
      <p class="table-note"><small>Counts over this pull's window on both sides. <b>+pp</b> = you cast a larger share of your total on this button than they do; <b>−pp</b> = they lean on it more than you. Rows with a big gap are highlighted.</small></p>
      <table class="rot-table"><thead><tr><th>Ability</th><th>You</th><th>${esc(cmp.against)}</th><th>Diff</th></tr></thead><tbody>${rows}</tbody></table>
    </details>
    ${
      cmp.damageDone
        ? renderDamageDone(cmp.damageDone)
        : `<p class="table-note"><small><b>Per-ability damage table omitted for this pull.</b> ${esc(cmp.damageDoneOmittedReason || '')}</small></p>`
    }
    <details><summary>Cast-order flow — read their column top-down to learn the sequence</summary>
      ${renderCastOrderCols(order.them, order.mine, cmp.against)}
    </details>`;
}
