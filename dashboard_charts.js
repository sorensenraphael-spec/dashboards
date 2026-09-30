// dashboard_charts.js — render data-driven charts from window.__MD__.
// Written 2026-09-29 as part of the publishing retirement / data-only pass.
//
// Wire-up: put an empty <div data-chart="KEY"> in the HTML. On DOMContentLoaded
// this script populates it with an inline <svg> chart and a "data through <date>"
// stamp. Null data → "awaiting data" italic placeholder (no "pending" states).
//
// Supported KEY shapes:
//   "<MKT>.settle_1y"   - last ~260 daily backadj closes for MKT (ZC, KC, CC, ...)
//   "<MKT>.cot_3y"      - last ~156 weekly mm_net for MKT
//   "rainfall.cerrado"  - last 60 months of Cerrado precip anomaly (bars)
//   "rainfall.wca_cocoa"- same for West Africa cocoa belt
//   "oni.history"       - ONI value single-point (fallback: dashes)
//   "gsr.settle_1y"     - synthesized gold/silver ratio series from GC/SI settle_1y
//
// Alert triggers: put a data-alert="<expression>" on an element. Supported
// expression forms:
//   "<MKT>.cot.mm_net > 50000"
//   "<MKT>.cot.mm_net < 0"
//   "<MKT>.cot.percentile > 90"
//   "ONI > 1"
// Element gets class "fired" or "not-fired" and title "value=X (as of Y)".

