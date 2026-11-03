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
    store.set(site.code, { rows, latest: rows.length ? rows[rows.length - 1].time : null, error: null, checkedAt });
  } catch (e) {
    const prev = store.get(site.code);
    store.set(site.code, {
      rows: prev ? prev.rows : [], latest: prev ? prev.latest : null, error: e.message, checkedAt,
    });
    console.warn(`[current-conditions] ${site.code}: ${e.message}`);
  }
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
      sub = `<span class="feels-like">Feels like <strong>${fmt(feels, v.digits)} ${escapeHtml(v.unit)}</strong></span>` +
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

  return `
    <article class="tile${v.wide ? ' wide' : ''}${has ? '' : ' no-value'}" aria-label="${escapeHtml(v.label)}: ${valueStr} ${escapeHtml(v.unit)}${dir != null && has ? ` from ${degToCardinal(dir)}` : ''}${ariaExtra}">
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
  return singleTile(v, summarizeField(v.field, v.scale, rows, newest, { badIfAllZero: v.badIfAllZero }), t0, t1, newest);
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

  $('#site-dots').addEventListener('click', e => {
    const btn = e.target.closest('.site-dot');
    if (!btn || btn.disabled || btn.dataset.code === currentCode) return;
    jumpTo(SITES.find(s => s.code === btn.dataset.code));
  });

  renderDots();
  jumpTo();                                      // first site shows as soon as one checks out
});
