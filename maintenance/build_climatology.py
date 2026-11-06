#!/usr/bin/env python3
"""
Build the historical climatology files the Current Conditions dashboard reads.

For each station it writes one small JSON file per calendar month:

    climatology/<code>/<MM>.json

Each file holds, for every day of that month and every hour of the day
(times on the UTC+13 logger clock):

  * mean   - long-term average of air temperature, relative humidity and
             incoming solar radiation for that date and hour. Each value is
             the mean of hourly means from all years, pooled over a window of
             +/- SMOOTH_DAYS around the date so the line isn't noisy.
  * record - highest and lowest air temperature ever recorded on that exact
             calendar date during that hour (any year), and the year it
             happened.

Input is the quality-controlled MCM LTER met data from EDI. Either point the
script at EDI package IDs (it downloads the newest revision) or at CSV files
you've already downloaded. Configure stations in climatology_sources.json
(in the repository root):

    {
      "boym": { "edi": "knb-lter-mcm.XXXX" },
      "tarm": { "csv": ["~/Downloads/tarm_15min.csv"] },
      ...
    }

Optional per-station keys:
    "entity":   substring of the EDI table name to use (default: the first
                table that has a date/time column and air temperature)
    "station":  value to filter on if the table holds several stations
                (matched against a metlocid / station column; default: code)
    "columns":  override column names, e.g. {"time": "DATE_TIME", "air_temp": "AIRT3M"}
    "time_format": strptime format for the time column, if pandas can't guess

EDI access key: if EDI requires one, create it in EDI's IAM (avatar menu →
Access Keys) and either export it or save it to maintenance/.edi_key (git-ignored):

    export EDI_API_KEY=...            # or: echo '...' > maintenance/.edi_key

Usage (needs Python 3.9+ and pandas):

    python maintenance/build_climatology.py                 # all stations in the config
    python maintenance/build_climatology.py boym tarm       # just these
    python maintenance/build_climatology.py --check         # list columns found, write nothing

Timestamps are assumed to be on the UTC+13 logger clock, the same as the live
data. Pass --utc-offset if a source uses something else (e.g. --utc-offset 0
for UTC); values are shifted onto UTC+13 before grouping.
"""

import argparse
import gzip
import io
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PASTA = "https://pasta.lternet.edu/package"

SMOOTH_DAYS = 7          # +/- days pooled for the mean line
MIN_YEARS = 3            # fewer distinct years than this → no mean for that slot
LOGGER_OFFSET_H = 13     # the dashboard's clock

# Candidate column names, compared after lower-casing and removing
# everything except letters and digits. First match wins.
CANDIDATES = {
    "time": ["datetime", "datetimenzst", "timestamp", "date_time", "datetimeutc13", "date"],
    "station": ["metlocid", "metloc", "station", "stationid", "siteid", "locid", "site"],
    # EDI MCM tables use e.g. airtemp_3m_degc, rhh2o_3m_pct, swradin_wm2.
    "air_temp": ["airtemp3m", "airt3m", "airtemp3mdegc", "airt3mavg", "airt", "airtemp", "airtc"],
    # RH over water (rhh2o), not over ice (rhice): matches the live logger's RH3m.
    "rh": ["rhh2o3m", "rh3m", "rhw3m", "relhum3m", "rh3mavg", "rhh2o", "rh", "relhum"],
    "solar": ["swradin", "swin", "swradinavg", "eppleyswradin", "solarrad", "swrad"],
}

# Rounding per variable in the output
DIGITS = {"air_temp": 1, "rh": 0, "solar": 0}

MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]   # leap-year calendar


def norm(name):
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ─── Getting the data ─────────────────────────────────────────────────────
# EDI access key (https://edirepository.org/user-guides/iam#working-with-api-access-keys).
# Read from the EDI_API_KEY environment variable, or from maintenance/.edi_key
# (git-ignored). It's appended to each PASTA request as ?key=…, which EDI's
# gatekeeper swaps for a short-lived token. With no key, requests go anonymously.
KEY_FILE = HERE / ".edi_key"


def edi_key():
    key = os.environ.get("EDI_API_KEY", "").strip()
    if not key and KEY_FILE.exists():
        key = KEY_FILE.read_text().strip()
    return key or None


def with_key(url):
    key = edi_key()
    if not key or not url.startswith(PASTA):
        return url
    return url + ("&" if "?" in url else "?") + "key=" + urllib.parse.quote(key, safe="")


