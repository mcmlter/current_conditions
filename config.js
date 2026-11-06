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

  // Locator map (USGS 1:250,000 shaded relief, cropped to the stations).
  // Set to null to hide the map tile.
  mapImage: 'img/dry-valleys.png',
  mapSize: [680, 400],        // the image's pixel size
  mapCredit: 'Map: USGS 1:250,000 shaded relief',
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
//       (from the stations' GPS coordinates, georeferenced to the map's graticule)
const SITES = [
  { code: 'boym', type: 'met', name: 'Lake Bonney', map: [38.6, 71.2] },
  { code: 'tarm', type: 'met', name: 'Taylor Glacier', map: [32.8, 75.1] },
  { code: 'ho2m', type: 'met', name: 'Lake Hoare', map: [46.0, 58.1] },
  { code: 'caam', type: 'met', name: 'Canada Glacier', map: [47.1, 56.5] },
  { code: 'frlm', type: 'met', name: 'Lake Fryxell', map: [50.8, 56.1] },
  { code: 'hodm', type: 'met', name: 'Howard Glacier', map: [49.3, 64.6] },
  { code: 'cohm', type: 'met', name: 'Commonwealth Glacier', map: [52.7, 49.5] },
  { code: 'exem', type: 'met', name: "Explorer's Cove", map: [55.1, 52.8] },
  { code: 'brhm', type: 'met', name: 'Lake Brownworth', map: [42.1, 31.7] },
  { code: 'vaam', type: 'met', name: 'Lake Vanda', map: [24.3, 45.8] },
  { code: 'viam', type: 'met', name: 'Lake Vida', map: [25.7, 24.9] },
];
