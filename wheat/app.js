/* Wheat seasonal dashboard. Exact-contract data only. */
(function () {
  'use strict';
  const BUSHELS_PER_TONNE = 1000 / (60 * 0.45359237);
  const DAY = 86400000;
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  function quantile(a, q) {
    if (!a.length) return null;
    const b = [...a].sort((x, y) => x - y), k = (b.length - 1) * q;
    return b[Math.floor(k)] + (b[Math.ceil(k)] - b[Math.floor(k)]) * (k % 1);
  }
  function value(p, unit) { return unit === 'eur' ? p.eurt : p.usdt; }
  function transform(series, unit, mode) {
    const points = series.points.filter(p => finite(value(p, unit))).map(p => ({...p, y: value(p, unit)}));
    if (mode === 'level') return points;
    const baseline = points.find(p => p.seasonDay >= 0 && p.seasonDay <= 13);
    return baseline ? points.map(p => ({...p, y: p.y - baseline.y})) : [];
  }
  function weekly(points) {
    const buckets = new Map();
    for (const p of points) {
      const w = Math.floor(p.seasonDay / 7);
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(p.y);
    }
    return new Map([...buckets].map(([w, a]) => [w, mean(a)]));
  }
  function historyYears(data, period) {
    const years = data.comparableYears;
    if (period === 'recent10') return years.slice(-10);
    return period === 'post2010' ? years.filter(y => y >= 2010) : years;
  }
  function band(series, years, unit, mode) {
    const byWeek = new Map();
    for (const s of series.filter(s => years.includes(s.year))) {
      for (const [w, y] of weekly(transform(s, unit, mode))) {
        if (!byWeek.has(w)) byWeek.set(w, []);
        byWeek.get(w).push(y);
      }
    }
    return [...byWeek].sort((a, b) => a[0] - b[0]).map(([w, a]) => ({
      x: w * 7 + 3, n: a.length, lo: quantile(a, .25), median: quantile(a, .5), hi: quantile(a, .75)
    }));
  }
  function csvRows(text) {
    const rows = []; let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
      else if (c === ',' && !quoted) { row.push(field); field = ''; }
      else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); if (row.some(v => v.trim())) rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (quoted) throw new Error('Unclosed quoted field in CSV.');
    row.push(field); if (row.some(v => v.trim())) rows.push(row);
    return rows;
  }
  function parseImport(text, expectedMarket) {
    const rows = csvRows(text.replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('This file has no price rows. Use the template columns and actual March settlements.');
    const headers = rows.shift().map(v => v.trim().toLowerCase());
    const di = headers.indexOf('date');
    const yi = headers.includes('delivery_year') ? headers.indexOf('delivery_year') : headers.indexOf('year');
    const pi = headers.includes('settle_cents_bu') ? headers.indexOf('settle_cents_bu') : headers.indexOf('settle');
    if ([di, yi, pi].includes(-1)) throw new Error('Required columns: date, delivery_year, settle_cents_bu.');
    const seen = new Set();
    return rows.map((r, i) => {
      if (r.length !== headers.length) throw new Error(`CSV row ${i + 2}: unexpected number of columns.`);
      const date = r[di].trim(), year = Number(r[yi]), settle = Number(r[pi]);
      const mi = headers.indexOf('month'), ci = headers.indexOf('contract'), marketIndex = headers.indexOf('market');
      const root = expectedMarket === 'cbot' ? 'ZW' : 'KE';
      if (mi >= 0 && !['3','3.0','03','mar','march','h'].includes(r[mi].trim().toLowerCase()))
        throw new Error(`CSV row ${i + 2}: only March contracts are accepted.`);
      if (expectedMarket && ci >= 0 && r[ci].trim() !== `${root}-${year}H`)
        throw new Error(`CSV row ${i + 2}: expected ${root}-${year}H for this market.`);
      if (expectedMarket && marketIndex >= 0 && ![expectedMarket.toUpperCase(), root].includes(r[marketIndex].trim().toUpperCase()))
        throw new Error(`CSV row ${i + 2}: market does not match this spread panel. Use a separate file for each market.`);
      const stamp = Date.parse(date + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date)
        throw new Error(`CSV row ${i + 2}: use a valid YYYY-MM-DD date.`);
      if (!Number.isInteger(year) || year < 1900 || year > 2200 || !finite(settle) || settle <= 0)
        throw new Error(`CSV row ${i + 2}: invalid delivery year or cents/bushel settlement.`);
      const key = `${year}:${date}`;
      if (seen.has(key)) throw new Error(`Duplicate delivery year/date at CSV row ${i + 2}.`);
      seen.add(key);
      return {date, year, settle};
    });
  }
  function makeSpread(matif, rows) {
    const map = new Map(rows.map(r => [`${r.year}:${r.date}`, r]));
    return matif.map(s => ({year: s.year, contract: s.contract, points: s.points.flatMap(p => {
      const r = map.get(`${s.year}:${p.date}`);
      if (!r || !finite(p.fx) || !finite(p.usdt) || p.fx <= 0) return [];
      const usd = r.settle / 100 * BUSHELS_PER_TONNE;
      return [{...p, usdt: p.usdt - usd, eurt: p.eurt - usd / p.fx, usSettleCentsBu: r.settle}];
    })})).filter(s => s.points.length);
  }
  const math = {BUSHELS_PER_TONNE, quantile, transform, weekly, historyYears, band, parseImport, makeSpread};
  if (typeof module !== 'undefined') module.exports = math;
  if (typeof document === 'undefined') return;

  let data, selected = new Set(), localImports = {};
  const $ = id => document.getElementById(id);
  const units = () => $('unit').value;
  const mode = () => $('mode').value;
  const unitLabel = () => units() === 'eur' ? '€/t' : '$/t';
  const fmt = (n, signed = false) => finite(n) ? (signed && n > 0 ? '+' : '') + n.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—';
  const dateLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
  const colours = ['#587786', '#8c80ac', '#589d97', '#b68b62', '#5f8caf', '#aa7d95', '#88a273', '#a2a9ba'];
  const yearColour = y => y === data.currentYear ? '#ff806b' : colours[(y - 2000) % colours.length];
  const settings = () => ({years: historyYears(data, $('history').value), unit: units(), mode: mode()});
  function seriesFor(key) { return data.series[key === 'matif' ? 'matif' : key === 'cbot' ? 'spreadCbot' : 'spreadKc'] || []; }
  function yearPicker() {
    const root = $('year-picker'); root.replaceChildren();
    for (const s of data.series.matif) {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(s.year);
      input.setAttribute('aria-label', `Show March ${s.year}`);
      input.addEventListener('change', () => { input.checked ? selected.add(s.year) : selected.delete(s.year); render(); });
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = yearColour(s.year);
      label.append(input, sw, document.createTextNode(String(s.year) + (s.year === data.currentYear ? ' current' : s.year === 2002 ? ' partial' : '')));
      root.append(label);
    }
  }
  function chart(key) {
    const root = $('chart-' + key), series = seriesFor(key), opts = settings();
    const title = key === 'matif' ? 'MATIF March' : 'MATIF − ' + (key === 'cbot' ? 'Chicago SRW' : 'KC HRW');
    if (!series.length) {
      if (root.data) Plotly.purge(root);
      root.classList.add('empty-chart');
      root.innerHTML = '<div><span class="empty-kicker">March / March · same delivery year</span><h3>Awaiting ' + (key === 'cbot' ? 'Chicago' : 'Kansas City') + ' contract history</h3><p>MATIF settlements and daily EUR/USD are ready.<br>Actual US March contracts are needed to calculate this spread.</p></div>';
      $('status-' + key).textContent = 'US history pending';
      $('caption-' + key).textContent = 'No spread levels, seasonal bands or percentiles calculated yet.';
      return;
    }
    if (!root.data) root.replaceChildren();
    root.classList.remove('empty-chart');
    const stats = band(series, opts.years, opts.unit, opts.mode);
    const traces = [];
    if (stats.length) {
      const xs = stats.map(p => p.x), valid = p => p.n >= 3;
      traces.push({x: xs, y: stats.map(p => valid(p) ? p.lo : null), type: 'scatter', mode: 'lines', line: {width: 0}, showlegend: false, hoverinfo: 'skip'});
      traces.push({x: xs, y: stats.map(p => valid(p) ? p.hi : null), type: 'scatter', mode: 'lines', line: {width: 0}, fill: 'tonexty', fillcolor: 'rgba(99,165,183,.13)', name: '25–75% range', hoverinfo: 'skip'});
      traces.push({x: xs, y: stats.map(p => valid(p) ? p.median : null), customdata: stats.map(p => p.n), type: 'scatter', mode: 'lines', line: {color: '#8fcbd3', width: 2.5, dash: 'dot'}, name: 'Historical median', hovertemplate: 'Median %{y:.2f} ' + unitLabel() + '<br>%{customdata} seasons<extra></extra>'});
    }
    for (const s of series.filter(s => selected.has(s.year))) {
      const pts = transform(s, opts.unit, opts.mode);
      traces.push({x: pts.map(p => p.seasonDay), y: pts.map(p => p.y), customdata: pts.map(p => p.date), type: 'scatter', mode: 'lines', name: String(s.year) + (s.year === data.currentYear ? ' current' : ''), line: {color: yearColour(s.year), width: s.year === data.currentYear ? 3 : 1.3}, opacity: s.year === data.currentYear ? 1 : .65, connectgaps: false, hovertemplate: '%{customdata}<br>%{y:.2f} ' + unitLabel() + '<extra>March ' + s.year + '</extra>'});
    }
    const layout = {
      paper_bgcolor: '#141821', plot_bgcolor: '#141821', font: {family: 'system-ui, sans-serif', color: '#b7c0cc', size: 13},
      margin: {l: 66, r: 18, t: 16, b: 74}, hovermode: 'closest', dragmode: 'zoom',
      xaxis: {range: [0, 334], tickvals: [0,30,61,91,122,153,183,214,244,275,306], ticktext: ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb'], gridcolor: '#252c37', zeroline: false, fixedrange: false},
      yaxis: {title: {text: (opts.mode === 'change' ? 'Change since April · ' : '') + unitLabel(), standoff: 12}, gridcolor: '#252c37', zerolinecolor: '#596372', fixedrange: false},
      legend: {orientation: 'h', x: 0, y: -.15, font: {size: 12}, itemclick: false, itemdoubleclick: false},
      uirevision: key + opts.unit + opts.mode + $('history').value,
      annotations: !traces.length ? [{text: 'Select a delivery year to display', showarrow: false, xref: 'paper', yref: 'paper', x: .5, y: .5}] : []
    };
    Plotly.react(root, traces, layout, {responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'], toImageButtonOptions: {format: 'png', filename: 'wheat-' + key + '-seasonal', scale: 2}});
    const current = series.find(s => s.year === data.currentYear), latest = current?.points.at(-1);
    const coverage = stats.filter(p => p.n >= 3).map(p => p.n);
    $('caption-' + key).textContent = `${opts.years[0]}–${opts.years.at(-1)} reference · weekly means within each year, then median and 25–75% range · ${coverage.length ? Math.min(...coverage) + '–' + Math.max(...coverage) : 0} seasons per plotted week.` + (latest ? ` Current through ${dateLabel(latest.date)}.` : ' Current March contract unavailable.') + (opts.mode === 'change' ? ' Rebased to first observation in 1–14 April; seasons without that anchor are omitted.' : '');
    if (key !== 'matif') {
      $('status-' + key).textContent = localImports[key] ? 'Imported · this browser session' : 'Matched March contracts';
      $('status-' + key).className = 'availability-badge available';
    }
    if (key === 'matif') $('title-matif').textContent = title + (opts.mode === 'change' ? ' · change since April' : ' · outright settlement');
  }
  function summary() {
    const tbody = $('summary-body'); tbody.replaceChildren();
    for (const [key, label] of [['matif','MATIF March'],['cbot','MATIF − Chicago March'],['kc','MATIF − KC March']]) {
      const tr = document.createElement('tr'), series = seriesFor(key), current = series.find(s => s.year === data.currentYear);
      const points = current?.points.filter(p => finite(value(p, units()))) || [], last = points.at(-1);
      const cells = [label];
      if (last) {
        const latest = value(last, units()), week = Math.floor(last.seasonDay / 7), years = settings().years;
        const sample = series.filter(s => years.includes(s.year)).map(s => weekly(transform(s, units(), 'level')).get(week)).filter(finite);
        const pct = sample.length >= 3 ? 100 * (sample.filter(v => v < latest).length + .5 * sample.filter(v => v === latest).length) / sample.length : null;
        const target = Date.parse(last.date) - 30 * DAY;
        const prior = [...points].reverse().find(p => Date.parse(p.date) <= target && target - Date.parse(p.date) <= 5 * DAY);
        cells.push(fmt(latest) + ' ' + unitLabel(), pct === null ? '— (n=' + sample.length + ')' : Math.round(pct) + '% · n=' + sample.length, prior ? fmt(latest - value(prior, units()), true) : '—', 'Mar ' + data.currentYear + ' · ' + dateLabel(last.date));
      } else cells.push('Pending history', '—', '—', 'Mar ' + data.currentYear);
      for (const text of cells) { const td = document.createElement('td'); td.textContent = text; tr.append(td); }
      tbody.append(tr);
    }
  }
  function dataStatus() {
    const root = $('data-status'); root.replaceChildren();
    const stamp = v => v ? new Date(v).toLocaleString('en-GB', {timeZone:'Europe/Zurich',dateStyle:'medium',timeStyle:'short'}) + ' Zurich' : 'not yet run';
    const entries = [
      ['MATIF March', `${data.series.matif.length} delivery years · ${data.series.matif[0].year}–${data.currentYear} · current through ${dateLabel(data.asOf)}`],
      ['EUR/USD', 'ECB daily reference · same date or latest prior observation, maximum 3 calendar days'],
      ['Chicago / KC', Object.keys(localImports).length ? 'Imported files are used only in this browser session. Reload restores the published snapshot.' : [seriesFor('cbot').length ? 'Chicago matched' : 'Chicago pending', seriesFor('kc').length ? 'KC matched' : 'KC pending'].join(' · ')],
      ['Source', 'Edge/Euronext MATIF settlements · Norgate individual US contracts · ECB EUR/USD'],
      ['Published snapshot', `Built ${stamp(data.generatedAt)} · price observations through ${dateLabel(data.asOf)}. This page loads the committed snapshot; it does not collect prices in your browser.`]
    ];
    for (const [key, text] of entries) { const row = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = key; const span = document.createElement('span'); span.textContent = text; row.append(strong, span); root.append(row); }
  }
  function render() {
    $('year-count').textContent = `${selected.size} years selected`;
    if (Object.keys(localImports).length) {
      const pending = ['cbot','kc'].filter(k => !seriesFor(k).length).map(k => k === 'cbot' ? 'Chicago' : 'KC');
      const imported = Object.keys(localImports).map(k => k === 'cbot' ? 'Chicago' : 'KC').join(' and ');
      document.querySelector('.data-notice div').textContent = `${imported}: local replacement active for this browser session. Reload restores the published snapshot.` + (pending.length ? ` ${pending.join(' and ')} history is still pending.` : '');
    } else {
      const pending = ['cbot','kc'].filter(k => !seriesFor(k).length).map(k => k === 'cbot' ? 'Chicago' : 'KC');
      document.querySelector('.data-notice div').textContent = pending.length ? `${pending.join(' and ')} March spread histories pending. MATIF settlements are available through ${dateLabel(data.asOf)}. Comparisons require matching US March contracts.` : `March spreads available. MATIF source through ${dateLabel(data.asOf)}; each spread uses its latest same-date match.`;
    }
    if (data.collection?.unverifiedGapDates?.length) document.querySelector('.data-notice div').textContent += ` ${data.collection.unverifiedGapDates.length} earlier weekday dates need a history/holiday check after a collection gap.`;
    summary(); ['matif','cbot','kc'].forEach(chart); dataStatus();
  }
  async function importData(key, file) {
    const message = $('import-message-' + key);
    if (!file) return;
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('Please use a CSV under 15 MB.');
      const rows = parseImport(await file.text(), key), spread = makeSpread(data.series.matif, rows);
      const matched = spread.reduce((n, s) => n + s.points.length, 0);
      if (!matched) throw new Error('No same-date, same-delivery-year overlap with the MATIF snapshot. Check dates and year.');
      data.series[key === 'cbot' ? 'spreadCbot' : 'spreadKc'] = spread;
      localImports[key] = file.name;
      message.textContent = `${matched.toLocaleString()} matched days across ${spread.length} seasons. ${rows.length - matched} rows outside the available MATIF/FX window. File used locally until reload.`;
      message.className = 'import-message success'; render();
    } catch (e) { message.textContent = e.message; message.className = 'import-message error'; }
  }
  async function boot() {
    try {
      const response = await fetch('wheat/data.json', {cache: 'no-store'}); if (!response.ok) throw new Error('Price snapshot could not be loaded.');
      data = await response.json();
      const reference = data.comparableYears.slice(-10);
      $('history').options[0].textContent = `Last 10 seasons · ${reference[0]}–${reference.at(-1)}`;
      $('recent-overlay-range').textContent = `${data.currentYear-5}–${data.currentYear}`;
      $('current-delivery-year').textContent = data.currentYear;
      if (typeof Plotly === 'undefined') throw new Error('Chart library could not be loaded. Reload the page.');
      selected = new Set(data.series.matif.filter(s => s.year >= data.currentYear - 5).map(s => s.year));
      yearPicker();
      for (const id of ['unit','mode','history']) $(id).addEventListener('change', render);
      for (const [id, predicate] of [['all-years',() => true],['recent-years',s => s.year >= data.currentYear - 5],['none-years',() => false]]) $(id).addEventListener('click', () => { selected = new Set(data.series.matif.filter(predicate).map(s => s.year)); yearPicker(); render(); });
      for (const key of ['cbot','kc']) $('import-' + key).addEventListener('change', e => importData(key, e.target.files[0]));
      render();
    } catch (e) {
      $('chart-matif').textContent = e.message;
      $('chart-matif').classList.add('empty-chart');
    }
  }
  boot();
})();
