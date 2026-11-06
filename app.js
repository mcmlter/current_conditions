/* =============================================================
   MCM Current Conditions — app.js
   Rotates through sites with recent data, one at a time.
   No dependencies. Add ?demo to the URL for synthetic data.
   ============================================================= */

'use strict';

const DEMO = new URLSearchParams(location.search).has('demo');
const HOUR = 3600000;
const GAP_MS = 2 * HOUR;             // break sparkline across gaps longer than this
const TYPE_LABEL = { met: 'Met station', lake: 'Lake buoy' };

const store = new Map();             // code → { rows: [{time, ...fields}], latest: Date|null, error, checkedAt }
let currentCode = null;
let rotateTimer = null;
let firstRender = true;
let generation = 0;                  // bumps whenever a newer rotation supersedes an in-flight one

// ─── Small helpers ────────────────────────────────────────────
const $ = sel => document.querySelector(sel);

function num(v) {
  if (v === '' || v == null) return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

// Parse logger timestamps by hand into an absolute instant. Never hand a bare
// "YYYY-MM-DD HH:MM:SS" to Date(): browsers read that as the *viewer's* local
// time. Here the offset always comes from the string (proxy writes "+13:00")
// or from CONFIG.loggerUtcOffset, so results are the same in every time zone.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

function offsetMinutes(str) {
  if (!str || /^z$/i.test(str)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(str);
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

function parseTime(s) {
  if (!s) return null;
  const m = TS_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = '0', frac = '0', off] = m;
  const ms = Number(('0.' + frac).slice(0, 5)) * 1000;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms) -
    offsetMinutes(off || CONFIG.loggerUtcOffset) * 60000;
  return Number.isFinite(utc) ? new Date(utc) : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Displayed times use an explicit zone, never the viewer's own.
const timeFmtRaw = new Intl.DateTimeFormat('en-NZ', {
  timeZone: CONFIG.timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
});
const clockFmtRaw = new Intl.DateTimeFormat('en-NZ', {
  timeZone: CONFIG.timeZone, weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
// "3 Nov, 02:00" style label for the hour a record applies to.
const recordWhenFmt = { format: d => {
  const c = loggerClock(d);
  const mon = new Intl.DateTimeFormat('en-NZ', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, c.month - 1, 1)));
  return `${c.day} ${mon}, ${String(c.hour).padStart(2, '0')}:00`;
} };

// Returns HTML: the zone label is wrapped so it can be styled small.
const timeFmt = { format: d => `${timeFmtRaw.format(d)} <span class="tz">${CONFIG.timeZoneLabel}</span>` };
const clockFmt = clockFmtRaw;                    // header is labelled "UTC +13 (McMurdo Time)"

function ago(d) {
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

// Fixed decimals, true minus sign, and no "-0.0".
function fmt(v, digits) {
  const s = v.toFixed(digits);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s.replace(/^-/, '\u2212');
}

function degToCardinal(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function isFresh(code) {
  const s = store.get(code);
  return !!(s && s.latest && Date.now() - s.latest <= CONFIG.freshHours * HOUR);
}

// Checked recently and found stale or unreachable → don't ask again yet.
function inCooldown(code) {
  const s = store.get(code);
  return !!(s && s.checkedAt && !isFresh(code) &&
    Date.now() - s.checkedAt < CONFIG.recheckStaleMinutes * 60000);
}

// ─── Data loading ─────────────────────────────────────────────
// The proxy returns rows newest first, trimmed to ?hours= back from the newest
// row (one request covers any window, even across days). We stop parsing once
// past the window, which also keeps working against a proxy that ignores ?hours.
function parseCsv(text, site) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const vars = VARIABLES[site.type];
  const rows = [];
  let newest = null;
  // Keep enough history for both the trend line and the latest-value lookup.
  const keepHours = Math.max(CONFIG.trendHours, CONFIG.freshHours);

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split(',');
    const time = parseTime(cells[idx.timestamp_utc]);
    if (!time) continue;
    if (!newest) newest = time;
    if (newest - time > keepHours * HOUR) break;
    const row = { time };
    for (const v of vars) {
      for (const f of [...seriesDefs(v).map(d => d.field), v.dirField, v.gustField, v.windChill && v.windChill.windField]) {
        if (f && f in idx) row[f] = num(cells[idx[f]]);
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

// Fetch one site. On failure, keep whatever we had before (it will age out
// of the 6-hour window on its own) and record the error.
async function fetchSite(site) {
  const checkedAt = Date.now();
  try {
    let rows;
    if (DEMO) {
      await sleep(150);                    // pretend there's a network
      rows = demoRows(site);
    } else {
      // Ask the proxy for just the recent window (newest row back), not the whole file.
      const hours = Math.ceil(Math.max(CONFIG.trendHours, CONFIG.freshHours));
      const res = await fetchWithTimeout(`${CONFIG.proxyBase}/${site.type}/${site.code}?hours=${hours}`);
      rows = parseCsv(await res.text(), site);
    }
    const latest = rows.length ? rows[rows.length - 1].time : null;
    store.set(site.code, { rows, latest, error: null, checkedAt });
    await loadClimFor(site.code, latest);
    for (const [k, p] of climCache) { const doc = await p; if (doc) climDocs.set(k, doc); }
  } catch (e) {
    const prev = store.get(site.code);
    store.set(site.code, {
      rows: prev ? prev.rows : [], latest: prev ? prev.latest : null, error: e.message, checkedAt,
    });
    console.warn(`[current-conditions] ${site.code}: ${e.message}`);
  }
}

// ─── Historical climatology (pre-computed, see maintenance/build_climatology.py) ───
// climatology/<code>/<MM>.json: per day-of-month × hour (UTC+13 clock) long-term
// means and record highs/lows. Missing files just mean no average line.
const climCache = new Map();          // "code/MM" → Promise<doc | null>
const LOGGER_OFFSET_MS = offsetMinutes(CONFIG.loggerUtcOffset) * 60000;

// Instant → { month, day, hour } on the logger clock (independent of viewer zone).
function loggerClock(t) {
  const d = new Date(+t + LOGGER_OFFSET_MS);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours() };
}

function loadClimMonth(code, month) {
  const key = `${code}/${String(month).padStart(2, '0')}`;
  if (!climCache.has(key)) {
    climCache.set(key, fetch(`${CONFIG.climatologyPath}/${key}.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return climCache.get(key);
}

// Make sure the months covering a site's trend window are loaded.
async function loadClimFor(code, latest) {
  if (!CONFIG.climatologyPath || !latest) return;
  const months = new Set([loggerClock(latest).month,
    loggerClock(latest - CONFIG.trendHours * HOUR).month]);
  await Promise.all([...months].map(m => loadClimMonth(code, m)));
}

// Synchronous lookup once loaded: the climatology doc + indices for instant t.
const climDocs = new Map();           // "code/MM" → doc (filled as promises resolve)
function climSlot(code, t) {
  const c = loggerClock(t);
  const doc = climDocs.get(`${code}/${String(c.month).padStart(2, '0')}`);
  return doc ? { doc, d: c.day - 1, h: c.hour } : null;
}

// Hourly average line across [t0, t1], each value plotted at the middle of its hour.
function climSeries(code, key, t0, t1) {
  const pts = [];
  const start = Math.floor((t0 - LOGGER_OFFSET_MS) / HOUR) * HOUR + LOGGER_OFFSET_MS;
  for (let t = start; t <= t1; t += HOUR) {
    const mid = t + HOUR / 2;
    if (mid < t0 || mid > t1) continue;
    const s = climSlot(code, mid);
    const v = s && s.doc.mean[key] && s.doc.mean[key][s.d] ? s.doc.mean[key][s.d][s.h] : null;
    pts.push({ time: new Date(mid), value: v });
  }
  return pts.some(p => p.value != null) ? pts : null;
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeoutSeconds * 1000);
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    throw e.name === 'AbortError' ? new Error(`timed out after ${CONFIG.fetchTimeoutSeconds} s`) : e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Per-variable summaries ───────────────────────────────────
// A variable is either single-valued ({field}) or a group of same-unit
// fields shown in one tile ({series: [{field, name}, ...]}).
function seriesDefs(v) {
  return v.series || [{ field: v.field, name: null }];
}

// latestTime = the site's most recent observation (the trend window hangs off it).
// opts.badIfAllZero: a sensor that read exactly 0 for the whole trend window is
// broken (e.g. RH stuck at 0 %), so treat it as no data.
function summarizeField(field, scale, rows, latestTime, opts = {}) {
  const get = r => (r[field] == null ? null : r[field] * (scale || 1));
  // Latest value: newest non-empty reading within `freshHours` of *now*, so a
  // tile never shows a reading older than that (dash instead).
  const windowStart = Date.now() - CONFIG.freshHours * HOUR;
  let last = null;
  for (let i = rows.length - 1; i >= 0 && rows[i].time >= windowStart; i--) {
    if (get(rows[i]) != null) { last = rows[i]; break; }
  }
  // Trend line and range: the `trendHours` ending at the site's most recent
  // observation (not at "now"), so an hours-old site still gets a full window.
  const trendStart = latestTime - CONFIG.trendHours * HOUR;
  const series = rows.filter(r => r.time >= trendStart).map(r => ({ time: r.time, value: get(r) }));
  const vals = series.map(p => p.value).filter(x => x != null);
  if (opts.badIfAllZero && vals.length && vals.every(x => x === 0)) {
    return { value: null, time: null, last: null, bad: true,
      series: series.map(p => ({ time: p.time, value: null })), min: null, max: null };
  }
  return {
    value: last ? get(last) : null,
    time: last ? last.time : null,
    last,
    series,
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
  };
}

// ─── Rendering ────────────────────────────────────────────────
function segments(series) {
  const segs = [];
  let cur = [];
  series.forEach((p, i) => {
    const gap = i > 0 && p.time - series[i - 1].time > GAP_MS;
    if ((p.value == null || gap) && cur.length) { segs.push(cur); cur = []; }
    if (p.value != null) cur.push(p);
  });
  if (cur.length) segs.push(cur);
  return segs;
}

// Y-axis ticks: round values (1/2/5 × 10^k) inside [lo, hi], using the largest
// step that still gives at least two. More than four are thinned to every other
// one so they fit a short chart. Returns { ticks, digits }.
function yTicks(lo, hi) {
  const span = hi - lo;
  if (!(span > 0)) return { ticks: [], digits: 0 };
  const top = Math.floor(Math.log10(span)) + 1;
  for (let e = top; e >= top - 4; e--) {
    for (const m of [5, 2, 1]) {
      const step = m * Math.pow(10, e);
      const first = Math.ceil(lo / step - 1e-9) * step;
      const n = Math.floor((hi - first) / step + 1e-9) + 1;
      if (n < 2) continue;
      let ticks = Array.from({ length: n }, (_, i) => first + i * step);
      if (n > 4) ticks = ticks.filter((_, i) => i % 2 === 0);
      return { ticks, digits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
    }
  }
  return { ticks: [], digits: 0 };
}

// lines: [{ series, cls }] — all share one y-scale (same unit).
// minSpan: smallest y-range drawn, so sensor noise doesn't look like a trend.
// refs: [{ series, cls }] drawn behind the data (e.g. the historical average),
// sharing the y-scale, with no fill or end dot.
function sparkline(lines, t0, t1, minSpan = 0, refs = []) {
  const W = 200, H = 40, PAD = 3;
  const dataVals = lines.flatMap(l => l.series.map(p => p.value)).filter(v => v != null);
  if (dataVals.length < 2) return '';
  const vals = dataVals.concat(refs.flatMap(r => r.series.map(p => p.value)).filter(v => v != null));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, minSpan, 1e-6);
  const mid = (hi + lo) / 2;
  lo = mid - span / 2; hi = mid + span / 2;
  const x = t => ((t - t0) / (t1 - t0)) * W;
  const y = v => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const pt = p => `${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`;

  // Y-axis: faint gridlines in the SVG, labels as HTML in a left gutter (so
  // they don't stretch with the chart).
  const { ticks, digits } = yTicks(lo, hi);
  const grid = ticks.map(v =>
    `<line class="spark-grid" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" vector-effect="non-scaling-stroke" />`).join('');
  const axis = ticks.map(v =>
    `<span class="spark-tick" style="top:${(y(v) / H * 100).toFixed(2)}%">${fmt(v, digits)}</span>`).join('');

  // Layers, bottom to top: gridlines, data fill, reference (average) lines, data lines.
  let fills = '', refPaths = '', paths = '', dots = '';
  for (const { series, cls } of refs) {
    const segs = segments(series);
    if (segs.length) refPaths += `<path class="spark-ref ${cls}" d="${segs.map(sg => 'M' + sg.map(pt).join('L')).join('')}" vector-effect="non-scaling-stroke" />`;
  }
  for (const { series, cls } of lines) {
    const segs = segments(series);
    if (!segs.length) continue;
    if (lines.length === 1) {
      const area = segs.filter(sg => sg.length > 1).map(sg =>
        `M${x(sg[0].time).toFixed(1)},${H}L` + sg.map(pt).join('L') +
        `L${x(sg[sg.length - 1].time).toFixed(1)},${H}Z`).join('');
      fills += `<path class="spark-area" d="${area}" />`;
    }
    paths += `<path class="spark-line ${cls}" d="${segs.map(sg => 'M' + sg.map(pt).join('L')).join('')}" vector-effect="non-scaling-stroke" />`;
    const ls = segs[segs.length - 1], lp = ls[ls.length - 1];
    // End dot is an HTML overlay so it stays round when the SVG stretches.
    dots += `<span class="spark-dot ${cls}" style="left:${(x(lp.time) / W * 100).toFixed(2)}%;top:${(y(lp.value) / H * 100).toFixed(2)}%"></span>`;
  }
  paths = grid + fills + refPaths + paths;
  return `<div class="spark-axis" aria-hidden="true">${axis}</div>` +
    `<div class="spark-plot"><svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${dots}</div>`;
}

function windArrow(fromDeg) {
  const to = (fromDeg + 180) % 360;
  return `<svg class="wind-arrow" viewBox="-8 -8 16 16" aria-hidden="true">
    <g transform="rotate(${to.toFixed(0)})">
      <line x1="0" y1="6" x2="0" y2="-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M0,-7 L-4,-1.5 L4,-1.5 Z" fill="currentColor"/>
    </g></svg>`;
}

// Wind chill, Environment Canada / US NWS (2001) formula. T in °C, V in km/h.
// Only defined for T ≤ 10 °C and V > 4.8 km/h; null otherwise. Station wind is
// measured at 3 m; the formula assumes 10 m wind, so this slightly understates it.
function windChill(tC, vKmh) {
  if (tC == null || vKmh == null || tC > 10 || vKmh <= 4.8) return null;
  const v16 = Math.pow(vKmh, 0.16);
  return 13.12 + 0.6215 * tC - 11.37 * v16 + 0.3965 * tC * v16;
}

// Change since the reading closest to `hours` before the latest one (within
// 45 min of that time). Returns { label, delta } or null.
function tendency(cfg, s) {
  if (!cfg || s.value == null) return null;
  const target = s.time - cfg.hours * HOUR;
  let best = null;
  for (const p of s.series) {
    if (p.value == null) continue;
    const off = Math.abs(p.time - target);
    if (off <= 45 * 60000 && (!best || off < best.off)) best = { value: p.value, off };
  }
  if (!best) return null;
  const delta = s.value - best.value;
  const label = Math.abs(delta) < cfg.steady ? 'Steady' : delta > 0 ? 'Rising' : 'Falling';
  return { label, delta };
}

function tendencyArrow(label) {
  const rot = { Rising: 45, Steady: 90, Falling: 135 }[label];
  return `<svg class="wind-arrow" viewBox="-8 -8 16 16" aria-hidden="true">
    <g transform="rotate(${rot})">
      <line x1="0" y1="6" x2="0" y2="-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M0,-7 L-4,-1.5 L4,-1.5 Z" fill="currentColor"/>
    </g></svg>`;
}

// "24 h range −20.6 to −12.3" with the values emphasised; '' when there's no data
// (the caption is then left empty so the tile keeps its height).
const rangeHtml = (s, d, label = `${CONFIG.trendHours} h range:`) => (s.min == null ? '' :
  `${label} <span class="range-val">${fmt(s.min, d)}</span> to <span class="range-val">${fmt(s.max, d)}</span>`);

function singleTile(v, s, t0, t1, newest, code) {
  const has = s.value != null;
  const valueStr = has ? fmt(s.value, v.digits) : '—';
  let sub = '';
  let dirHtml = '';
  const dir = s.last && v.dirField ? s.last[v.dirField] : null;
  const gust = s.last && v.gustField && s.last[v.gustField] != null ? s.last[v.gustField] * (v.scale || 1) : null;
  if (v.dirField && has && dir != null) {
    // Direction sits beside the speed, at headline size.
    dirHtml = `
        <span class="wind-dir">
          ${windArrow(dir)}
          <span class="wind-dir-text">
            <span class="wind-cardinal">${degToCardinal(dir)}</span>
            <span class="wind-deg">from ${Math.round(dir)}°</span>
          </span>
        </span>`;
    if (gust != null) sub = `<span>Gust ${fmt(gust, v.digits)} ${escapeHtml(v.unit)}</span>`;
  } else if (has && newest - s.time > HOUR) {
    sub = `<span>as of ${timeFmt.format(s.time)}</span>`;
  } else if (s.bad) {
    sub = '<span>No data</span>';
  } else if (!has) {
    sub = '<span>No recent reading</span>';
  }

  // "Feels like" (wind chill), from the wind reading in the same row.
  let ariaExtra = '';
  if (v.windChill && has && s.last) {
    const ms = s.last[v.windChill.windField];
    if (ms != null) {
      const wc = windChill(s.value, ms * 3.6);
      const feels = wc == null ? s.value : wc;      // calm (or above 10 °C): feels like the air temp
      const { veryCold = -Infinity, warm = Infinity } = v.windChill;
      const band = feels > warm ? ' is-warm' : feels <= veryCold ? ' is-very-cold' : '';
      sub = `<span class="feels-like${band}">Feels like <strong>${fmt(feels, v.digits)} ${escapeHtml(v.unit)}</strong></span>` +
        (sub ? `<span>· ${sub.replace(/^<span>|<\/span>$/g, '')}</span>` : '');
      ariaExtra = `, feels like ${fmt(feels, v.digits)}`;
    }
  }

  // Rising / Falling / Steady, beside the value.
  const tend = tendency(v.tendency, s);
  if (tend) {
    const sign = tend.delta > 0 ? '+' : '';
    dirHtml = `
        <span class="wind-dir side-stat">
          ${tendencyArrow(tend.label)}
          <span class="wind-dir-text">
            <span class="wind-cardinal">${tend.label}</span>
            <span class="wind-deg">${sign}${fmt(tend.delta, v.digits)} ${escapeHtml(v.unit)} in ${v.tendency.hours} h</span>
          </span>
        </span>`;
    ariaExtra = `, ${tend.label.toLowerCase()}`;
  }

  // Historical average line (only alongside real data) and its key.
  const avg = v.clim && s.min != null ? climSeries(code, v.clim, t0, t1) : null;
  const years = avg && climSlot(code, t1) ? climSlot(code, t1).doc.years : null;
  const avgKey = avg
    ? `<span class="avg-key"><span class="swatch s-avg" aria-hidden="true"></span>${years ? `${years[0]}–${years[1]} avg` : 'Historical avg'}</span>`
    : '';

  // Record high / low for this calendar date and hour.
  let recordHtml = '';
  if (v.records && has) {
    const slot = climSlot(code, s.time);
    const rec = slot && slot.doc.record && slot.doc.record[v.records];
    const hi = rec && rec.high[slot.d] && rec.high[slot.d][slot.h];
    const lo = rec && rec.low[slot.d] && rec.low[slot.d][slot.h];
    if (hi && hi[0] != null && lo && lo[0] != null) {
      const when = recordWhenFmt.format(s.time);
      recordHtml = `
      <div class="tile-records">
        <span class="rec-label">Record for ${when}</span>
        <span>High</span><span class="range-val">${fmt(hi[0], v.digits)}</span><span class="rec-year">${hi[1]}</span>
        <span>Low</span><span class="range-val">${fmt(lo[0], v.digits)}</span><span class="rec-year">${lo[1]}</span>
      </div>`;
      ariaExtra += `, record high ${fmt(hi[0], v.digits)} in ${hi[1]}, record low ${fmt(lo[0], v.digits)} in ${lo[1]}`;
    }
  }

  return `
    <article class="tile v-${v.id}${v.wide ? ' wide' : ''}${has ? '' : ' no-value'}" aria-label="${escapeHtml(v.label)}: ${valueStr} ${escapeHtml(v.unit)}${dir != null && has ? ` from ${degToCardinal(dir)}` : ''}${ariaExtra}">
      <div class="tile-top">
        <div class="tile-main">
          <div class="tile-label">${escapeHtml(v.label)}</div>
          <div class="tile-value">
            <span class="tile-number">${valueStr}</span>
            <span class="tile-unit">${escapeHtml(v.unit)}</span>${dirHtml}
          </div>
          <div class="tile-sub">${sub}</div>
        </div>${recordHtml}
      </div>
      <div class="spark-wrap">${sparkline([{ series: s.series, cls: 's-a' }], t0, t1, v.minSpan, avg ? [{ series: avg, cls: 's-avg' }] : [])}</div>
      <div class="spark-caption"><span>${rangeHtml(s, v.digits)}</span>${avgKey}</div>
    </article>`;
}

function groupTile(v, sums, t0, t1) {
  const CLS = ['s-a', 's-b', 's-c'];
  const rows = v.series.map((d, i) => {
    const s = sums[i];
    const has = s.value != null;
    return `
      <div class="pair-row${has ? '' : ' no-value'}">
        <span class="pair-name"><span class="swatch ${CLS[i]}" aria-hidden="true"></span>${escapeHtml(d.name)}</span>
        <span class="tile-value">
          <span class="tile-number">${has ? fmt(s.value, v.digits) : '—'}</span>
          <span class="tile-unit">${escapeHtml(v.unit)}</span>
        </span>
        <span class="pair-range">${rangeHtml(s, v.digits, `${CONFIG.trendHours} h`)}</span>
      </div>`;
  }).join('');
  const label = v.series.map((d, i) => `${d.name} ${sums[i].value != null ? fmt(sums[i].value, v.digits) : 'no reading'}`).join(', ');

  return `
    <article class="tile tile-group${v.wide ? ' wide' : ''}" aria-label="${escapeHtml(v.label)}: ${escapeHtml(label)} ${escapeHtml(v.unit)}">
      <div class="tile-label">${escapeHtml(v.label)}</div>
      <div class="pair">${rows}</div>
      <div class="spark-wrap">${sparkline(sums.map((s, i) => ({ series: s.series, cls: CLS[i] })), t0, t1, v.minSpan)}</div>
    </article>`;
}

function tileHtml(v, rows, t0, t1, newest, code) {
  if (v.series) {
    return groupTile(v, v.series.map(d => summarizeField(d.field, v.scale, rows, newest)), t0, t1);
  }
  return singleTile(v, summarizeField(v.field, v.scale, rows, newest, { badIfAllZero: v.badIfAllZero }), t0, t1, newest, code);
}

// Locator map: the shaded-relief map with every station as a dot and the current
// one highlighted. Drawn as one SVG (image + markers share its coordinates), so
// it scales to whatever space the tile has and the dots stay put.
const [MAP_W, MAP_H] = CONFIG.mapSize || [480, 480];   // image pixel size → SVG viewBox

function mapTileHtml(site) {
  if (!CONFIG.mapImage || !site.map) return '';
  const pos = s => ({ x: s.map[0] / 100 * MAP_W, y: s.map[1] / 100 * MAP_H });
  const others = SITES.filter(s => s.map && s.code !== site.code).map(s => {
    const { x, y } = pos(s);
    const stale = store.get(s.code) && store.get(s.code).checkedAt && !isFresh(s.code);
    return `<g class="map-dot${stale ? ' stale' : ''}" data-code="${s.code}"><title>${escapeHtml(s.name)} (${s.code.toUpperCase()})</title>
      <circle class="hit" cx="${x}" cy="${y}" r="20" /><circle cx="${x}" cy="${y}" r="8" vector-effect="non-scaling-stroke" /></g>`;
  }).join('');
  const { x, y } = pos(site);
  return `
    <article class="tile map-tile" aria-label="Location map: ${escapeHtml(site.name)} in the McMurdo Dry Valleys">
      <div class="tile-label">Location in McMurdo Dry Valleys</div>
      <svg class="map-svg" viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid meet" role="img"
           aria-label="Shaded-relief map of the Dry Valleys with ${escapeHtml(site.name)} marked">
        <image href="${escapeHtml(CONFIG.mapImage)}" width="${MAP_W}" height="${MAP_H}" />
        ${others}
        <circle class="map-here-halo" cx="${x}" cy="${y}" r="28" />
        <circle class="map-here" cx="${x}" cy="${y}" r="14" vector-effect="non-scaling-stroke" />
      </svg>
      <div class="spark-caption"><span>${escapeHtml(CONFIG.mapCredit || '')}</span></div>
    </article>`;
}

// Fill the map tile: show the largest part of the image with the tile's own
// shape, centred on the stations. If that would cut off a station (a tall,
// narrow tile, e.g. on phones), zoom to just fit the stations instead and let
// the view run past the image edge (blank margin) on the long side.
function fitMap() {
  const svg = document.querySelector('.map-svg');
  if (!svg) return;
  const { width: bw, height: bh } = svg.getBoundingClientRect();
  if (!bw || !bh) return;
  const a = bw / bh;
  const xs = SITES.filter(s => s.map).map(s => s.map[0] / 100 * MAP_W);
  const ys = SITES.filter(s => s.map).map(s => s.map[1] / 100 * MAP_H);
  const pad = 0.05 * MAP_W;
  const sx0 = Math.min(...xs) - pad, sx1 = Math.max(...xs) + pad;
  const sy0 = Math.min(...ys) - pad, sy1 = Math.max(...ys) + pad;
  let w = Math.min(MAP_W, MAP_H * a), h = w / a;
  if (w < sx1 - sx0) { w = sx1 - sx0; h = w / a; }
  if (h < sy1 - sy0) { h = sy1 - sy0; w = h * a; }
  // Centre on the stations, kept inside the image where it's big enough.
  const place = (c, len, full) => (len <= full ? Math.min(Math.max(c - len / 2, 0), full - len) : (full - len) / 2);
  const x = place((sx0 + sx1) / 2, w, MAP_W);
  const y = place((sy0 + sy1) / 2, h, MAP_H);
  svg.setAttribute('viewBox', `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
}

function cardHtml(site) {
  const { rows, latest } = store.get(site.code);
  const t1 = latest.getTime();
  const t0 = t1 - CONFIG.trendHours * HOUR;
  const tiles = VARIABLES[site.type]
    .map(v => tileHtml(v, rows, t0, t1, latest, site.code))
    .join('') + mapTileHtml(site);

  return `
    <div class="site-head">
      <div class="site-title">
        ${CONFIG.logoImage ? `<img class="site-logo" src="${escapeHtml(CONFIG.logoImage)}" alt="MCM LTER" />` : ''}
        <div>
          <h1 class="site-name">${escapeHtml(site.name)}, Antarctica</h1>
          <div class="site-meta">
            <span class="site-code">${site.code.toUpperCase()}</span>
          </div>
        </div>
      </div>
      <div class="obs-time">
        Last observation
        <strong>${timeFmt.format(latest)}</strong>
        <span class="obs-ago" data-time="${t1}">${ago(latest)}</span>
      </div>
    </div>
    <div class="tiles">${tiles}</div>`;
}

// Chips: unchecked sites look normal (we just haven't asked yet); sites that
// were checked and came back stale or failed are dashed until re-checked.
function renderDots() {
  const wrap = $('#site-dots');
  wrap.innerHTML = SITES.map(s => {
    const info = store.get(s.code);
    const checked = !!(info && info.checkedAt);
    const stale = checked && !isFresh(s.code);
    const cls = ['site-dot', stale ? 'stale' : '', s.code === currentCode ? 'active' : ''].join(' ').trim();
    let title = `${s.name} (${TYPE_LABEL[s.type]})`;
    if (stale) title += info.error ? ` — couldn't load (${info.error})` : ` — no data in last ${CONFIG.freshHours} h`;
    return `<button class="${cls}" data-code="${s.code}" title="${escapeHtml(title)}" ${inCooldown(s.code) ? 'disabled' : ''}>${s.code.toUpperCase()}</button>`;
  }).join('');
}

function tickAgo() {
  document.querySelectorAll('.obs-ago').forEach(el => { el.textContent = ago(new Date(+el.dataset.time)); });
  $('#cc-clock').textContent = clockFmt.format(new Date());
}

// ─── Transition ───────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const transitionMs = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? 300
    : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--transition-ms')) || 550;

async function showSite(site) {
  const card = $('#site-card');
  const html = cardHtml(site);
  const ms = transitionMs();

  if (!firstRender && site.code !== currentCode) {
    card.classList.remove('is-shown');
    card.classList.add('is-leaving');
    await sleep(ms);
    card.classList.remove('is-leaving');
    card.classList.add('is-entering');      // jump to start position (no transition)
    card.innerHTML = html;
    void card.offsetWidth;                  // force reflow so the next change animates
    card.classList.remove('is-entering');
  } else {
    card.innerHTML = html;
  }
  fitMap();
  card.classList.add('is-shown');
  firstRender = false;
  currentCode = site.code;
  renderDots();
}

function showMessage(msg) {
  const card = $('#site-card');
  card.classList.remove('is-shown');
  card.innerHTML = `<p class="cc-message">${escapeHtml(msg)}</p>`;
  currentCode = null;
  firstRender = true;
  renderDots();
}

// ─── Rotation ─────────────────────────────────────────────────
// Sites are fetched one at a time, only when needed. As soon as a site is on
// screen we start looking for the next one: walk forward through SITES,
// re-requesting each candidate, until one has data from the last
// `freshHours`. Errors, timeouts and stale sites are skipped. That search
// gets the whole `rotateSeconds` to finish, and the card switches on time.

let lookahead = null;                // Promise<site | null | undefined> for the next switch

function setLoadingMessage(site) {
  if (!firstRender) return;                       // only while nothing is on screen yet
  $('#site-card').innerHTML = `<p class="cc-message">Checking ${escapeHtml(site.name)}…</p>`;
}

// Resolves to a fresh site, null if none, or undefined if superseded.
async function findNextSite(fromCode, myGen) {
  const start = SITES.findIndex(s => s.code === fromCode);   // -1 → start at the top
  for (let k = 1; k <= SITES.length; k++) {
    if (myGen !== generation) return undefined;              // superseded (e.g. a chip click)
    const site = SITES[(start + k) % SITES.length];          // last candidate is fromCode itself
    if (inCooldown(site.code)) continue;
    setLoadingMessage(site);
    await fetchSite(site);
    if (myGen !== generation) return undefined;
    renderDots();
    if (isFresh(site.code)) return site;
  }
  return null;
}

function restartProgress() {
  const bar = $('#progress-bar');
  bar.style.transition = 'none';
  bar.style.width = '0';
  void bar.offsetWidth;
  bar.style.transition = `width ${CONFIG.rotateSeconds}s linear`;
  bar.style.width = '100%';
}

// Put a site (or the "nothing reporting" message) on screen, then
// immediately start finding the one after it.
async function present(site, myGen) {
  if (site) await showSite(site);
  else showMessage(`No stations have reported in the last ${CONFIG.freshHours} hours. Checking again shortly…`);
  if (myGen !== generation) return;

  if (site) restartProgress();
  else $('#progress-bar').style.width = '0';

  lookahead = findNextSite(site ? site.code : currentCode, myGen);
  clearTimeout(rotateTimer);
  rotateTimer = setTimeout(() => tick(myGen), CONFIG.rotateSeconds * 1000);
}

// Scheduled switch: use the look-ahead result (waiting if it's still going).
async function tick(myGen) {
  let site = await lookahead;
  if (site === undefined || myGen !== generation) return;
  // It was fresh when fetched up to a minute ago; make sure it still is.
  if (site && !isFresh(site.code)) site = await findNextSite(site.code, myGen);
  if (site === undefined || myGen !== generation) return;
  await present(site, myGen);
}

// First load, or a chip click: drop any look-ahead and start from here.
async function jumpTo(target = null) {
  clearTimeout(rotateTimer);
  const myGen = ++generation;
  let site;
  if (target) {
    await fetchSite(target);
    if (myGen !== generation) return;
    renderDots();
    if (isFresh(target.code)) {
      site = target;
    } else if (currentCode) {
      // Clicked site isn't reporting: stay on the current one, restart its timer.
      restartProgress();
      lookahead = findNextSite(currentCode, myGen);
      rotateTimer = setTimeout(() => tick(myGen), CONFIG.rotateSeconds * 1000);
      return;
    } else {
      site = await findNextSite(target.code, myGen);
    }
  } else {
    site = await findNextSite(currentCode, myGen);
  }
  if (site === undefined || myGen !== generation) return;
  await present(site, myGen);
}

// ─── Demo data ────────────────────────────────────────────────
function demoRows(site) {
  // Two sites pretend to be offline so skipping can be seen.
  const staleHours = { brhm: 30, wlbbb: 9 }[site.code] || 0;
  const end = Math.floor((Date.now() - staleHours * HOUR - 8 * 60000) / (15 * 60000)) * 15 * 60000;
  const seed = [...site.code].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rows = [];
  for (let t = end - CONFIG.trendHours * HOUR; t <= end; t += 15 * 60000) {
    const h = ((t / HOUR) + seed) % 24;
    const day = Math.sin((h - 6) / 24 * 2 * Math.PI);
    const n = () => (Math.sin(t / 7e5 + seed) + Math.sin(t / 2.3e6)) * 0.5;
    const r = { time: new Date(t) };
    if (site.type === 'met') {
      Object.assign(r, {
        air_temp_3m: -12 + 6 * day + n(), rel_hum_3m: 55 - 15 * day + 5 * n(),
        wind_spd_avg: Math.max(0, 4 + 2 * n() + (seed % 3)), wind_spd_max: Math.max(0, 7 + 3 * n()),
        wind_direction: (200 + 40 * n() + seed) % 360, sw_rad_in: Math.max(0, 300 + 450 * day + 30 * n()),
        barom_pres: 985 + (seed % 15) + n(),
      });
    } else {
      Object.assign(r, {
        air_temp_avg: -10 + 5 * day + n(), stage_avg: 2.1 + (seed % 7) / 10 + 0.002 * n(),
        temp_stage_avg: 0.4 + 0.3 * day + 0.1 * n(),
        osat_do_shallow_avg: 140 + 10 * n(), osat_do_deep_avg: 96 + 3 * Math.sin(t / 3e6),
        par_moored_avg: Math.max(0, 20 + 25 * day + 3 * n()),
      });
    }
    rows.push(r);
  }
  return rows;
}

// ─── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Fill the screen when opened directly (phone/desktop/TV); size to content inside an iframe.
  if (window.self !== window.top) document.body.classList.add('embedded');
  tickAgo();
  setInterval(tickAgo, 30000);
  window.addEventListener('resize', fitMap);

  $('#site-dots').addEventListener('click', e => {
    const btn = e.target.closest('.site-dot');
    if (!btn || btn.disabled || btn.dataset.code === currentCode) return;
    jumpTo(SITES.find(s => s.code === btn.dataset.code));
  });

  // Station dots on the map jump too (unless that site is known to be stale).
  $('#site-card').addEventListener('click', e => {
    const dot = e.target.closest('.map-dot');
    if (!dot || dot.classList.contains('stale') || inCooldown(dot.dataset.code)) return;
    jumpTo(SITES.find(s => s.code === dot.dataset.code));
  });

  renderDots();
  jumpTo();                                      // first site shows as soon as one checks out
});
