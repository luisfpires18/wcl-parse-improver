// The eight-section report, rendered identically for Mythic+ and for a raid pull.
//
// Both analysis paths converge on one view model and one renderer, so a section
// exists in exactly one place instead of being reimplemented per view.
import { esc, fmtK, fmtPct, pctClass, EMPTY } from './util.js';
import { renderTimelineSection } from './chart.js';

// The eight sections, in the order they appear. Each is a pure function of the
// view model, so M+ and a raid pull produce identical markup from identical data.
export function renderReport(view) {
  return [
    renderCompare(view),        // 1 — opponent picker + DPS chart mount
    renderTopSpells(view.abilities), // 2 — where each of you gets your damage
    // cast order lives inside the chart block (the brush writes into it)
    renderRotation(view),       // 3 — rotation timeline
    renderConsumables(view.consumables), // 4
    renderGear(view.gear),      // 4b — enchant/gem check
    renderParse(view.parse),    // 5
    renderGaps(view.gaps),      // 6
    renderResources(view.resources), // 7
    renderAbilities(view.abilities), // 8
  ].join('');
}

/**
 * Top damage sources, you vs them — the shape of where each of you gets your
 * damage, as ranked bars, plus a one-line read of what leads for each. Built from
 * the same per-ability data section 8 tables out, so it costs nothing extra.
 */
function renderTopSpells(a) {
  if (!a?.rows?.length) return '';
  const t = a.totals || {};

  const rank = (key, totalKey) => {
    const list = a.rows.filter((r) => r[key] > 0).sort((x, y) => y[key] - x[key]).slice(0, 6);
    return { list, max: list[0]?.[key] || 1, sum: t[totalKey] || list.reduce((s, r) => s + r[key], 0) || 1 };
  };
  const mine = rank('myAmount', 'myDamage');
  const theirs = rank('theirAmount', 'theirDamage');
  if (!mine.list.length && !theirs.list.length) return '';

  const share = (v, sum) => Math.round((100 * v) / sum);
  const column = (d, key, cls) =>
    `<ol class="spell-bars">${d.list
      .map(
        (r) => `<li class="spell-bar">
          <span class="spell-name" title="${esc(r.name)}">${esc(r.name)}</span>
          <span class="spell-track"><span class="spell-fill ${cls}" style="width: ${Math.max(4, Math.round((100 * r[key]) / d.max))}%"></span></span>
          <span class="spell-pct">${share(r[key], d.sum)}%</span>
        </li>`
      )
      .join('')}</ol>`;

  // The read: what each of you leans on, and — when they differ — how much you
  // get from their signature spell, which is usually the actionable bit.
  const myTop = mine.list[0];
  const theirTop = theirs.list[0];
  let summary = '';
  if (myTop && theirTop) {
    const mp = share(myTop.myAmount, mine.sum);
    const tp = share(theirTop.theirAmount, theirs.sum);
    if (myTop.name === theirTop.name) {
      summary = `You both lead with <b>${esc(myTop.name)}</b> — you ${mp}% of your damage, ${esc(a.otherLabel)} ${tp}% of theirs.`;
    } else {
      const mineOnTheirs = a.rows.find((r) => r.name === theirTop.name);
      const myShare = mineOnTheirs ? share(mineOnTheirs.myAmount, mine.sum) : 0;
      summary =
        `Your top spell is <b>${esc(myTop.name)}</b> (${mp}% of your damage), while ${esc(a.otherLabel)}'s is ` +
        `<b>${esc(theirTop.name)}</b> (${tp}%). You get ${myShare}% from ${esc(theirTop.name)}.`;
    }
  }

  return `
    <section class="card-section">
      <h3>Top damage sources <small>you vs ${esc(a.otherLabel)}</small></h3>
      ${summary ? `<p class="section-note">${summary}</p>` : ''}
      <div class="spell-cols">
        <div class="spell-col"><h4>You</h4>${column(mine, 'myAmount', 'me')}</div>
        <div class="spell-col"><h4>${esc(a.otherLabel)}</h4>${column(theirs, 'theirAmount', 'them')}</div>
      </div>
    </section>`;
}

/**
 * Section 1 — who you're being measured against, and the DPS-over-time chart.
 *
 * Top 10 of the spec plus the 5 parses whose ROUTE most resembles yours (similar
 * duration => similar pull count, so the DPS gap is more purely execution and less
 * "they skipped half the dungeon"). Everything below compares against whoever is
 * selected here — there is no cohort median any more.
 */
