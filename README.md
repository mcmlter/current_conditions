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

Each station gets six tiles: five measurements and a location map. Each
measurement tile shows the most recent value, plus a trend line (with a value
scale) and the range for the 24 hours leading up to the station's latest
observation.

| Tile | Units | Notes |
|---|---|---|
| Air temperature | °C | At 3 m height, with a "feels like" wind chill and the record high/low |
| Relative humidity | % | At 3 m height |
| Solar radiation | W/m² | Incoming shortwave |
| Wind | kt | Average speed, direction (also along the trend line), and peak gust |
| Barometric pressure | hPa | With a rising / steady / falling trend |
| Location | | Map of the Dry Valleys with every station marked |

The air temperature, humidity and solar tiles also show the **historical average**
for the same dates and times of day as a dashed grey line behind the trend.

### Reading the display

- **Wind direction** is the compass point the wind blows *from*, e.g. "WNW, from 282°".
  The arrow points the way the wind is blowing, matching the MCM live data viewer.
  On larger screens, small arrows along the 24-hour wind line show how the direction
  changed: each is the average direction over a block of hours (given under the
  chart), pointing the way the wind was blowing. They're left off on phones.
- **Feels like** is the wind chill, from the air temperature and average wind speed
  (Environment Canada / US National Weather Service formula). It only applies at
  or below 10 °C with wind above 4.8 km/h; otherwise it equals the air temperature.
  Station wind is measured at 3 m rather than the formula's standard 10 m, so the
  wind chill shown is slightly milder than a standard one would be.
  The box turns solid blue at −25 °C or colder and red above 0 °C.
- **Historical average** (dashed line) is the long-term mean for each hour of the
  day on those calendar dates, from the station's quality-controlled record on EDI.
  It's pooled over a two-week window around each date so it isn't noisy. The key
  under the chart gives the years it covers.
- **Record high / low** is the warmest and coldest air temperature ever recorded on
  that calendar date during that hour of the latest observation, with the year.
- **Pressure trend** compares the latest reading with the one 3 hours earlier:
  *Rising* or *Falling* for a change of 1 hPa or more, otherwise *Steady*.
- **Location map** is the USGS 1:250,000 shaded-relief map of the Dry Valleys with
  every station marked and the one on screen in blue. Click another station's dot
  to jump to it; stations not currently reporting are shown faded.
- **Times** are shown in UTC +13 (McMurdo Time), the time the field loggers keep year-round (the
  same as NZ daylight time). "Last observation" is the logger's most recent record.
  Most sites log every 15 minutes.
- **Site chips** along the bottom list every site in the rotation. Dashed, greyed-out
  chips are sites with no data in the last 12 hours. Click any active chip to jump to
  that site.
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

Developer notes (building the historical data and map) are in [maintenance/README.md](maintenance/README.md).
