// The raid side: paste a log -> pick a boss -> pick a pull -> the same
// eight-section report the M+ view shows.
//
// Raid data comes straight from a report rather than from rankings, because
// rankings only ever contain KILLS — a wipe appears in no ranking anywhere, and
// wipes are the whole point on progress. The per-pull consistency table and the
// death-timing read are raid-only; everything below them is the shared report.
import { $, esc, fmtK, fmtPct, fmtSec, fmtTime, pctClass, pctColor, boardRow, EMPTY } from './util.js';
import { state, charQuery, showLoading, hideLoading, skeleton } from './state.js';
import { renderReport } from './report.js';
import { dpsChartSvg, wireDpsBrush, setCastWindow, castOrderSlot, castOrderColumn } from './chart.js';
import { sigilUrl } from './icons.js';

let raidState = { code: null, difficulty: '5', bosses: [] };
// every boss of the live tier, harvested from the overview — the "learn a boss"
// picker needs bosses you have NOT killed (that's the point of it), so it can't
// be built from your own kills
let tierBosses = [];
let learn = { data: null };

/**
 * The raid view. Your RANKED PARSES are the default — every raid of the tier and
 * what you scored on each boss, straight from WCL, exactly like the M+ overview.
 * You shouldn't need to go hunting for a report URL to look at a boss you killed.
 *
 * Pasting a log is still here, but demoted to what it's actually for: WIPES.
 * Rankings only ever contain kills, so a progression pull appears in no ranking
 * anywhere and a report is the only way to see it.
 */
export function renderRaidCard() {
  const el = $('#raid');
  if (!el) return;
  el.innerHTML = `
    <div id="raid-zones" class="card"><p class="muted">Loading your raid parses…</p></div>

    <details class="card" id="raid-log-card">
      <summary><b>Analyse a specific log</b> <span class="muted">for wipes / progression pulls</span></summary>
      <p><small>Your kills are already above, ranked. Paste a report only when you want a pull that
        <b>isn't</b> a kill: a wipe appears in no ranking anywhere, so the log is the only place to see it.</small></p>
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
    </details>

    <details class="card" id="raid-learn-card">
      <summary><b>Learn a boss</b> <span class="muted">how the top 10 of your spec play it</span></summary>
      <p><small>The rotation of a top-ranked <b>${esc(state.activeSpec || '')} ${esc(
        state.activeChar.classLabel || state.activeChar.className || ''
      )}</b> kill of a boss. The top 10 go in a dropdown; only the one you pick is fetched.
        No comparison, no log, no kill of your own needed — this is for reading <b>before</b> you pull.</small></p>
      <form id="learn-form" class="raid-form">
        <label class="spec-pick">boss <select id="learn-boss"></select></label>
        <label class="spec-pick">difficulty
          <select id="learn-diff">
            <option value="5" selected>Mythic</option>
            <option value="4">Heroic</option>
            <option value="3">Normal</option>
          </select>
        </label>
        <button type="submit">Show rotation</button>
      </form>
      <div id="learn-result"></div>
    </details>

    <div id="raid-result"></div>`;

  $('#raid-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadRaidBosses();
  });
  $('#learn-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadBossRotations();
  });
  loadRaidZones();
}

/**
 * All raids of the tier + this character's parse on every boss.
 * @param {boolean} [refresh] bypass the disk cache — the ranked parses are cached,
 *   so last night's kill won't appear here until you ask for it fresh.
 */
async function loadRaidZones(refresh = false) {
  const el = $('#raid-zones');
  showLoading(refresh ? 'Refreshing your raid parses, bypassing the cache…' : 'Loading your raid parses…');
  if (el) el.innerHTML = skeleton(5);
  try {
    const params = charQuery();
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/raid/overview?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderRaidZones(data.zones ?? []);
    hideLoading();
  } catch (err) {
    hideLoading();
    if (el) el.innerHTML = `<span class="error">Could not load raid parses: ${esc(err.message)}</span>`;
  }
}

