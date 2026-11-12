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

  // When to ask the proxy for a site again (see fetchDue in app.js). The
  // loggers upload every 6 hours, so a site that has data isn't re-fetched
  // until 6 h 10 min after its newest observation; if that upload is late,
  // it's re-asked every lateRecheckMinutes until new data arrives.
  updateHours: 6,
  updateGraceMinutes: 10,
  lateRecheckMinutes: 30,
  noDataRecheckHours: 3,      // nothing within freshHours, or the proxy returned an error: recheck this often
  errorRecheckMinutes: 10,    // no answer at all (network drop / timeout): try again after this
  fetchTimeoutSeconds: 10,    // give up on a request (and try the next site) after this
  trendHours: 24,             // sparkline + range window, back from the site's latest observation

  // Display zone for observation times and the header clock. Fixed UTC+13 to
  // match the logger clocks year-round. (IANA "Etc/GMT-13" means UTC+13;
  // the sign is inverted by convention.) Use 'Antarctica/McMurdo' instead to
  // follow NZ daylight saving.
  timeZone: 'Etc/GMT-13',
  timeZoneLabel: 'UTC+13',

  // Loggers record in fixed UTC+13. The proxy stamps rows with "+13:00";
  // this is used only if a timestamp arrives without an offset.
  loggerUtcOffset: '+13:00',

  // Pre-computed historical averages / records (maintenance/build_climatology.py).
  // Set to null to turn the average lines and records off.
  climatologyPath: 'climatology',

  // Wind-direction arrows along the wind trend line (one per time block,
  // averaged, pointing the way the wind blows). Blocks are sized so arrows sit
  // about `spacingRem` apart (scales with the display, like the arrows
  // themselves); screens narrower than `minScreenPx` get none.
  // Set to null to turn them off.
  windArrows: { spacingRem: 2.2, minScreenPx: 701 },

  // Logo beside the station name. Set to null to hide it.
  logoImage: 'img/MCM_bigger_better_trans.png',

  // Locator map (10 m Sentinel-2 satellite image, cropped to the stations; maintenance/build_map.py).
  // Set to null to hide the map tile.
  mapImage: 'img/dry-valleys.jpg',
  mapSize: [1360, 800],        // the image's pixel size
  mapCredit: 'Contains modified Copernicus Sentinel data 2026',
};

const MS_TO_KT = 1.94384;

// ─── Variables shown per data type (3–5 each; only met stations are in the rotation) ─────────────────
// field  = column name in the proxy CSV
// scale  = optional multiplier applied to the raw value
// digits = decimals shown
// series = optional list of {field, name} to show several readings in one tile
// wide   = span two columns (3-column desktop grid: 3 tiles on top, wide + 1 below)
// minSpan = smallest y-range the sparkline draws (keeps sensor noise flat)
// clim    = climatology key for a dashed historical-average line (air_temp, rh, solar)
// records = climatology key for the record high/low at this date + hour (air_temp)
// badIfAllZero = treat as no data if every reading in the trend window is exactly 0
// windChill = { windField, veryCold, warm }: show "Feels like" from this wind column
//             (m/s, same row). The box is solid blue at or below `veryCold`, red
//             above `warm` (°C), pale blue in between.
// tendency  = { hours, steady }: Rising/Falling vs. the reading `hours` earlier;
//             changes smaller than `steady` (in display units) count as Steady
const VARIABLES = {
  met: [
    { id: 'air_temp', field: 'air_temp_3m', label: 'Air Temperature', unit: '°C', digits: 1, minSpan: 2, windChill: { windField: 'wind_spd_avg', veryCold: -25, warm: 0 }, clim: 'air_temp', records: 'air_temp' },
    { id: 'rh', field: 'rel_hum_3m', label: 'Relative Humidity', unit: '%', digits: 0, minSpan: 10, badIfAllZero: true, clim: 'rh' },
    { id: 'solar', field: 'sw_rad_in', label: 'Solar Radiation', unit: 'W/m²', digits: 0, minSpan: 50, clim: 'solar' },
    { id: 'wind', field: 'wind_spd_avg', label: 'Wind', unit: 'kt', digits: 1, minSpan: 5, scale: MS_TO_KT, dirField: 'wind_direction', gustField: 'wind_spd_max', dirArrows: true },
    { id: 'pressure', field: 'barom_pres', label: 'Pressure', unit: 'hPa', digits: 1, minSpan: 2, tendency: { hours: 3, steady: 1 } },
  ],
};

// ─── Sites, in rotation order ─────────────────────────────────
// map = [x, y] position on CONFIG.mapImage, in % of its width / height
//       (from the stations' GPS coordinates; printed by maintenance/build_map.py)
const SITES = [
  { code: 'boym', type: 'met', name: 'Lake Bonney', map: [55.7, 71.0] },
  { code: 'tarm', type: 'met', name: 'Taylor Glacier', map: [50.0, 75.0] },
  { code: 'ho2m', type: 'met', name: 'Lake Hoare', map: [63.1, 57.8] },
  { code: 'caam', type: 'met', name: 'Canada Glacier', map: [64.2, 56.3] },
  { code: 'frlm', type: 'met', name: 'Lake Fryxell', map: [67.8, 55.8] },
  { code: 'hodm', type: 'met', name: 'Howard Glacier', map: [66.3, 64.2] },
  { code: 'cohm', type: 'met', name: 'Commonwealth Glacier', map: [69.7, 49.2] },
  { code: 'exem', type: 'met', name: "Explorer's Cove", map: [72.1, 52.4] },
  { code: 'brhm', type: 'met', name: 'Lake Brownworth', map: [59.0, 31.5] },
  { code: 'vaam', type: 'met', name: 'Lake Vanda', map: [41.4, 45.8] },
  { code: 'viam', type: 'met', name: 'Lake Vida', map: [42.6, 25.0] },
];
