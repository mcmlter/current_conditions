/* =============================================================
   MCM Current Conditions — config.js
   Everything you're likely to want to tweak lives here.
   ============================================================= */

'use strict';

const CONFIG = {
  // Cloudflare worker that serves the logger files as CSV.
  // Production origin is https://mcmlter.github.io (see CORS_HEADERS in proxy.js).
  proxyBase: 'https://mcm-proxy.uwcfl.workers.dev',

  rotateSeconds: 60,          // how long each site stays on screen
  freshHours: 12,             // skip sites whose newest record is older than this
  recheckStaleMinutes: 10,    // after a site is stale/unreachable, wait this long before asking again
  fetchTimeoutSeconds: 10,    // give up on a request (and try the next site) after this
  trendHours: 6,              // sparkline + range window under each value

  // Display zone for observation times and the header clock. Fixed UTC+13 to
  // match the logger clocks year-round. (IANA "Etc/GMT-13" means UTC+13;
  // the sign is inverted by convention.) Use 'Antarctica/McMurdo' instead to
  // follow NZ daylight saving.
  timeZone: 'Etc/GMT-13',
  timeZoneLabel: 'UTC+13',

  // Loggers record in fixed UTC+13. The proxy stamps rows with "+13:00";
  // this is used only if a timestamp arrives without an offset.
  loggerUtcOffset: '+13:00',
};

const MS_TO_KT = 1.94384;

// ─── Variables shown per data type (3–5 each) ─────────────────
// field  = column name in the proxy CSV
// scale  = optional multiplier applied to the raw value
// digits = decimals shown
// series = optional list of {field, name} to show several readings in one tile
// wide   = span two columns (3-column desktop grid: 3 tiles on top, wide + 1 below)
// minSpan = smallest y-range the sparkline draws (keeps sensor noise flat)
const VARIABLES = {
  met: [
    { id: 'air_temp', field: 'air_temp_3m', label: 'Air Temperature', unit: '°C', digits: 1, minSpan: 2 },
    { id: 'rh', field: 'rel_hum_3m', label: 'Relative Humidity', unit: '%', digits: 0, minSpan: 10 },
    { id: 'solar', field: 'sw_rad_in', label: 'Solar Radiation', unit: 'W/m²', digits: 0, minSpan: 50 },
    { id: 'wind', wide: true, field: 'wind_spd_avg', label: 'Wind', unit: 'kt', digits: 1, minSpan: 5, scale: MS_TO_KT, dirField: 'wind_direction', gustField: 'wind_spd_max' },
    { id: 'pressure', field: 'barom_pres', label: 'Pressure', unit: 'hPa', digits: 1, minSpan: 2 },
  ],
  lake: [
    { id: 'air_temp', field: 'air_temp_avg', label: 'Air Temperature', unit: '°C', digits: 1, minSpan: 2 },
    { id: 'stage', field: 'stage_avg', label: 'Lake Stage', unit: 'm', digits: 3, minSpan: 0.02 },
    { id: 'water_temp', field: 'temp_stage_avg', label: 'Water Temp (level logger)', unit: '°C', digits: 2, minSpan: 0.5 },
    // Grouped tile: several same-unit fields share one tile and one sparkline.
    {
      id: 'o2', wide: true, label: 'O₂ Saturation', unit: '%', digits: 0, minSpan: 10,
      series: [
        { field: 'osat_do_shallow_avg', name: 'Shallow' },
        { field: 'osat_do_deep_avg', name: 'Deep' },
      ],
    },
    { id: 'par', field: 'par_moored_avg', label: 'Underwater PAR', unit: 'µmol/m²/s', digits: 1, minSpan: 10 },
  ],
};

// ─── Sites, in rotation order ─────────────────────────────────
const SITES = [
  { code: 'boym', type: 'met', name: 'Lake Bonney' },
  { code: 'elbbb', type: 'lake', name: 'East Lake Bonney' },
  { code: 'wlbbb', type: 'lake', name: 'West Lake Bonney' },
  { code: 'tarm', type: 'met', name: 'Taylor Glacier' },
  { code: 'ho2m', type: 'met', name: 'Lake Hoare' },
  { code: 'lhbb', type: 'lake', name: 'Lake Hoare' },
  { code: 'caam', type: 'met', name: 'Canada Glacier' },
  { code: 'frlm', type: 'met', name: 'Lake Fryxell' },
  { code: 'lfbb', type: 'lake', name: 'Lake Fryxell' },
  { code: 'hodm', type: 'met', name: 'Howard Glacier' },
  { code: 'cohm', type: 'met', name: 'Commonwealth Glacier' },
  { code: 'exem', type: 'met', name: "Explorer's Cove" },
  { code: 'brhm', type: 'met', name: 'Lake Brownworth' },
  { code: 'vaam', type: 'met', name: 'Lake Vanda' },
  { code: 'viam', type: 'met', name: 'Victoria Valley' },
];