function renderRaidZones(zones) {
  const el = $('#raid-zones');
  if (!el) return;
  if (!zones.length) {
    el.innerHTML = `<p class="muted">No raids found for this expansion.</p>`;
    return;
  }

  const zoneBlock = (z) => {
    // Boss order is pull order — that's the shape of a raid tier, so unlike the
    // M+ list this one is NOT re-ranked. A boss you haven't killed still holds
    // its place in the instance, dimmed.
    const rows = z.bosses
      .map((b, i) => {
        const killed = b.kills > 0;
        return boardRow({
          rank: i + 1,
          color: pctColor(b.bestPercent),
          iconUrl: sigilUrl('raid'),
          title: b.name,
          subtitle: killed ? `${b.kills} kill${b.kills === 1 ? '' : 's'}` : 'no kill',
          pct: b.bestPercent,
          value: killed ? `<span class="${pctClass(b.bestPercent)}">${fmtPct(b.bestPercent)}%</span>` : EMPTY,
          meta: killed && b.bestDps ? `<span class="stat"><i>dps</i> ${fmtK(b.bestDps)}</span>` : '',
          // no button for a boss with no kill — the row already says so, and a
          // second "no kill" in the action column is just the same word twice
          action: killed ? `<button class="mini" data-analyze="${b.encounterID}">analyze</button>` : '',
          dim: !killed,
          attrs: killed ? `data-encounter="${b.encounterID}"` : '',
          clickable: killed,
        });
      })
      .join('');

    const done = z.bossCount ? Math.round((z.killedCount / z.bossCount) * 100) : 0;
    return `
      <div class="zone">
        <div class="zone-head">
          <h3>${esc(z.zoneName)} ${z.patch ? `<span class="patch-tag">${esc(z.patch)}</span>` : ''}</h3>
          <div class="progress" title="${z.killedCount} of ${z.bossCount} bosses killed">
            <div class="progress-fill" style="width: ${done}%"></div>
          </div>
          <span class="zone-stats">
            <b>${z.killedCount}/${z.bossCount}</b> <small class="muted">killed</small>
            ${
              z.bestAverage != null
                ? `<b class="${pctClass(z.bestAverage)}">${fmtPct(z.bestAverage)}%</b> <small class="muted">best avg</small>`
                : ''
            }
          </span>
        </div>
        <div class="board parse">${rows}</div>
      </div>`;
  };

  el.innerHTML = `
    <div class="board-head">
      <span class="headline"><small class="muted">Raid parses</small></span>
      <button id="refresh-raids" class="mini" title="Re-fetch your raid parses from Warcraft Logs, bypassing the local cache">↻ Refresh</button>
    </div>
    ${zones.map(zoneBlock).join('')}
    <p class="table-note"><small>Click a boss to analyse your best ranked kill on it — no log needed.
      Parses are cached, so after a raid night hit <b>↻ Refresh</b> to pull your new kills.
      For a <b>wipe</b>, use "Analyse a specific log" below: wipes appear in no ranking.
      Only raids live on the current patch are shown — Warcraft Logs lists next-patch raids months early, and they're filtered out
      by their PTR partition.</small></p>`;

  el.querySelectorAll('[data-encounter], [data-analyze]').forEach((n) =>
    n.addEventListener('click', () => {
      const id = n.dataset.analyze ?? n.dataset.encounter;
      if (id) loadRaidBoss(Number(id));
    })
  );
  $('#refresh-raids').addEventListener('click', () => loadRaidZones(true));

  // the "learn a boss" picker lists every boss of the tier, killed or not
  tierBosses = zones.flatMap((z) => z.bosses.map((b) => ({ ...b, zoneName: z.zoneName })));
  const sel = $('#learn-boss');
  if (sel) {
    sel.innerHTML = tierBosses
      .map((b) => `<option value="${b.encounterID}">${esc(b.name)}${b.kills ? '' : ' (not killed)'}</option>`)
      .join('');
  }
}

// --- "Learn a boss": the top 10 rotations of your spec, and nothing else ---
//
// Not a comparison. There is no "you" in this view — no gaps, no parse, no DPS
// chart. It answers one question: what does this spec actually press on this boss,
// and when do they burn their cooldowns.

