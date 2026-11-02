# MCM Current Conditions

A live "current conditions" display for the
[McMurdo Dry Valleys Long Term Ecological Research (MCM LTER)](https://mcm.lternet.edu)
program in Antarctica. It shows the latest readings from one weather station or
lake buoy at a time and moves on to the next site every minute. Sites that
haven't reported in the last 12 hours are skipped automatically.

The page works on phones, desktops and large lobby displays.

> **Provisional data.** These are near-real-time readings straight from the field
> loggers. They have not been quality-controlled and may contain sensor errors or
> gaps. For research use, please use the published, quality-controlled datasets
> from the [MCM LTER data catalog](https://mcm.lternet.edu/data/) instead.

## What's shown

Each site gets five tiles. Each tile shows the most recent value, a trend line for
the last 6 hours, and the 6-hour range.

**Meteorological stations**

| Tile | Units | Notes |
|---|---|---|
| Air temperature | °C | At 3 m height |
| Relative humidity | % | At 3 m height |
| Solar radiation | W/m² | Incoming shortwave |
| Wind | kt | Average speed, direction, and peak gust |
| Barometric pressure | hPa | |

**Lake buoys**

| Tile | Units | Notes |
|---|---|---|
| Air temperature | °C | |
| Lake stage | m | Lake water level |
| Water temperature | °C | At the level logger |
| Underwater PAR | µmol/m²/s | Photosynthetically active radiation (moored sensor) |
| O₂ saturation | % | Shallow (solid line) and deep (dashed line) sensors |

### Reading the display

- **Wind direction** is the compass point the wind blows *from*, e.g. "WNW, from 282°".
  The arrow points the way the wind is blowing, matching the MCM live data viewer.
- **Times** are shown in UTC+13, the time the field loggers keep year-round (the
  same as NZ daylight time). "Last observation" is the logger's most recent record.
  Most sites log every 15 minutes.
- **Site chips** along the bottom list every site in the rotation. Dashed, greyed-out
  chips are sites with no data in the last 12 hours. Click any active chip to jump to
  that site.
- **The blue bar** under the chips counts down to the next site.
- A dash (**—**) means the sensor had no valid reading in the last 12 hours, even
  though the site is otherwise reporting.

## Sites

| Code | Site | Type |
|---|---|---|
| BOYM | Lake Bonney | Met station |
| ELBBB | East Lake Bonney | Lake buoy |
| WLBBB | West Lake Bonney | Lake buoy |
| TARM | Taylor Glacier | Met station |
| HO2M | Lake Hoare | Met station |
| LHBB | Lake Hoare | Lake buoy |
| CAAM | Canada Glacier | Met station |
| FRLM | Lake Fryxell | Met station |
| LFBB | Lake Fryxell | Lake buoy |
| HODM | Howard Glacier | Met station |
| COHM | Commonwealth Glacier | Met station |
| EXEM | Explorer's Cove | Met station |
| BRHM | Lake Brownworth | Met station |
| VAAM | Lake Vanda | Met station |
| VIAM | Victoria Valley | Met station |


