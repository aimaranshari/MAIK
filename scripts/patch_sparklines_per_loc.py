"""
patch_sparklines_per_loc.py
Baca combined_imputed_smoke.csv, agregasi mean harian per-lokasi,
lalu inject ke dashboard-data.json sebagai sparklines_per_loc.

Struktur output:
  sparklines_per_loc = {
    "LOC-IDP-01": {
      "dates": ["2023-12-31", ...],   // shared date axis (sama untuk semua lokasi)
      "pm25":  [v1, v2, ...],
      "pm10":  [...],
      ...
    },
    ...
  }
  sparklines_full_dates: ["2023-12-31", ..., "2026-10-14"]  // axis bersama
"""
import json, csv
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent

POLLUTANTS = ['pm25', 'pm10', 'so2', 'co', 'o3', 'no2']
PPM_LOCS   = {'LOC-PSW-01', 'LOC-BJB-01', 'LOC-MDN-01'}

src  = ROOT / 'Dataset Fix' / 'combined_imputed_smoke.csv'
dest = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

# ── Langkah 1: baca CSV → bucket {loc_id: {date: {pol: [values]}}} ───────────
print(f"Membaca {src} ...")
# per_loc[loc_id][date][pol] = [val, ...]
per_loc = defaultdict(lambda: defaultdict(lambda: {p: [] for p in POLLUTANTS}))

with open(src, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        ts     = row['ts_hour'][:10]   # "YYYY-MM-DD"
        loc_id = row['location_id']
        for pol in POLLUTANTS:
            if pol in ('pm25', 'pm10') and loc_id in PPM_LOCS:
                continue
            raw = row.get(pol, '').strip()
            if not raw or raw.lower() in ('nan', 'none'):
                continue
            try:
                v = float(raw)
                if v >= 0:
                    per_loc[loc_id][ts][pol].append(v)
            except ValueError:
                pass

# ── Langkah 2: bangun date axis bersama ──────────────────────────────────────
all_dates = sorted({d for loc in per_loc.values() for d in loc.keys()})
print(f"  Date axis: {all_dates[0]} → {all_dates[-1]}  ({len(all_dates)} hari)")

# ── Langkah 3: hitung mean harian per-lokasi, align ke all_dates ─────────────
result = {}
for loc_id, date_dict in per_loc.items():
    entry = {}
    for pol in POLLUTANTS:
        series = []
        for d in all_dates:
            vals = date_dict[d][pol] if d in date_dict else []
            series.append(round(sum(vals)/len(vals), 4) if vals else None)
        entry[pol] = series
    result[loc_id] = entry
    non_null = {p: sum(1 for v in result[loc_id][p] if v is not None) for p in POLLUTANTS}
    print(f"  {loc_id}: pm25={non_null['pm25']}, pm10={non_null['pm10']}, so2={non_null['so2']} hari non-null")

# ── Langkah 4: patch JSON ─────────────────────────────────────────────────────
print(f"\nMemuat {dest} ...")
with open(dest, encoding='utf-8') as f:
    data = json.load(f)

data['sparklines_full_dates'] = all_dates
data['sparklines_per_loc']    = result

with open(dest, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print(f"✅ Selesai. sparklines_per_loc ({len(result)} lokasi) disimpan ke {dest}")