(function () {
  const D = window.__MD__ || {};
  const M = D.markets || {};

  const NUM = (v, d) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d ?? 2 });
  const AWAIT = (el, note) => {
    el.textContent = note || 'awaiting data';
    el.style.color = '#5f6f6a';
    el.style.fontStyle = 'italic';
    el.style.fontSize = '13px';
    el.title = 'no series in window.__MD__';
  };

  function resolveSeries(key) {
    const [head, tail] = key.split('.', 2);
    if (head === 'rainfall') {
      const r = (D.rainfall || {})[tail];
      if (!r || !r.length) return null;
      return { rows: r, format: 'rainfall' };
    }
    if (head === 'oni') {
      const o = D.oni;
      if (!o || o.value == null) return null;
      return { rows: [[o.as_of, o.value]], format: 'point' };
    }
    if (head === 'gsr' && tail === 'settle_1y') {
      const gc = ((M.GC || {}).series || {}).settle_1y;
      const si = ((M.SI || {}).series || {}).settle_1y;
      if (!gc || !si) return null;
      const siMap = Object.fromEntries(si.map(r => [r[0], r[1]]));
      const rows = [];
      for (const [d, gv] of gc) {
        const sv = siMap[d];
        if (sv && sv > 0) rows.push([d, +(gv / sv).toFixed(2)]);
      }
      return rows.length ? { rows, format: 'line' } : null;
    }
    const m = M[head];
    if (!m || !m.series) return null;
    const s = m.series[tail];
    if (!s || !s.length) return null;
    if (tail === 'cot_3y') return { rows: s, format: 'line', zeroline: true };
    return { rows: s, format: 'line' };
  }

  function renderLine(el, rows, { zeroline = false } = {}) {
    if (!rows.length) return AWAIT(el);
    const W = 640, H = 180, PADL = 44, PADR = 8, PADT = 12, PADB = 22;
    const xs = rows.map((_, i) => i);
    const ys = rows.map(r => r[1]).filter(v => v != null && isFinite(v));
    if (!ys.length) return AWAIT(el);
    const ymin = Math.min(...ys, zeroline ? 0 : Infinity);
    const ymax = Math.max(...ys, zeroline ? 0 : -Infinity);
    const yr = (ymax - ymin) || 1;
    const sx = i => PADL + (W - PADL - PADR) * (i / Math.max(1, xs.length - 1));
    const sy = v => (H - PADB) - (H - PADT - PADB) * ((v - ymin) / yr);
    const d = rows.map((r, i) => (i === 0 ? 'M' : 'L') + sx(i).toFixed(1) + ',' + sy(r[1]).toFixed(1)).join(' ');
    const zy = zeroline ? sy(0).toFixed(1) : null;
    const firstDate = rows[0][0], lastDate = rows[rows.length - 1][0];
    const lastVal = rows[rows.length - 1][1];
    const ticks = 4;
    const yticks = Array.from({ length: ticks + 1 }, (_, i) => ymin + (yr * i / ticks));
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;font-family:ui-sans-serif,system-ui,sans-serif">`;
    // y-axis grid
    for (const yv of yticks) {
      const y = sy(yv).toFixed(1);
      svg += `<line x1="${PADL}" x2="${W - PADR}" y1="${y}" y2="${y}" stroke="#2a2f38" stroke-width="0.5"/>`;
      svg += `<text x="${PADL - 4}" y="${y}" fill="#8a8a80" font-size="10" text-anchor="end" dominant-baseline="middle">${NUM(yv, Math.abs(yv) >= 100 ? 0 : 2)}</text>`;
    }
    if (zy !== null) svg += `<line x1="${PADL}" x2="${W - PADR}" y1="${zy}" y2="${zy}" stroke="#4a4f58" stroke-width="1"/>`;
    svg += `<path d="${d}" fill="none" stroke="#e39a3b" stroke-width="1.4"/>`;
    // last-point dot
    svg += `<circle cx="${sx(rows.length - 1).toFixed(1)}" cy="${sy(lastVal).toFixed(1)}" r="2.5" fill="#e39a3b"/>`;
    svg += `<text x="${PADL}" y="${H - 6}" fill="#8a8a80" font-size="10">${firstDate}</text>`;
    svg += `<text x="${W - PADR}" y="${H - 6}" fill="#8a8a80" font-size="10" text-anchor="end">${lastDate}</text>`;
    svg += '</svg>';
    el.innerHTML = svg + `<div style="font-size:11px;color:#8a8a80;margin-top:4px">data through ${lastDate} · ${rows.length} obs · last ${NUM(lastVal, 2)}</div>`;
  }

  function renderRainfall(el, rows) {
    if (!rows.length) return AWAIT(el);
    const W = 640, H = 180, PADL = 44, PADR = 8, PADT = 12, PADB = 22;
    const anoms = rows.map(r => r[2]).filter(v => v != null && isFinite(v));
    if (!anoms.length) return renderLine(el, rows.map(r => [r[0], r[1]]));
    const amax = Math.max(...anoms.map(Math.abs));
    const sx = i => PADL + (W - PADL - PADR) * (i / Math.max(1, rows.length - 1));
    const bw = (W - PADL - PADR) / rows.length * 0.8;
    const zy = PADT + (H - PADT - PADB) / 2;
    const sy = v => zy - (v / (amax || 1)) * (H - PADT - PADB) / 2;
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;font-family:ui-sans-serif,system-ui,sans-serif">`;
    svg += `<line x1="${PADL}" x2="${W - PADR}" y1="${zy}" y2="${zy}" stroke="#4a4f58" stroke-width="1"/>`;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i][2];
      if (a == null || !isFinite(a)) continue;
      const y = sy(a);
      const h = Math.abs(y - zy);
      const yTop = a >= 0 ? y : zy;
      const color = a >= 0 ? '#4a90c2' : '#c26a4a';
      svg += `<rect x="${(sx(i) - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>`;
    }
    svg += `<text x="${PADL - 4}" y="${(zy - (H - PADT - PADB) / 2).toFixed(1)}" fill="#8a8a80" font-size="10" text-anchor="end">+${NUM(amax, 0)}</text>`;
    svg += `<text x="${PADL - 4}" y="${(zy + (H - PADT - PADB) / 2).toFixed(1)}" fill="#8a8a80" font-size="10" text-anchor="end" dominant-baseline="hanging">-${NUM(amax, 0)}</text>`;
    svg += `<text x="${PADL}" y="${H - 6}" fill="#8a8a80" font-size="10">${rows[0][0]}</text>`;
    svg += `<text x="${W - PADR}" y="${H - 6}" fill="#8a8a80" font-size="10" text-anchor="end">${rows[rows.length - 1][0]}</text>`;
    svg += '</svg>';
    el.innerHTML = svg + `<div style="font-size:11px;color:#8a8a80;margin-top:4px">rainfall anomaly · data through ${rows[rows.length - 1][0]} · ${rows.length} months</div>`;
  }

  function renderChart(el) {
    const key = el.dataset.chart;
    if (!key) return;
    const s = resolveSeries(key);
    if (!s) { AWAIT(el, 'awaiting data — series ' + key + ' not in window.__MD__'); return; }
    if (s.format === 'rainfall') return renderRainfall(el, s.rows);
    return renderLine(el, s.rows, { zeroline: s.zeroline });
  }

  function evalAlert(expr) {
    // "MKT.cot.mm_net > 50000", "ONI > 1", etc.
    const m = expr.match(/^\s*([\w.]+)\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return { ok: false, reason: 'unparseable' };
    const [, path, op, rhsStr] = m;
    const rhs = Number(rhsStr);
    const parts = path.split('.');
    let cur = D;
    if (parts[0] === 'ONI') { cur = D.oni; parts.shift(); }
    else if (M[parts[0]]) { cur = M[parts[0]]; parts.shift(); }
    for (const k of parts) {
      if (cur == null) return { ok: false, reason: 'null-path' };
      cur = cur[k];
    }
    if (cur == null) cur = (D.oni || {}).value;
    if (typeof cur !== 'number' || !isFinite(cur)) return { ok: false, reason: 'no-number' };
    let fired;
    switch (op) {
      case '>':  fired = cur >  rhs; break;
      case '<':  fired = cur <  rhs; break;
      case '>=': fired = cur >= rhs; break;
      case '<=': fired = cur <= rhs; break;
      case '==': fired = cur === rhs; break;
    }
    return { ok: true, fired, value: cur };
  }

  function renderAlerts() {
    document.querySelectorAll('[data-alert]').forEach(el => {
      const expr = el.dataset.alert;
      const r = evalAlert(expr);
      if (!r.ok) {
        el.dataset.state = 'unparseable';
        el.title = 'alert not evaluable: ' + r.reason;
        return;
      }
      el.dataset.state = r.fired ? 'fired' : 'not-fired';
      el.title = 'value=' + r.value + ' vs ' + expr + (r.fired ? ' — FIRED' : ' — not fired');
      const dot = el.querySelector('.alert-dot');
      if (dot) {
        dot.textContent = r.fired ? '🔴' : '⚪';
        dot.title = el.title;
      }
    });
  }

  function go() {
    document.querySelectorAll('[data-chart]').forEach(renderChart);
    renderAlerts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else {
    go();
  }
})();
