# MCM Current Conditions

A live "current conditions" display for the
[McMurdo Dry Valleys Long Term Ecological Research (MCM LTER)](https://mcm.lternet.edu)
program in Antarctica. It shows the latest readings from one weather station at a
time and moves on to the next station every minute. Sites that
haven't reported in the last 12 hours are skipped automatically.

The page works on phones, desktops and large lobby displays.

> **Provisional data.** These are near-real-time readings straight from the field
> loggers. They have not been quality-controlled and may contain sensor errors or
> gaps. For research use, please use the published, quality-controlled datasets
> from the [MCM LTER data catalog](https://mcm.lternet.edu/data/) instead.

## What's shown

Each station gets five tiles. Each tile shows the most recent value, plus a trend
line and range for the 24 hours leading up to the station's latest observation.

| Tile | Units | Notes |
|---|---|---|
| Air temperature | °C | At 3 m height, with a "feels like" wind chill and record high/low |
| Relative humidity | % | At 3 m height |
| Solar radiation | W/m² | Incoming shortwave |

The air temperature, humidity and solar tiles also show the **historical average**
for the same dates and times of day as a dashed grey line behind the trend.
| Wind | kt | Average speed, direction, and peak gust |
| Barometric pressure | hPa | With a rising / steady / falling trend |

### Reading the display

- **Wind direction** is the compass point the wind blows *from*, e.g. "WNW, from 282°".
  The arrow points the way the wind is blowing, matching the MCM live data viewer.
- **Feels like** is the wind chill, from the air temperature and average wind speed
  (Environment Canada / US National Weather Service formula). It only applies at
  or below 10 °C with wind above 4.8 km/h; otherwise it equals the air temperature.
  Station wind is measured at 3 m rather than the formula's standard 10 m, so the
  wind chill shown is slightly milder than a standard one would be.
- **Historical average** (dashed line) is the long-term mean for each hour of the
  day on those calendar dates, from the station's quality-controlled record on EDI.
  It's pooled over a two-week window around each date so it isn't noisy. The key
  under the chart gives the years it covers.
- **Record high / low** is the warmest and coldest air temperature ever recorded on
  that calendar date during that hour of the latest observation, with the year.
- **Pressure trend** compares the latest reading with the one 3 hours earlier:
  *Rising* or *Falling* for a change of 1 hPa or more, otherwise *Steady*.
- **Times** are shown in UTC +13 (McMurdo Time), the time the field loggers keep year-round (the
  same as NZ daylight time). "Last observation" is the logger's most recent record.
  Most sites log every 15 minutes.
- **Site chips** along the bottom list every site in the rotation. Dashed, greyed-out
  chips are sites with no data in the last 12 hours. Click any active chip to jump to
  that site.
- **Location map** shows every station on the USGS 1:250,000 shaded-relief map of the Dry Valleys,
  with the current one in blue. Click another station's dot to jump to it.
- **The blue bar** under the chips counts down to the next site.
- A dash (**—**) means the sensor had no valid reading in the last 12 hours, even
  though the site is otherwise reporting.

## Sites

| Code | Station |
|---|---|
| BOYM | Lake Bonney |
| TARM | Taylor Glacier |
| HO2M | Lake Hoare |
| CAAM | Canada Glacier |
| FRLM | Lake Fryxell |
| HODM | Howard Glacier |
| COHM | Commonwealth Glacier |
| EXEM | Explorer's Cove |
| BRHM | Lake Brownworth |
| VAAM | Lake Vanda |
| VIAM | Lake Vida |

## Updating the historical data

The averages and records are pre-computed into `climatology/<station>/<MM>.json`
(one small file per station per month) by `tools/build_climatology.py`, from the
MCM LTER met data on EDI. To build or refresh them (needs Python 3.9+ and pandas):

1. Put each station's EDI package ID in `tools/climatology_sources.json`, e.g.
   `"boym": { "edi": "knb-lter-mcm.XXXX" }`, or point at downloaded CSVs with
   `"csv": ["path/to/file.csv"]`.
2. If EDI asks for an API key, create one in EDI's IAM (avatar menu → Access Keys)
   and either `export EDI_API_KEY=...` or save it in `tools/.edi_key` (git-ignored).
   The script adds it to each request; without one it connects anonymously.
3. Check the columns are found: `python tools/build_climatology.py --check`
4. Build: `python tools/build_climatology.py`, then commit the `climatology/` folder.

Source timestamps are assumed to be UTC+13, like the loggers (`--utc-offset` changes
that). Values carrying a data flag are left out. Stations without files simply show
no average line or records.


## Updating the location map

`img/dry-valleys.png` and the station positions (`map: [x, y]` in `SITES`, and
`mapSize` in config.js) come from `tools/build_map.R`. It crops the USGS Ross Island &
Dry Valleys 1:250,000 map in `location/` to the stations, shrinks it to a 680 px wide,
128-colour PNG (~160 KB) and prints each station's position. The scanned map isn't
georeferenced, so the script fits its projection from the lat/long tick marks on the
map frame (accurate to well under a pixel). Needs R with magick:

    Rscript tools/build_map.R

Then paste the printed positions and size into config.js. To add a station, add its
lat/long to the table at the top of the script and re-run.
