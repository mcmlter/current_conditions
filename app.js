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

const store = new Map();             // code → { rows: [{time, ...fields}], latest: Date|null, error }
let currentCode = null;
let rotateTimer = null;
let firstRender = true;

// ─── Small helpers ────────────────────────────────────────────
const $ = sel => document.querySelector(sel);

function num(v) {
  if (v === '' || v == null) return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

function parseTime(s) {
  if (!s) return null;
  let ts = s.trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(ts)) ts += CONFIG.fallbackUtcOffset;
  const d = new Date(ts);
  return isNaN(d) ? null : d;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const timeFmt = new Intl.DateTimeFormat('en-NZ', {
  timeZone: CONFIG.timeZone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
});
const clockFmt = new Intl.DateTimeFormat('en-NZ', {
  timeZone: CONFIG.timeZone, weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
});

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

// ─── Data loading ─────────────────────────────────────────────
// The proxy returns the whole logger file, newest row first. We only keep
// the trend window, so we can stop parsing early.
function parseCsv(text, site) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const vars = VARIABLES[site.type];
  const rows = [];
  let newest = null;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split(',');
    const time = parseTime(cells[idx.timestamp_utc]);
    if (!time) continue;
    if (!newest) newest = time;
    if (newest - time > CONFIG.trendHours * HOUR) break;
    const row = { time };
    for (const v of vars) {
      for (const f of [...seriesDefs(v).map(d => d.field), v.dirField, v.gustField]) {
        if (f && f in idx) row[f] = num(cells[idx[f]]);
      }
    }
    rows.push(row);
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

async function fetchSite(site) {
  try {
    const rows = DEMO
      ? demoRows(site)
      : parseCsv(await (await fetchOk(`${CONFIG.proxyBase}/${site.type}/${site.code}`)).text(), site);
    store.set(site.code, { rows, latest: rows.length ? rows[rows.length - 1].time : null, error: null });
  } catch (e) {
    const prev = store.get(site.code);
    store.set(site.code, { rows: prev ? prev.rows : [], latest: prev ? prev.latest : null, error: e.message });
    console.warn(`[current-conditions] ${site.code}: ${e.message}`);
  }
}

async function fetchOk(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function refreshAll() {
  const queue = [...SITES];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) await fetchSite(queue.shift());
  });
  await Promise.all(workers);
  renderDots();
}

// ─── Per-variable summaries ───────────────────────────────────
// A variable is either single-valued ({field}) or a group of same-unit
// fields shown in one tile ({series: [{field, name}, ...]}).
function seriesDefs(v) {
  return v.series || [{ field: v.field, name: null }];
}