function renderCompare(view) {
  const { top = [], similar = [], selected } = view.compare ?? {};
  const opt = (p, label) =>
    `<option value="${esc(p.name)}" ${p.name === selected ? 'selected' : ''}>${esc(label)}</option>`;

  const picker = `
    <select id="compare-to" class="mini">
      <optgroup label="Top ${top.length}">
        ${top.map((p) => opt(p, `#${p.rank} ${p.name} — ${fmtK(p.dps)}`)).join('')}
      </optgroup>
      ${
        similar.length
          ? `<optgroup label="Parses most like your run">
               ${similar.map((p) => opt(p, `${p.name} — ${p.matchPct}% route match, ${fmtK(p.dps)}`)).join('')}
             </optgroup>`
          : ''
      }
    </select>`;

  const h = view.headline;
  const gap = h.dpsGapPct == null ? '' : h.dpsGapPct > 0
    ? `<b class="p-gray">${h.dpsGapPct}% behind</b>`
    : `<b class="p-green">${Math.abs(h.dpsGapPct)}% ahead</b>`;

  return `
    <section class="card-section">
      <h3>You vs <span id="vs-name">${esc(h.otherLabel ?? EMPTY)}</span></h3>
      <p class="vs-line">
        <b>${fmtK(h.myDps)}</b> you &nbsp;vs&nbsp; <b>${fmtK(h.theirDps)}</b> them &nbsp;${gap}
      </p>
      <p>Compare against: ${picker} ${view.levelPicker ?? ''}</p>
      <div id="dps-chart" class="dps-chart-loading">Loading DPS over time…</div>
    </section>`;
}

/** Section 3 — rotation timeline, with the two honest rotation-match numbers. */
function renderRotation(view) {
  if (!view.timeline) return '';
  const m = view.rotationMatch;
  const match = m
    ? `<p class="section-note">Rotation match: <b>${m.spellMixPct}%</b> spell mix (which buttons, in what proportion) ·
       <b>${m.castOrderPct}%</b> cast order (the sequence you press them in).</p>`
    : '';
  return `<section class="card-section">${renderTimelineSection(view.timeline, null)}${match}</section>`;
}

/** Section 5 — current parse colour and the DPS each next colour costs. */
function renderParse(p) {
  if (!p) return '';
  const chips = (p.tiers ?? [])
    .map((t) => {
      const need = t.needDps ?? t.estDps;
      const sign = t.dpsDelta >= 0 ? '+' : '';
      return `<span class="tier-chip p-${t.tier}">${t.tier} ${t.threshold}%+<br>
        <small>${sign}${t.pctDeltaNeeded}% DPS${need ? ` · ${fmtK(need)}` : ''}</small></span>`;
    })
    .join('');
  const cur = p.currentPercent ?? p.currentTier;
  return `
    <section class="card-section">
      <h3>Parse &amp; next colour</h3>
      ${
        p.currentPercent != null
          ? `<p>This run: <b class="${pctClass(p.currentPercent)}">${fmtPct(p.currentPercent)}% ${esc(p.currentTier ?? '')}</b></p>`
          : p.currentTier
            ? `<p>Current tier: <b class="p-${p.currentTier}">${esc(p.currentTier)}</b></p>`
            : ''
      }
      ${chips ? `<div class="tier-chips">${chips}</div>` : ''}
      ${p.text ? `<p class="section-note">${esc(p.text)}</p>` : ''}
    </section>`;
}

/**
 * Section 6 — biggest gaps: what stands out.
 *
 * The old orange square was the raw severity number (a rough %-DPS estimate),
 * which read like a precise score. It never was one — it only ever meant "fix this
 * first". So it's shown as a PRIORITY instead: ★★★ High / ★★ Medium / ★ Low.
 */
function renderGaps(gaps) {
  if (!gaps?.length) {
    return `<section class="card-section"><h3>Biggest gaps</h3>
      <p class="muted">Nothing stands out against this player — no significant gaps found.</p></section>`;
  }

  // "you cast less" is not actionable; name the buttons the missing casts are.
  const behindTable = (g) =>
    g.behind?.length
      ? `<table class="rot-table gap-behind">
           <thead><tr><th>Missing casts, by ability</th><th>You</th><th>Them</th><th>Behind by</th></tr></thead>
           <tbody>${g.behind
             .map(
               (b) => `<tr><td>${esc(b.name)}</td><td class="num">${b.mine}</td><td class="num">${b.them}</td>
                 <td class="num p-orange">−${b.behindBy}</td></tr>`
             )
             .join('')}</tbody>
         </table>`
      : '';

  const items = gaps
    .map((g) => {
      const p = g.priority ?? { rank: 3, label: 'Low' };
      const stars = '★'.repeat(4 - p.rank) + '☆'.repeat(p.rank - 1);
      return `<li class="gap prio-${p.rank}">
        <div class="gap-head">
          <span class="prio" title="Priority ${p.rank} of 3">${stars} ${esc(p.label)}</span>
          <b>${esc(g.title)}</b>
          <span class="vals">you <b>${esc(String(g.mine))}</b>${g.unit ? ' ' + esc(g.unit) : ''}
            · them <b>${esc(String(g.cohort))}</b>${g.unit ? ' ' + esc(g.unit) : ''}</span>
        </div>
        <div class="gap-advice">${esc(g.advice ?? '')}</div>
        ${behindTable(g)}
      </li>`;
    })
    .join('');

  return `
    <section class="card-section">
      <h3>Biggest gaps <small>what stands out</small></h3>
      <ol class="gaps">${items}</ol>
      <p class="table-note"><small><b>Priority</b> is a band, not a score: ★★★ High, ★★ Medium, ★ Low. It comes from a rough estimate
        of how much DPS each gap costs, and is only good enough to say which to fix first.</small></p>
    </section>`;
}

/**
 * Section 8 — per-ability casts AND damage, you vs them.
 *
 * Highlights the real discrepancies rather than every row: a RELATIVE cast gap
 * (±25%+ on an ability either of you pressed a meaningful number of times), and
 * abilities one of you used and the other never touched. A flat "diff >= 5" rule
 * missed a 3-vs-8 cooldown while flagging noise on a filler cast 200 times.
 */
function renderAbilities(a) {
  if (!a?.rows?.length) return '';
  const fmtM = (v) => (v ? (v / 1e6).toFixed(1) + 'm' : EMPTY);

  const flag = (r) => {
    const max = Math.max(r.myCasts, r.theirCasts);
    if (max < 3) return null; // too few presses either way to mean anything
    if (r.myCasts === 0) return { cls: 'disc-none', why: `you never cast this; they used it ${r.theirCasts}×` };
    if (r.theirCasts === 0) return { cls: 'disc-extra', why: `they never cast this; you used it ${r.myCasts}×` };
    const rel = (r.theirCasts - r.myCasts) / r.theirCasts;
    if (rel >= 0.25) return { cls: 'disc-behind', why: `${Math.round(100 * rel)}% fewer casts than them` };
    if (rel <= -0.25) return { cls: 'disc-ahead', why: `${Math.round(-100 * rel)}% more casts than them` };
    return null;
  };

  const rows = a.rows
    .slice(0, 30)
    .map((r) => {
      const f = flag(r);
      return `<tr class="${f ? f.cls : ''}"${f ? ` title="${esc(f.why)}"` : ''}>
        <td>${esc(r.name)}${f ? ` <span class="disc-dot">●</span>` : ''}</td>
        <td class="num">${r.myCasts || EMPTY}</td>
        <td class="num">${r.theirCasts || EMPTY}</td>
        <td class="num">${r.castDiff > 0 ? '+' : ''}${r.castDiff || ''}</td>
        <td class="num sep">${fmtM(r.myAmount)}</td>
        <td class="num">${fmtM(r.theirAmount)}</td>
      </tr>`;
    })
    .join('');

  const t = a.totals;
  return `
    <section class="card-section">
      <h3>Per-ability <small>you vs ${esc(a.otherLabel)}</small></h3>
      <table class="dmg-table">
        <thead>
          <tr><th rowspan="2">Ability</th><th colspan="3" class="grp">Casts</th><th colspan="2" class="grp sep">Damage</th></tr>
          <tr><th>You</th><th>Them</th><th>Diff</th><th class="sep">You</th><th>Them</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td></td><td></td><td></td>
          <td class="num sep">${fmtM(t.myDamage)}</td><td class="num">${fmtM(t.theirDamage)}</td></tr></tfoot>
      </table>
      <p class="table-note"><small>Sorted by damage. Highlighted rows are the real discrepancies — <b class="p-orange">orange</b> = you cast it
        25%+ less than them (or never), <b class="p-blue">blue</b> = 25%+ more (or they never did). Hover a row for why.
        Rows either of you pressed fewer than 3 times aren't flagged; that's noise.</small></p>
    </section>`;
}

/**
 * Section 4 — Consumables & party buffs.
 *
 * Consumables (flask/food/oil/rune/potion) are yours to fix. Party buffs are not:
 * they're what someone ELSE applied to you, identified from the log's own
 * apply/remove events rather than a hardcoded list of raid buffs. Showing the ones
 * their group had and yours didn't matters — it's a real slice of the DPS gap that
 * is NOT a rotation mistake, and knowing that stops you hunting for one.
 */
export function renderConsumables(c) {
  if (!c) return '';
  const cell = (v) => (v ? `${esc(v.name)} <small class="muted">${v.pct}%</small>` : '<span class="p-gray">none</span>');

  const rows = c.rows
    .map(
      (r) => `<tr class="${r.missing ? 'rot-big' : ''}">
        <td>${esc(r.label)}</td>
        <td>${cell(r.mine)}</td>
        <td>${cell(r.them)}</td>
      </tr>`
    )
    .join('');

  // Potions are pressed repeatedly, so the question is "how many, out of how many
  // the fight allowed" — not what % of it you spent under one.
  const pot = (p) => {
    if (!p || p.max == null) return '<span class="muted">·</span>';
    const short = p.missed > 0;
    return `<b class="${short ? 'p-orange' : 'p-green'}">${p.used}</b> <span class="muted">of ${p.max} possible</span>` +
      (p.names.length ? ` <small class="muted">(${p.names.map(esc).join(', ')})</small>` : '');
  };
  const potionRow = `
    <tr class="${c.potions?.mine?.missed > 0 ? 'rot-big' : ''}">
      <td>Potions</td>
      <td>${pot(c.potions?.mine)}</td>
      <td>${pot(c.potions?.them)}</td>
    </tr>`;

  const gave = c.partyBuffs?.theyHadIDidnt ?? [];
  const partyRows = (c.partyBuffs?.them ?? [])
    .map((b) => {
      const mineHas = (c.partyBuffs.mine ?? []).find((m) => m.name === b.name);
      return `<tr class="${mineHas ? '' : 'rot-big'}">
        <td>${esc(b.name)}</td>
        <td>${mineHas ? `${mineHas.pct}%` : '<span class="p-gray">none</span>'}</td>
        <td>${b.pct}%</td>
      </tr>`;
    })
    .join('');

  return `
    <section class="card-section">
      <h3>Consumables &amp; party buffs <small>you vs ${esc(c.otherLabel)}</small></h3>
      <table class="rot-table">
        <thead><tr><th>Consumable</th><th>You</th><th>${esc(c.otherLabel)}</th></tr></thead>
        <tbody>${rows}${potionRow}</tbody>
      </table>
      <p class="table-note"><small>Flask/food/rune show uptime. Potions show <b>how many you drank vs how many the fight allowed</b> —
        they share a 5-minute cooldown and you can pre-pot, so the ceiling is 1 + one per 5 minutes.
        Weapon oil isn't listed: it applies no combat aura, so it isn't in the log at all.</small></p>
      ${c.notes?.length ? c.notes.map((n) => `<p class="section-note">${esc(n)}</p>`).join('') : ''}
      ${
        partyRows
          ? `<h4>Party buffs <small>applied to you by someone else</small></h4>
             <table class="rot-table">
               <thead><tr><th>Buff</th><th>You</th><th>${esc(c.otherLabel)}</th></tr></thead>
               <tbody>${partyRows}</tbody>
             </table>
             ${
               gave.length
                 ? `<p class="section-note">Their group gave them ${gave
                     .map((b) => esc(b.name))
                     .join(', ')} and yours didn't. That's a real part of the DPS gap — and it is <b>not</b> your rotation.</p>`
                 : ''
             }
             <p class="table-note"><small>Identified from the log's own apply/remove events (someone else's <code>sourceID</code>), not a hardcoded buff list.</small></p>`
          : ''
      }
    </section>`;
}

/**
 * Section 4b — Gear check: enchants and gems, you vs the benchmark.
 *
 * Only flags a slot where THEY enchanted/gemmed it and you didn't — which both
 * derives the enchantable set from live data (no hardcoded slot list) and answers
 * the only question that matters: "am I missing something a top player has?".
 * Enchants and embellishment procs no longer clutter the biggest-gaps section;
 * this is where a real gear hole surfaces instead.
 */
export function renderGear(g) {
  if (!g?.rows?.length) return '';
  const yes = '<span class="p-green">✓</span>';
  const no = '<span class="p-orange">✗</span>';

  const rows = g.rows
    .map((r) => {
      const flagged = r.missingEnchant || r.missingGem;
      return `<tr class="${flagged ? 'rot-big' : ''}">
        <td>${esc(r.label)}</td>
        <td>${r.myEnchant ? yes : r.theirEnchant ? no : '<span class="muted">—</span>'}</td>
        <td>${r.myGems || '<span class="muted">·</span>'}${
          r.missingGem ? ` <small class="p-orange">(they: ${r.theirGems})</small>` : ''
        }</td>
      </tr>`;
    })
    .join('');

  return `
    <section class="card-section">
      <h3>Gear check <small>enchants &amp; gems vs ${esc(g.otherLabel)}</small></h3>
      <table class="rot-table gear-check">
        <thead><tr><th>Slot</th><th>Enchant</th><th>Gems</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${g.notes.map((n) => `<p class="section-note ${g.clean ? '' : 'warn'}">${esc(n)}</p>`).join('')}
      <p class="table-note"><small>A slot is only flagged when <b>${esc(g.otherLabel)}</b> enchanted or gemmed it and you didn't —
        so this tracks whatever is enchantable this patch, with no fixed slot list. Embellishments aren't audited
        (no reliable signal in the log).</small></p>
    </section>`;
}

/**
 * Section 7 — resource management.
 *
 * Generic across classes: the server reads the spec's primary resource off the
 * log (analysis/resources.js) rather than being told which one to expect, so this
 * shows Runic Power for a DK and Fury for a Havoc DH with no per-class branch.
 * The headline is the WASTE PERCENTAGE, which is scale-invariant — WCL reports
 * some resources at 10x, and a percentage cancels that out, so no unverifiable
 * per-resource divisor is ever applied to the numbers.
 */
export function renderResources(res) {
  if (!res) return '';
  const cell = (v, suffix = '') => (v == null ? '<span class="muted">·</span>' : `${v}${suffix}`);
  const them = res.them;

  // A power type we don't recognise by NAME is still fully usable — every number
  // came from the log. Say so rather than silently labelling it wrong.
  const unknownNote = res.known
    ? ''
    : `<p class="table-note"><small>This power type isn't one we recognise by name, so it's shown by its id. The numbers are the log's own.</small></p>`;

  const others = res.others?.length
    ? `<p class="table-note"><small>Also generated: ${res.others
        .map((o) => `${esc(o.name)}${o.wastePct != null ? ` (${o.wastePct}% wasted)` : ''}`)
        .join(', ')} — secondary pools, not your main resource.</small></p>`
    : '';

  return `
    <section class="card-section">
      <h3>${esc(res.name)} management</h3>
      <table class="rot-table">
        <thead><tr><th>Metric</th><th>You</th><th>Them</th></tr></thead>
        <tbody>
          <tr class="rot-big">
            <td><b>Wasted to overcapping</b></td>
            <td class="num">${cell(res.mine.wastePct, '%')}</td>
            <td class="num">${cell(them?.wastePct, '%')}</td>
          </tr>
          <tr><td>Generated</td><td class="num">${cell(res.mine.gain)}</td><td class="num">${cell(them?.gain)}</td></tr>
          <tr><td>Wasted</td><td class="num">${cell(res.mine.waste)}</td><td class="num">${cell(them?.waste)}</td></tr>
        </tbody>
      </table>
      ${res.note ? `<p class="section-note">${esc(res.note)}</p>` : ''}
      ${unknownNote}
      ${others}
      <p class="table-note"><small>Waste % = of everything you could have generated, how much the cap ate. Raw amounts are in the log's own units.</small></p>
    </section>`;
}