def http_get(url):
    req = urllib.request.Request(with_key(url), headers={"User-Agent": "mcm-current-conditions-climatology"})
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.read()
    except urllib.error.HTTPError as e:
        # Report the URL without the key.
        hint = ""
        if e.code in (401, 403):
            hint = (" (access denied: set EDI_API_KEY or put your key in maintenance/.edi_key)"
                    if not edi_key() else " (access denied: check the key is valid and not expired)")
        raise SystemExit(f"EDI request failed: HTTP {e.code} for {url}{hint}") from None


def edi_tables(package_id, entity_hint=None):
    """Yield (name, bytes) for each data table in the newest revision of an EDI package."""
    scope, ident = package_id.split(".")[0], package_id.split(".")[1]
    rev = http_get(f"{PASTA}/eml/{scope}/{ident}?filter=newest").decode().strip().split()[-1]
    names = http_get(f"{PASTA}/name/eml/{scope}/{ident}/{rev}").decode().strip().splitlines()
    log(f"  {scope}.{ident}.{rev}: {len(names)} table(s): " + "; ".join(n.partition(",")[2] for n in names))
    entities = [line.partition(",")[::2] for line in names]
    # Try the high-frequency (15-min) table first; summaries last.
    entities.sort(key=lambda e: table_rank(e[1]))
    if entity_hint:
        matched = [e for e in entities if entity_hint.lower() in e[1].lower()]
        if matched:
            entities = matched
        else:
            log(f"  no table named like '{entity_hint}'; trying tables in order of likelihood")
    for entity_id, name in entities:
        log(f"  downloading '{name}' …")
        yield name, http_get(f"{PASTA}/data/eml/{scope}/{ident}/{rev}/{entity_id}")


def table_rank(name):
    n = name.lower()
    if re.search(r"high.?frequency", n):      # MCM's 15-min tables: "high-frequency data"
        return -1
    if re.search(r"daily|day|month|annual|year|summary|soil|snow|station|location|sensor", n):
        return 2
    if re.search(r"15|high.?freq|min|raw|met", n):
        return 0
    return 1


def find_col(columns, key, override=None):
    if override:
        for c in columns:
            if c == override or norm(c) == norm(override):
                return c
        raise SystemExit(f"column '{override}' not found; columns are: {list(columns)}")
    normed = {norm(c): c for c in columns}
    for cand in CANDIDATES[key]:
        if cand in normed:
            return normed[cand]
    # Looser: a column that starts with a candidate, to allow unit/stat suffixes
    # (airtemp_3m_degc, swradin_wm2, AIRT3M_AVG). Short candidates ("rh", "date")
    # are left out of this so they can't grab an unrelated column.
    for cand in CANDIDATES[key]:
        if len(cand) < 5:
            continue
        for n, c in normed.items():
            if n.startswith(cand):
                return c
    return None


COMMON_FORMATS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
                  "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%m/%d/%y %H:%M", "%d/%m/%Y %H:%M"]