async function loadBossRotations(player = '', refresh = false) {
  const root = $('#learn-result');
  const encounterID = Number($('#learn-boss').value);
  if (!root || !encounterID) return;
  const difficulty = $('#learn-diff').value;
  showLoading(
    `${refresh ? 'Re-fetching' : 'Reading'} ${player ? esc(player) + "'s" : "the #1 parse's"} casts. <small>One log; ~5s, cached after.</small>`
  );
  root.innerHTML = skeleton(4);
  try {
    const params = charQuery();
    // the character is irrelevant here; only their class+spec is used
    params.delete('name');
    params.delete('server');
    params.set('encounter', encounterID);
    params.set('difficulty', difficulty);
    if (player) params.set('player', player);
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/raid/rotations?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    learn = { data };
    renderBossRotations();
    hideLoading();
  } catch (err) {
    hideLoading();
    root.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}

function renderBossRotations() {
  const root = $('#learn-result');
  const d = learn.data;
  if (!root || !d?.selected) return;
  const p = d.selected;

  // The roster is free (it's the ranked page). Only the player picked here is ever
  // fetched — loading all ten to read one column was ten times the API cost.
  const opts = d.players
    .map(
      (x) =>
        `<option value="${esc(x.name)}" ${x.name === p.name ? 'selected' : ''}>#${x.rank} ${esc(x.name)} — ${fmtK(x.dps)} DPS</option>`
    )
    .join('');

  root.innerHTML = `
    <h3>${esc(d.boss ?? 'Boss')} <small>&middot; ${esc(d.difficultyName || '')} &middot; top ${d.players.length} ${esc(d.specName)} ${esc(
      d.className
    )}</small></h3>

    <label class="spec-pick">rotation of
      <select id="learn-player">${opts}</select>
    </label>
    <span class="muted"><small>&middot; ${fmtK(p.dps)} DPS &middot; ${fmtTime(p.durationSec * 1000)} &middot; ${p.cpm} CPM</small></span>
    <button id="refresh-learn" class="mini" title="Re-fetch the rankings and this rotation from Warcraft Logs, bypassing the local cache">↻ Refresh</button>

    <div class="ord-wrap learn-ord">
      ${castOrderColumn(p.castOrder, `#${p.rank} ${p.name} — cast order`, { cap: Infinity, brushable: false })}
    </div>
    <p class="table-note"><small>One top parser's kill, top to bottom, with their <b>cooldowns &amp; consumables pinned</b> above the sequence —
      every potion, every on-use trinket, and any ability pressed at cooldown frequency that deals damage or grants a buff
      (derived from the run, not a per-class or per-item list).
      Switch player above to see how a different one played the same boss: where they <b>differ</b> is where the fight allows a choice,
      where they <b>agree</b> is the rotation. Only the player you pick is fetched.</small></p>`;

  $('#learn-player').addEventListener('change', (e) => loadBossRotations(e.target.value));
  $('#refresh-learn').addEventListener('click', () => loadBossRotations(p.name, true));
}

/** Analyse a boss from your own best ranked kill — the paste-free path. */
async function loadRaidBoss(encounterID, compareTo = '', refresh = false) {
  const root = $('#raid-result');
  if (!root) return;
  showLoading(
    refresh
      ? 'Re-fetching this boss, bypassing the cache…'
      : 'Analysing your best kill on this boss. <small>Pulls damage events; ~15s the first time, cached after.</small>'
  );
  root.innerHTML = skeleton(6);
  root.scrollIntoView({ block: 'start', behavior: 'smooth' });
  try {
    const params = charQuery();
    params.set('encounter', encounterID);
    params.set('difficulty', raidState.difficulty);
    if (compareTo) params.set('compareTo', compareTo);
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/raid/boss?${params}`);
    const view = await res.json();
    if (!res.ok) throw new Error(view.error || `HTTP ${res.status}`);
    renderRaidPull(view, root, { encounterID, difficulty: raidState.difficulty, fromRankings: true });
    hideLoading();
  } catch (err) {
    hideLoading();
    root.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
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
      const prog = b.kills > 0 ? `<span class="p-orange">killed</span>` : b.bestPctRemaining != null ? `best ${b.bestPctRemaining}% left` : EMPTY;
      return `<button type="button" class="mini raid-boss" data-encounter="${b.encounterID}" data-diff="${b.difficulty}">
        ${esc(b.name)} <small>&middot; ${esc(b.difficultyName || '')} &middot; ${b.pulls} pull${b.pulls === 1 ? '' : 's'} &middot; ${prog}</small></button>`;
    })
    .join('');
  $('#raid-bosses').innerHTML = `<div class="raid-boss-list">${rows}</div>`;
  $('#raid-bosses')
    .querySelectorAll('.raid-boss')
    .forEach((btn) => btn.addEventListener('click', () => loadRaidProgression(btn.dataset.encounter, btn.dataset.diff)));
}

