#!/usr/bin/env python3
"""
Build the locator map (img/dry-valleys.jpg) from the high-resolution satellite
GeoTIFF, and print each station's position on it (as % of the image width /
height) for SITES in config.js, plus the mapSize.

    python maintenance/build_map.py
    python maintenance/build_map.py --tif /path/to/MDV_region_highres.tif

Source: maintenance/MDV_region_highres.tif, a 10 m/px true-colour GeoTIFF of
the McMurdo Dry Valleys region (WGS 84 / UTM zone 58S, ~1.5 GB, uncompressed).
It is too big for git, so it is listed in .gitignore; keep a copy outside the
repo and put it back here (or pass --tif) to rebuild the map.

Needs Python 3.9+ and: pip install numpy pillow tifffile pyproj
"""

import argparse
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image
from pyproj import Transformer

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TIF = HERE / "MDV_region_highres.tif"
OUT = ROOT / "img" / "dry-valleys.jpg"

MARGIN_KM = 20      # context around the outermost stations
ASPECT = 1.7        # widen the crop to this width:height (about the map tile's shape on
                    # desktop); the page trims whatever doesn't fit, keeping stations centred
WIDTH = 1360        # output width in px (2x the tile's largest size, for sharp screens)

# Stations in the rotation (from the MCM LTER GPS list).
STATIONS = {
    "boym": (-77.71473, 162.4647), "tarm": (-77.74020, 162.1284), "ho2m": (-77.62399, 162.8995),
    "caam": (-77.61315, 162.9647), "frlm": (-77.61130, 163.1701), "hodm": (-77.67108, 163.0784),
    "cohm": (-77.56453, 163.2826), "exem": (-77.58870, 163.4175), "brhm": (-77.43350, 162.7036),
    "vaam": (-77.52567, 161.6913), "viam": (-77.37735, 161.7991),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tif", default=TIF, type=Path)
    args = ap.parse_args()

    with tifffile.TiffFile(args.tif) as t:
        page = t.pages[0]
        res, sy = page.tags["ModelPixelScaleTag"].value[:2]
        e0, n0 = page.tags["ModelTiepointTag"].value[3:5]
        epsg = page.geotiff_tags["ProjectedCSTypeGeoKey"]
    to_xy = Transformer.from_crs(4326, int(epsg), always_xy=True)
    img = tifffile.memmap(args.tif)
    rows, cols = img.shape[:2]

    px = {}
    for code, (lat, lon) in STATIONS.items():
        e, n = to_xy.transform(lon, lat)
        px[code] = ((e - e0) / res, (n0 - n) / sy)
    m = MARGIN_KM * 1000 / res
    xs, ys = [p[0] for p in px.values()], [p[1] for p in px.values()]
    x0, x1, y0, y1 = min(xs) - m, max(xs) + m, min(ys) - m, max(ys) + m
    w, h = x1 - x0, y1 - y0
    if w / h < ASPECT:                       # widen (or heighten) about the centre
        x0 -= (h * ASPECT - w) / 2; w = h * ASPECT
    else:
        y0 -= (w / ASPECT - h) / 2; h = w / ASPECT
    x0 = int(round(min(max(x0, 0), cols - w)))
    y0 = int(round(min(max(y0, 0), rows - h)))
    w, h = int(round(w)), int(round(h))

    height = round(WIDTH / ASPECT)
    crop = Image.fromarray(np.ascontiguousarray(img[y0:y0 + h, x0:x0 + w, :3]))
    crop.resize((WIDTH, height), Image.LANCZOS).save(OUT, quality=82, optimize=True, progressive=True)
    print(f"{OUT.relative_to(ROOT)}: {WIDTH} x {height}, {OUT.stat().st_size // 1024} KB, "
          f"{w * res / 1000:.0f} x {h * res / 1000:.0f} km")
    print(f"  mapSize: [{WIDTH}, {height}],")
    for code, (sx, sy) in px.items():
        print(f"  {code}: map: [{100 * (sx - x0) / w:.1f}, {100 * (sy - y0) / h:.1f}]")


if __name__ == "__main__":
    main()
