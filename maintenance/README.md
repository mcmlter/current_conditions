# Maintenance

Developer notes for the Current Conditions dashboard. Nothing in this folder is
loaded by the page; it's the source material and scripts for the pre-built files
the page uses (`img/dry-valleys.png`, the station map positions in `config.js`,
and `climatology/`).

| Path | What it's for |
|---|---|
| `maintenance/README.md` | This file |
| `maintenance/build_map.R` | Builds `img/dry-valleys.png` and the station map positions |
| `maintenance/RossIsland_DryValleys_250kDRG_HighRes.gif` | Source map for `build_map.R` (USGS, 3.7 MB) |
| `maintenance/build_climatology.py` | Builds the historical averages and records in `climatology/` |
| `climatology_sources.json` (repository root) | EDI package for each station, read by `build_climatology.py` |

Run every command below from the repository root.

## Running the page locally

    python3 -m http.server 8000

Then open <http://localhost:8000/>. Add `?demo` to the URL for synthetic data
if the data proxy isn't reachable from your machine. Most settings (timing, the
12-hour freshness window, the 24-hour trend window, variables, stations) are in
`config.js`.

## Updating the historical data

The averages and records are pre-computed into `climatology/<station>/<MM>.json`
(one small file per station per month) by `maintenance/build_climatology.py`, from the
MCM LTER met data on EDI. To build or refresh them (needs Python 3.9+ and pandas):

1. `climatology_sources.json` (repository root) already lists each station's EDI
   package (from <https://mcm.lternet.edu/meteorology-datasets/>) and its
   "high-frequency data" table. Edit it only to add a station, e.g.
   `"mism": { "edi": "knb-lter-mcm.7020", "entity": "high-frequency" }`, or to use
   downloaded CSVs instead: `"csv": ["path/to/file.csv"]`.
2. If EDI asks for an API key, create one in EDI's IAM (avatar menu → Access Keys)
   and either `export EDI_API_KEY=...` or save it in `maintenance/.edi_key` (git-ignored).
   The script adds it to each request; without one it connects anonymously.
3. Check the columns are found: `python maintenance/build_climatology.py --check`
4. Build: `python maintenance/build_climatology.py`, then commit the `climatology/` folder.

Source timestamps are assumed to be UTC+13, like the loggers (`--utc-offset` changes
that). Values carrying a data flag are left out. Stations without files simply show
no average line or records. The script's header lists the optional per-station
settings (`entity`, `station`, `columns`, `time_format`).

## Updating the location map

`img/dry-valleys.png` and the station positions (`map: [x, y]` in `SITES`, and
`mapSize` in config.js) come from `maintenance/build_map.R`. It crops the USGS Ross
Island & Dry Valleys 1:250,000 map in this folder to the stations, shrinks it to a
680 px wide, 128-colour PNG (~160 KB) and prints each station's position. The scanned
map isn't georeferenced, so the script fits its projection from the lat/long tick
marks on the map frame (accurate to well under a pixel). Needs R with magick:

    Rscript maintenance/build_map.R

Then paste the printed positions and size into config.js. To add a station, add its
lat/long to the table at the top of the script and re-run.