async function loadRaidProgression(encounterID, difficulty, refresh = false) {
  showLoading(
    refresh
      ? 'Re-fetching every pull, bypassing the cache…'
      : 'Analysing every pull. <small>Fetches your casts per attempt and the kill benchmark; up to ~20s the first time, cached after.</small>'
  );
  $('#raid-result').innerHTML = skeleton(5);
  try {
    const params = charQuery();
    if (refresh) params.set('refresh', '1');
    params.set('code', raidState.code);
    params.set('encounter', encounterID);
    params.set('difficulty', difficulty);
    const res = await fetch(`/api/raid/report?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderRaidProgression(data);
    hideLoading();
  } catch (err) {
    hideLoading();
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
      const num = (v, fmt) => (r.analysed && v != null ? fmt(v) : '<span class="muted">·</span>');
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
        <td>${r.analysed ? deathCell(r) : '<span class="muted">·</span>'}</td>
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
    <h3>${esc(data.boss)} <small>&middot; ${esc(data.difficultyName || '')} &middot; ${c.pulls} pull${c.pulls === 1 ? '' : 's'}</small>
      <button id="refresh-prog" class="mini" title="Re-read this report from Warcraft Logs, bypassing the local cache — use it if you've added pulls since">↻ Refresh</button>
    </h3>
    <p class="raid-verdict"><b class="${verdictClass}">${esc((c.verdict || '').replace('-', ' ').toUpperCase())}</b> output — ${esc(p.text)}</p>
    <div class="raid-stats">
      <span>Mean active DPS <b>${fmtK(c.meanActiveDps)}</b></span>
      <span>Best <b>${fmtK(c.bestActiveDps)}</b></span>
      <span>Worst <b>${fmtK(c.worstActiveDps)}</b></span>
      <span>Swing <b>${c.swingPct != null ? c.swingPct + '%' : EMPTY}</b></span>
      <span>Early deaths <b>${dt.earlyDeaths ?? 0}/${dt.scoredWipes ?? 0} wipes</b></span>
    </div>
    ${benchLine}
    <div id="raid-current" class="raid-current"></div>
    <p class="table-note"><small><b>Click any pull below</b> to analyse that specific pull — DPS over time, boss health, rotation timeline, cast order, and its rotation vs the top parser.
      ${
        sampled
          ? `The summary above is computed from the <b>${c.analysedPulls} longest</b> of ${c.pulls} pulls (each pull costs API calls); rows showing <span class="muted">·</span> have no summary stats yet, but you can still click them and they'll be analysed in full.`
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

  $('#refresh-prog').addEventListener('click', () => loadRaidProgression(data.encounterID, data.difficulty, true));
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

// --- one pull: the SAME eight sections the M+ report shows ---
//
// The raid view used to have its own bespoke render — and was missing consumables,
// biggest gaps, resource management and an opponent picker entirely. It now feeds
// the shared renderer, so a section exists in one place and both views get it.

async function loadRaidPullChart(fightID, encounterID, difficulty, compareTo = '', refresh = false) {
  const root = $('#raid-pull-chart');
  if (!root) return;
  showLoading(
    `${refresh ? 'Re-fetching' : 'Loading'} pull #${fightID}. <small>Damage events for both runs; ~15s the first time, cached after.</small>`
  );
  root.innerHTML = skeleton(4);
  const cur0 = $('#raid-current');
  if (cur0) cur0.innerHTML = `<p class="raid-current-line muted">Analysing pull #${fightID}…</p>`;
  try {
    const params = charQuery();
    params.set('code', raidState.code);
    params.set('encounter', encounterID);
    params.set('difficulty', difficulty);
    params.set('fight', fightID);
    if (compareTo) params.set('compareTo', compareTo);
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/raid/pull?${params}`);
    const view = await res.json();
    if (!res.ok) throw new Error(view.error || `HTTP ${res.status}`);
    const cur = $('#raid-pull-chart');
    if (!cur) return; // the user switched pulls while this was loading
    renderRaidPull(view, cur, { encounterID, difficulty });
    renderCurrentPull(view); // re-anchor the night's verdict to this pull
    hideLoading();
  } catch (err) {
    hideLoading();
    const cur = $('#raid-pull-chart');
    if (cur) cur.innerHTML = `<span class="error">Pull analysis failed: ${esc(err.message)}</span>`;
  }
}

function renderRaidPull(view, root, ctx) {
  const w = view.window || {};

  // The honesty banner: a wipe is only ever compared against the slice of the kill
  // covering the same chunk of boss health. Raid-only — M+ has no such thing.
  const banner = w.truncated
    ? `<p class="raid-verdict"><b>Fair-window comparison.</b> Your pull took the boss from <b>100% → ${w.cutoffPct}%</b> and then wiped,
        so it's compared against only the matching slice of ${esc(view.otherLabel)}'s kill — the first <b>${fmtSec(w.theirCutoffSec)}</b>,
        where their boss also hit ${w.cutoffPct}% (their full kill ran ${fmtSec(w.theirFullSec)}). Same chunk of boss, same phases.</p>`
    : `<p class="raid-verdict"><b>Full-fight comparison.</b> Your pull was a <b>kill</b> (100% → 0%), so it's measured against
        ${esc(view.otherLabel)}'s entire kill — no truncation needed.</p>`;

  // One renderer, two callers — so the refresh has to re-run whichever one produced
  // this view: the ranked-kill path (no log) or the specific-pull path.
  const reload = (refresh) =>
    ctx.fromRankings
      ? loadRaidBoss(ctx.encounterID, view.compare?.selected ?? '', refresh)
      : loadRaidPullChart(view.pull.id, ctx.encounterID, ctx.difficulty, view.compare?.selected ?? '', refresh);

  root.innerHTML = `
    <div class="card">
      <p class="raid-refresh">
        <button id="refresh-pull" class="mini" title="Re-fetch this analysis from Warcraft Logs, bypassing the local cache">↻ Refresh</button>
      </p>
      ${banner}${renderReport(view)}
    </div>`;
  root.querySelector('#refresh-pull').addEventListener('click', () => reload(true));

  // Section 1's chart: the raid version overlays boss health on a right-hand axis,
  // and the series are already in the payload (no second fetch, unlike M+).
  const chartEl = root.querySelector('#dps-chart');
  if (chartEl) {
    const chart = {
      state: {
        order: view.castOrder ?? { mine: [], them: [] },
        otherLabel: view.otherLabel,
        durationSec: Math.max(view.mine.durationMs, view.other.durationMs) / 1000,
      },
    };
    chartEl.classList.remove('dps-chart-loading');
    chartEl.innerHTML =
      dpsChartSvg(view.mine, view.other, chart, { bossHealth: view.bossHealth }) +
      `<p class="table-note"><small>5-second bins of effective damage (includes your pets). The <b>dashed lines</b> are boss health on the
        right axis — yours ends where you wiped, theirs at the same % — so you can see where in the boss's health your output landed.
        <b>Drag across the chart</b> to see only the casts from that window.</small></p>` +
      castOrderSlot();
    wireDpsBrush(chartEl, chart);
    setCastWindow(chartEl, chart, 0, chart.state.durationSec);
  }

  const picker = root.querySelector('#compare-to');
  if (picker) {
    picker.addEventListener('change', (e) =>
      ctx.fromRankings
        ? loadRaidBoss(ctx.encounterID, e.target.value)
        : loadRaidPullChart(view.pull.id, ctx.encounterID, ctx.difficulty, e.target.value)
    );
  }

  root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
