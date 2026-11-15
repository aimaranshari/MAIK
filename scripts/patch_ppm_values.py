"""
patch_ppm_values.py
Isi sparklines_per_loc[lokasi_ppm]['pm25'/'pm10'] dengan nilai asli (satuan ppm)
dan simpan daftar lokasi ppm ke dashboard-data.json.
"""
import json, csv
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'Dataset Fix' / 'combined_imputed_smoke.csv'
DEST = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

PPM_LOCS = ['LOC-PSW-01', 'LOC-BJB-01', 'LOC-MDN-01']
PPM_POLS = ['pm25', 'pm10']

# buckets[loc][date][pol] = [nilai ppm...]
buckets = {loc: defaultdict(lambda: {p: [] for p in PPM_POLS}) for loc in PPM_LOCS}

print(f"Membaca {SRC} ...")
with open(SRC, newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        loc = row['location_id']
        if loc not in buckets:
            continue
        date = row['ts_hour'][:10]
        for pol in PPM_POLS:
            raw = row.get(pol, '').strip()
            if not raw or raw.lower() in ('nan', 'none'):
                continue
            try:
                v = float(raw)
                if v >= 0:
                    buckets[loc][date][pol].append(v)
            except ValueError:
                pass

print(f"Memuat {DEST} ...")
with open(DEST, encoding='utf-8') as f:
    data = json.load(f)

all_dates = data['sparklines_full_dates']
spl = data['sparklines_per_loc']

for loc in PPM_LOCS:
    entry = spl.setdefault(loc, {})
    for pol in PPM_POLS:
        series = []
        for d in all_dates:
            vals = buckets[loc][d][pol] if d in buckets[loc] else []
            series.append(round(sum(vals) / len(vals), 6) if vals else None)
        entry[pol] = series
        n = sum(1 for v in series if v is not None)
        print(f"  {loc} {pol}: {n}/{len(all_dates)} hari non-null (ppm)")

data['ppm_locations']  = PPM_LOCS
data['ppm_pollutants'] = PPM_POLS

with open(DEST, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print("Selesai. ppm_locations + nilai ppm per-lokasi disimpan.")