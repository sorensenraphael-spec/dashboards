// dashboard_populate.js — shared populate logic for all 7 dashboards.
// Depends on dashboard_data.js having set window.__MD__.
//
// Each element carrying data-field="MKT.FIELD" is filled from that market's
// live value, formatted per-field, with the per-field as_of set on `title`
// so hover reveals it. A special data-field="_generated_at" carries the
// page-level "as of" stamp.
(function () {
  const D = window.__MD__ || {};
  const M = D.markets || {};

  function num(v, opts) {
    if (v == null) return null;
    return Number(v).toLocaleString(undefined, opts || {});
  }

  function fmt(field, val) {
    if (val == null || (typeof val === 'number' && !isFinite(val))) return null;
    if (field === 'price') return '$' + num(val, { maximumFractionDigits: val >= 100 ? 0 : 2 });
    if (field === 'price_cents') return num(val, { maximumFractionDigits: 2 }) + ' ¢/lb';
    if (field === 'mm_net') {
      const k = val / 1000;
      const s = k >= 0 ? '+' : '';
      return s + k.toFixed(1) + 'k';
    }
    if (field === 'mm_net_prefixed') {
      const k = val / 1000;
      const s = k >= 0 ? '+' : '−';
      return 'MM ' + s + Math.abs(k).toFixed(1) + 'k';
    }
    if (field === 'percentile') return Number(val).toFixed(1) + '%';
    if (field === 'ratio') return Number(val).toFixed(1);
    if (field === 'ratio_prefixed') return 'Ratio ≈ ' + Number(val).toFixed(1);
    if (field === 'oni') return (val >= 0 ? '+' : '') + Number(val).toFixed(2);
    return String(val);
  }

  function resolve(key) {
    // key looks like "CC.price", "SI.mm_net_prefixed", "GSR", "GSR.ratio", "ONI"
    const parts = key.split('.');
    const head = parts[0];
    const field = parts[1] || 'value';
    if (head === 'ONI') {
      return { val: D.oni && D.oni.value, asof: D.oni && D.oni.as_of, field };
    }
    if (head === 'GSR' || head === 'gsr') {
      const g = D.gold_silver_ratio;
      return { val: g && g.value, asof: g && g.as_of, field };
    }
    const m = M[head] || {};
    if (field === 'price' || field === 'price_cents') {
      return { val: m.price && m.price.value, asof: m.price && m.price.as_of, field };
    }
    if (field === 'mm_net' || field === 'mm_net_prefixed') {
      return { val: m.cot && m.cot.mm_net, asof: m.cot && m.cot.as_of, field };
    }
    if (field === 'percentile') {
      return { val: m.cot && m.cot.percentile, asof: m.cot && m.cot.as_of, field };
    }
    return { val: null, asof: null, field };
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function badgeDate(v) {
    // Accept "settle YYYY-MM-DD", "YYYY-MM-DD…", or ISO timestamps. Return
    // "D Mon YYYY" (e.g. "22 Sep 2026") to match the prose-authored badges.
    const m = String(v || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const mo = MONTHS[parseInt(m[2], 10) - 1];
    return `${parseInt(m[3], 10)} ${mo} ${m[1]}`;
  }

  document.querySelectorAll('[data-field]').forEach((el) => {
    const key = el.dataset.field;
    if (key === '_generated_at') {
      if (D.generated_at) {
        const d = new Date(D.generated_at);
        el.textContent = isNaN(d)
          ? D.generated_at
          : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
      return;
    }
    if (key === '_settle_date') {
      // For "today"-style badges inside locked sections (e.g. the liquidity
      // gauge). Reads the badge date from window.__MD__.generated_at so the
      // date advances even when the content pipeline can't touch the locked
      // prose. Falls through to the placeholder text on parse failure.
      const s = badgeDate(D.generated_at);
      if (s) el.textContent = s;
      return;
    }
    const { val, asof, field } = resolve(key);
    const formatted = fmt(field, val);
    if (formatted != null) {
      el.textContent = formatted;
      if (asof) el.title = 'as of ' + asof;
    }
  });
})();
