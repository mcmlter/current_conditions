# Maintenance

Developer notes for the Current Conditions dashboard. Nothing in this folder is
loaded by the page; it's the source material and scripts for the pre-built files
the page uses (`img/dry-valleys.jpg`, the station map positions in `config.js`,
and `climatology/`).

| Path | What it's for |
|---|---|
| `maintenance/README.md` | This file |
| `maintenance/build_map.py` | Builds `img/dry-valleys.jpg` and the station map positions |
| `maintenance/MDV_region_highres.tif` | Source imagery for `build_map.py` (10 m GeoTIFF, ~1.5 GB; not in git, see below) |
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

`img/dry-valleys.jpg` and the station positions (`map: [x, y]` in `SITES`, and
`mapSize` in config.js) come from `maintenance/build_map.py`. It crops a 10 m per
pixel true-colour Sentinel-2 satellite GeoTIFF of the Dry Valleys (`MDV_region_highres.tif`,
WGS 84 / UTM zone 58S) to the stations plus 20 km, saves it 1360 × 800 px (~230 KB)
and prints each station's position. Needs `pip install numpy pillow tifffile pyproj`:

    python maintenance/build_map.py
    python maintenance/build_map.py --tif /elsewhere/MDV_region_highres.tif

Then paste the printed positions and size into config.js. To add a station, add its
lat/long to the list at the top of the script and re-run.

The GeoTIFF is ~1.5 GB, so `.gitignore` keeps `maintenance/*.tif` out of git. A copy
lives in the MCM Conditions Display's `maintenance/` folder; keep one somewhere safe.
(The image stops at about 167° E, so the stations sit a little right of centre.)

