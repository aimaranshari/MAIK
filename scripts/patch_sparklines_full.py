"""
patch_sparklines_full.py
Baca combined_imputed_smoke.csv, agregasi mean harian semua lokasi (exclude ppm),
lalu inject ke dashboard-data.json sebagai sparklines_national_full.
"""
import json, csv
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent

POLLUTANTS = ['pm25', 'pm10', 'so2', 'co', 'o3', 'no2']
PPM_LOCS   = {'LOC-PSW-01', 'LOC-BJB-01', 'LOC-MDN-01'}   # skip for PM25/PM10

src  = ROOT / 'Dataset Fix' / 'combined_imputed_smoke.csv'
dest = ROOT / 'Dashboard'   / 'data' / 'dashboard-data.json'

# ── Langkah 1: baca CSV, bucket per (date, pollutant) ────────────────────────
# key = date string "YYYY-MM-DD", val = {pol: [values...]}
daily = defaultdict(lambda: {p: [] for p in POLLUTANTS})

print(f"Membaca {src} …")
with open(src, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        ts     = row['ts_hour']          # "2023-12-31 23:00:00"
        date   = ts[:10]                 # "2023-12-31"
        loc_id = row['location_id']

        for pol in POLLUTANTS:
            # skip PM25/PM10 untuk lokasi ppm
            if pol in ('pm25', 'pm10') and loc_id in PPM_LOCS:
                continue
            raw = row.get(pol, '').strip()
            if raw == '' or raw.lower() in ('nan', 'none', ''):
                continue
            try:
                v = float(raw)
                if v >= 0:
                    daily[date][pol].append(v)
            except ValueError:
                pass

# ── Langkah 2: hitung mean harian ────────────────────────────────────────────
dates_sorted = sorted(daily.keys())
result = {'dates': dates_sorted}
for pol in POLLUTANTS:
    result[pol] = []
    for d in dates_sorted:
        vals = daily[d][pol]
        result[pol].append(round(sum(vals)/len(vals), 4) if vals else None)

print(f"  Rentang: {dates_sorted[0]} → {dates_sorted[-1]}  ({len(dates_sorted)} hari)")
for pol in POLLUTANTS:
    non_null = sum(1 for v in result[pol] if v is not None)
    print(f"  {pol}: {non_null}/{len(dates_sorted)} hari non-null")

# ── Langkah 3: patch dashboard-data.json ─────────────────────────────────────
print(f"\nMemuat {dest} …")
with open(dest, encoding='utf-8') as f:
    data = json.load(f)

data['sparklines_national_full'] = result

with open(dest, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print(f"✅ Selesai. sparklines_national_full disimpan ke {dest}")
