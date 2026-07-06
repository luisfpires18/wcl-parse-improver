const $ = (sel) => document.querySelector(sel);

$('#char-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadOverview();
});

async function loadOverview() {
  const params = new URLSearchParams({
    name: $('#f-name').value.trim(),
    server: $('#f-server').value.trim(),
    region: $('#f-region').value.trim(),
    zone: $('#f-zone').value.trim(),
  });
  $('#status').textContent = 'Loading…';
  $('#overview').innerHTML = '';
  try {
    const res = await fetch(`/api/overview?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderOverview(data);
    $('#status').textContent = '';
  } catch (err) {
    $('#status').textContent = `Error: ${err.message}`;
  }
}

function renderOverview({ character, overall, dungeons }) {
  const fmtPct = (v) => (typeof v === 'number' ? v.toFixed(1) : '—');
  const fmtTime = (ms) => {
    if (!ms) return '—';
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const rows = dungeons
    .map(
      (d) => `<tr>
        <td>${d.name}</td>
        <td class="num">${d.keyLevel ?? '—'}</td>
        <td class="num">${fmtTime(d.durationMs)}</td>
        <td class="num">${d.runs ?? '—'}</td>
        <td class="num">${typeof d.points === 'number' ? Math.floor(d.points) : '—'}</td>
        <td class="num pct">${fmtPct(d.bestPercent)}</td>
        <td class="num pct">${fmtPct(d.medianPercent)}</td>
        <td class="num">${typeof d.bestDps === 'number' ? (d.bestDps / 1000).toFixed(1) + 'k' : '—'}</td>
      </tr>`
    )
    .join('');

  $('#overview').innerHTML = `
    <h2>${character}</h2>
    <p>Best avg: <b>${fmtPct(overall.bestPerformanceAverage)}</b> ·
       Median avg: <b>${fmtPct(overall.medianPerformanceAverage)}</b>
       <small>(parse percentiles at the shown key level — matches the WCL site)</small></p>
    <table>
      <thead><tr>
        <th>Dungeon</th><th>Level</th><th>Time</th><th>Runs</th><th>Points</th>
        <th>Best %</th><th>Median %</th><th>Best DPS</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

loadOverview();