function summarizeField(field, scale, rows, latestTime) {
  const get = r => (r[field] == null ? null : r[field] * (scale || 1));
  const windowStart = latestTime - CONFIG.freshHours * HOUR;
  let last = null;
  for (let i = rows.length - 1; i >= 0 && rows[i].time >= windowStart; i--) {
    if (get(rows[i]) != null) { last = rows[i]; break; }
  }
  const series = rows.map(r => ({ time: r.time, value: get(r) }));
  const vals = series.map(p => p.value).filter(x => x != null);
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

// lines: [{ series, cls }] — all share one y-scale (same unit).
// minSpan: smallest y-range drawn, so sensor noise doesn't look like a trend.
function sparkline(lines, t0, t1, minSpan = 0) {
  const W = 200, H = 40, PAD = 3;
  const vals = lines.flatMap(l => l.series.map(p => p.value)).filter(v => v != null);
  if (vals.length < 2) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, minSpan, 1e-6);
  const mid = (hi + lo) / 2;
  lo = mid - span / 2; hi = mid + span / 2;
  const x = t => ((t - t0) / (t1 - t0)) * W;
  const y = v => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const pt = p => `${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`;

  let paths = '', dots = '';
  for (const { series, cls } of lines) {
    const segs = segments(series);
    if (!segs.length) continue;
    if (lines.length === 1) {
      const area = segs.filter(sg => sg.length > 1).map(sg =>
        `M${x(sg[0].time).toFixed(1)},${H}L` + sg.map(pt).join('L') +
        `L${x(sg[sg.length - 1].time).toFixed(1)},${H}Z`).join('');
      paths += `<path class="spark-area" d="${area}" />`;
    }
    paths += `<path class="spark-line ${cls}" d="${segs.map(sg => 'M' + sg.map(pt).join('L')).join('')}" vector-effect="non-scaling-stroke" />`;
    const ls = segs[segs.length - 1], lp = ls[ls.length - 1];
    // End dot is an HTML overlay so it stays round when the SVG stretches.
    dots += `<span class="spark-dot ${cls}" style="left:${(x(lp.time) / W * 100).toFixed(2)}%;top:${(y(lp.value) / H * 100).toFixed(2)}%"></span>`;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${dots}`;
}

function windArrow(fromDeg) {
  const to = (fromDeg + 180) % 360;
  return `<svg class="wind-arrow" viewBox="-8 -8 16 16" aria-hidden="true">
    <g transform="rotate(${to.toFixed(0)})">
      <line x1="0" y1="6" x2="0" y2="-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M0,-7 L-4,-1.5 L4,-1.5 Z" fill="currentColor"/>
    </g></svg>`;
}

const rangeText = (s, d) => (s.min != null ? `${fmt(s.min, d)} to ${fmt(s.max, d)}` : 'no data');

function singleTile(v, s, t0, t1, newest) {
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
  } else if (!has) {
    sub = '<span>No recent reading</span>';
  }

  return `
    <article class="tile${v.wide ? ' wide' : ''}${has ? '' : ' no-value'}" aria-label="${escapeHtml(v.label)}: ${valueStr} ${escapeHtml(v.unit)}${dir != null && has ? ` from ${degToCardinal(dir)}` : ''}">
      <div class="tile-label">${escapeHtml(v.label)}</div>
      <div class="tile-value">
        <span class="tile-number">${valueStr}</span>
        <span class="tile-unit">${escapeHtml(v.unit)}</span>${dirHtml}
      </div>
      <div class="tile-sub">${sub}</div>
      <div class="spark-wrap">${sparkline([{ series: s.series, cls: 's-a' }], t0, t1, v.minSpan)}</div>
      <div class="spark-caption">${CONFIG.trendHours} h range ${rangeText(s, v.digits)}</div>
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
        <span class="pair-range">${CONFIG.trendHours} h ${rangeText(s, v.digits)}</span>
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

function tileHtml(v, rows, t0, t1, newest) {
  if (v.series) {
    return groupTile(v, v.series.map(d => summarizeField(d.field, v.scale, rows, newest)), t0, t1);
  }
  return singleTile(v, summarizeField(v.field, v.scale, rows, newest), t0, t1, newest);
}

function cardHtml(site) {
  const { rows, latest } = store.get(site.code);
  const t1 = latest.getTime();
  const t0 = t1 - CONFIG.trendHours * HOUR;
  const tiles = VARIABLES[site.type]
    .map(v => tileHtml(v, rows, t0, t1, latest))
    .join('');

  return `
    <div class="site-head">
      <div>
        <h1 class="site-name">${escapeHtml(site.name)}</h1>
        <div class="site-meta">
          <span class="type-pill">${TYPE_LABEL[site.type]}</span>
          <span class="site-code">${site.code.toUpperCase()}</span>
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

function renderDots() {
  const wrap = $('#site-dots');
  wrap.innerHTML = SITES.map(s => {
    const fresh = isFresh(s.code);
    const cls = ['site-dot', fresh ? '' : 'stale', s.code === currentCode ? 'active' : ''].join(' ').trim();
    const title = `${s.name} (${TYPE_LABEL[s.type]})` + (fresh ? '' : ` — no data in last ${CONFIG.freshHours} h`);
    return `<button class="${cls}" data-code="${s.code}" title="${escapeHtml(title)}" ${fresh ? '' : 'disabled'}>${s.code.toUpperCase()}</button>`;
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
function nextFreshSite() {
  const start = Math.max(-1, SITES.findIndex(s => s.code === currentCode));
  for (let k = 1; k <= SITES.length; k++) {
    const s = SITES[(start + k) % SITES.length];
    if (isFresh(s.code)) return s;
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

async function advance(target) {
  clearTimeout(rotateTimer);
  const site = target || nextFreshSite();
  if (site) {
    await showSite(site);
    restartProgress();
  } else {
    showMessage(`No stations have reported in the last ${CONFIG.freshHours} hours. Checking again shortly…`);
    $('#progress-bar').style.width = '0';
  }
  rotateTimer = setTimeout(() => advance(), CONFIG.rotateSeconds * 1000);
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

  $('#site-dots').addEventListener('click', e => {
    const btn = e.target.closest('.site-dot');
    if (!btn || btn.disabled || btn.dataset.code === currentCode) return;
    advance(SITES.find(s => s.code === btn.dataset.code));
  });

  // Keep the 6-hour rule honest: re-fetch on a schedule. If the site on
  // screen goes stale, the next rotation simply skips it.
  setInterval(refreshAll, CONFIG.refreshMinutes * 60000);

  // Show the first fresh site as soon as it arrives rather than waiting
  // for every fetch to finish.
  let started = false;
  const tryStart = () => { if (!started && SITES.some(s => isFresh(s.code))) { started = true; advance(); } };
  const pending = SITES.map(s => fetchSite(s).then(() => { renderDots(); tryStart(); }));
  await Promise.all(pending);
  if (!started) { started = true; advance(); }
});