def guess_format(series):
    """A fixed format parses far faster than format='mixed'. Try the common ones
    on a sample; return None to fall back to pandas' guessing."""
    sample = series.dropna().astype(str).str.strip()
    sample = sample.iloc[:: max(1, len(sample) // 500)]
    for f in COMMON_FORMATS:
        try:
            pd.to_datetime(sample, format=f)
            return f
        except (ValueError, TypeError):
            continue
    return None


def unpack(name, raw):
    """EDI packages can hold zip/gzip archives alongside plain tables.
    Yield (name, bytes) for each file inside, or the file itself."""
    if raw[:2] == b"\x1f\x8b":
        yield from unpack(re.sub(r"\.gz$", "", name), gzip.decompress(raw))
    elif raw[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            for member in z.namelist():
                if not member.endswith("/"):
                    yield from unpack(f"{name}/{member}", z.read(member))
    else:
        yield name, raw


def text_encoding(raw):
    """'utf-8', 'cp1252' for text in an older Windows encoding, or None if the
    file looks binary (PDF, image, spreadsheet…)."""
    sample = raw[:65536]
    if b"\x00" in sample or sample[:5] == b"%PDF-":
        return None
    try:
        sample.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError as e:
        if e.start > len(sample) - 4:        # sample cut a multi-byte character
            return "utf-8"
    text = sample.decode("cp1252", errors="replace")
    printable = sum(c.isprintable() or c in "\r\n\t" for c in text) / max(1, len(text))
    return "cp1252" if printable > 0.97 and "\ufffd" not in text else None


def read_table(raw, cfg, code):
    """Parse one table → DataFrame[time, air_temp, rh, solar] or None if unsuitable."""
    enc = text_encoding(raw)
    if enc is None:
        return None, "not a text table"
    try:
        df = pd.read_csv(io.BytesIO(raw), low_memory=False, encoding=enc)
    except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeDecodeError) as e:
        return None, f"couldn't parse as CSV ({type(e).__name__})"
    over = cfg.get("columns", {})
    cols = {k: find_col(df.columns, k, over.get(k)) for k in CANDIDATES}
    if not cols["time"] or not cols["air_temp"]:
        return None, cols

    # Filter by station only when the table actually holds several.
    if cols["station"] and df[cols["station"]].nunique(dropna=True) > 1:
        want = norm(cfg.get("station", code))
        df = df[df[cols["station"]].map(norm) == want]
        if df.empty:
            return None, cols

    fmt = cfg.get("time_format") or guess_format(df[cols["time"]])
    t = pd.to_datetime(df[cols["time"]], format=fmt) if fmt else pd.to_datetime(df[cols["time"]], format="mixed")
    out = pd.DataFrame({"time": t})
    for key in ("air_temp", "rh", "solar"):
        c = cols[key]
        if not c:
            out[key] = np.nan
            continue
        vals = pd.to_numeric(df[c], errors="coerce")
        # EDI MCM tables carry a flag column per variable (e.g. FLAG_AIRT3M);
        # drop flagged values.
        flag = next((f for f in df.columns if norm(f) in (f"flag{norm(c)}", f"{norm(c)}flag")), None)
        if flag is not None:
            flagged = df[flag].notna() & (df[flag].astype(str).str.strip() != "")
            vals = vals.mask(flagged)
        out[key] = vals.values
    return out.dropna(subset=["time"]), cols


def load_station(code, cfg, utc_offset):
    frames, seen = [], []

    def sources():
        # Lazily, so we stop downloading once a suitable EDI table turns up.
        if cfg.get("edi"):
            yield from edi_tables(cfg["edi"], cfg.get("entity"))
        for p in cfg.get("csv", []):
            path = Path(p).expanduser()
            yield path.name, path.read_bytes()

    done = False
    for outer_name, outer_raw in sources():
        for name, raw in unpack(outer_name, outer_raw):
            df, cols = read_table(raw, cfg, code)
            seen.append((name, cols))
            if df is None or not len(df):
                log(f"  skipping '{name}': {cols if isinstance(cols, str) else 'no date/time + air temperature columns'}")
                continue
            log(f"  using '{name}': {len(df):,} rows, columns {cols}")
            frames.append(df)
            if cfg.get("edi"):
                done = True     # first suitable EDI table is enough
                break
        if done:
            break
    if not frames:
        raise SystemExit(f"{code}: no usable table. Looked at: {seen}")
    df = pd.concat(frames).drop_duplicates("time").sort_values("time")
    # Shift onto the UTC+13 logger clock if the source uses another offset.
    df["time"] = df["time"] + pd.Timedelta(hours=LOGGER_OFFSET_H - utc_offset)
    return df


# ─── Climatology ──────────────────────────────────────────────────────────
def build(df):
    t = df["time"]
    df = df.assign(year=t.dt.year, month=t.dt.month, day=t.dt.day, hour=t.dt.hour,
                   date=t.dt.normalize())

    # Hourly means first, so 15-min and hourly records weigh the same.
    hourly = df.groupby(["date", "hour"]).agg(
        year=("year", "first"), month=("month", "first"), day=("day", "first"),
        air_temp=("air_temp", "mean"), rh=("rh", "mean"), solar=("solar", "mean"),
        t_max=("air_temp", "max"), t_min=("air_temp", "min"),
    ).reset_index()

    # Day index on a leap-year calendar (Feb 29 = its own slot) so a date
    # always maps to the same index whatever the year.
    starts = np.cumsum([0] + MONTH_DAYS[:-1])
    hourly["doy"] = starts[hourly["month"] - 1] + hourly["day"] - 1
    ndays = 366

    mean = {}
    for key in ("air_temp", "rh", "solar"):
        s = hourly.dropna(subset=[key])
        sums = np.zeros((ndays, 24)); counts = np.zeros((ndays, 24))
        np.add.at(sums, (s["doy"].values, s["hour"].values), s[key].values)
        np.add.at(counts, (s["doy"].values, s["hour"].values), 1)
        # distinct years per slot (for the MIN_YEARS rule), pooled over the window
        years = s.groupby(["doy", "hour"])["year"].unique()
        win_sum = np.zeros_like(sums); win_cnt = np.zeros_like(counts)
        for off in range(-SMOOTH_DAYS, SMOOTH_DAYS + 1):
            win_sum += np.roll(sums, -off, axis=0)
            win_cnt += np.roll(counts, -off, axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            m = win_sum / win_cnt
        yearsets = [[set() for _ in range(24)] for _ in range(ndays)]
        for (d, h), ys in years.items():
            for off in range(-SMOOTH_DAYS, SMOOTH_DAYS + 1):
                yearsets[(d + off) % ndays][h].update(ys.tolist())
        for d in range(ndays):
            for h in range(24):
                if len(yearsets[d][h]) < MIN_YEARS:
                    m[d, h] = np.nan
        mean[key] = m

    # Records: exact calendar date + hour, any year.
    rec = {}
    s = hourly.dropna(subset=["t_max"])
    idx_max = s.groupby(["doy", "hour"])["t_max"].idxmax()
    idx_min = s.groupby(["doy", "hour"])["t_min"].idxmin()
    for name, idx, col in (("high", idx_max, "t_max"), ("low", idx_min, "t_min")):
        val = np.full((ndays, 24), np.nan); year = np.zeros((ndays, 24), dtype=int)
        r = s.loc[idx.values]
        val[r["doy"].values, r["hour"].values] = r[col].values
        year[r["doy"].values, r["hour"].values] = r["year"].values
        rec[name] = (val, year)

    return mean, rec, int(df["year"].min()), int(df["year"].max())


def rnd(x, d):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    return round(float(x), d) if d else int(round(float(x)))


def write_station(code, mean, rec, y0, y1, out_dir, source):
    starts = np.cumsum([0] + MONTH_DAYS[:-1])
    sdir = out_dir / code
    sdir.mkdir(parents=True, exist_ok=True)
    for mi, nd in enumerate(MONTH_DAYS):
        days = range(starts[mi], starts[mi] + nd)
        doc = {
            "station": code, "month": mi + 1, "years": [y0, y1], "source": source,
            "clock": "UTC+13", "smooth_days": SMOOTH_DAYS,
            # [day-of-month - 1][hour] — hour h covers h:00–h:59
            "mean": {k: [[rnd(mean[k][d, h], DIGITS[k]) for h in range(24)] for d in days] for k in mean},
            "record": {
                "air_temp": {
                    side: [[[rnd(v[d, h], 1), int(yr[d, h]) or None] for h in range(24)] for d in days]
                    for side, (v, yr) in rec.items()
                }
            },
        }
        (sdir / f"{mi + 1:02d}.json").write_text(json.dumps(doc, separators=(",", ":")))
    log(f"  wrote {sdir}/01..12.json ({y0}–{y1})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stations", nargs="*", help="station codes (default: all in the config)")
    ap.add_argument("--config", default=ROOT / "climatology_sources.json", type=Path)
    ap.add_argument("--out", default=ROOT / "climatology", type=Path)
    ap.add_argument("--utc-offset", type=float, default=LOGGER_OFFSET_H,
                    help="UTC offset (hours) of the source timestamps; default 13")
    ap.add_argument("--check", action="store_true", help="show the columns found and stop")
    args = ap.parse_args()

    cfg_all = json.loads(args.config.read_text())
    codes = args.stations or [c for c in cfg_all if not c.startswith("_")]
    for code in codes:
        cfg = cfg_all.get(code)
        if not cfg or not (cfg.get("edi") or cfg.get("csv")):
            log(f"{code}: no 'edi' or 'csv' source configured; skipping")
            continue
        log(f"{code}:")
        df = load_station(code, cfg, args.utc_offset)
        log(f"  {df['time'].min()} → {df['time'].max()} (UTC+13)")
        if args.check:
            continue
        mean, rec, y0, y1 = build(df)
        write_station(code, mean, rec, y0, y1, args.out, cfg.get("edi") or "local CSV")


if __name__ == "__main__":
    main()
