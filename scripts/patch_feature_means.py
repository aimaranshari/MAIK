"""
patch_feature_means.py
1. Inject feature_national_means ke dashboard-data.json
   (rata-rata nasional semua fitur SHAP: polutan + meteo)
2. Tambahkan kolom meteo (temperature_c, humidity_pct, wind_speed_ms)
   ke sparklines_per_loc agar contribution score bisa dihitung per-lokasi
"""
import json, csv
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'Dataset Fix' / 'combined_imputed_smoke.csv'
DEST = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

FEAT_KEYS = ['pm25','pm10','so2','co','o3','no2',
             'temperature_c','humidity_pct','wind_speed_ms','wind_direction_deg']
PPM_LOCS  = {'LOC-PSW-01','LOC-BJB-01','LOC-MDN-01'}

# ── Langkah 1: hitung mean nasional semua fitur ───────────────────────────────
print("Menghitung mean nasional...")
nat_buckets = {k: [] for k in FEAT_KEYS}

# Langkah 2 sekaligus: per-lokasi harian untuk meteo
METEO_KEYS = ['temperature_c','humidity_pct','wind_speed_ms','wind_direction_deg']
per_loc_meteo = defaultdict(lambda: defaultdict(lambda: {k: [] for k in METEO_KEYS}))

with open(SRC, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        ts     = row['ts_hour'][:10]
        loc_id = row['location_id']
        for k in FEAT_KEYS:
            raw = row.get(k, '').strip()
            if not raw or raw.lower() in ('nan','none'): continue
            if k in ('pm25','pm10') and loc_id in PPM_LOCS: continue
            try:
                v = float(raw)
                if v >= 0:
                    nat_buckets[k].append(v)
            except ValueError:
                pass
        for k in METEO_KEYS:
            raw = row.get(k, '').strip()
            if not raw or raw.lower() in ('nan','none'): continue
            try:
                v = float(raw)
                per_loc_meteo[loc_id][ts][k].append(v)
            except ValueError:
                pass

nat_means = {}
for k, vals in nat_buckets.items():
    nat_means[k] = round(sum(vals)/len(vals), 4) if vals else None
    print(f"  {k}: {nat_means[k]}")

# ── Langkah 3: tambah meteo ke sparklines_per_loc ─────────────────────────────
print("\nMemuat dashboard-data.json...")
with open(DEST, encoding='utf-8') as f:
    data = json.load(f)

all_dates = data.get('sparklines_full_dates', [])
date_idx  = {d: i for i, d in enumerate(all_dates)}

spl = data.get('sparklines_per_loc', {})
print(f"Menambah meteo ke {len(spl)} lokasi...")

for loc_id, entry in spl.items():
    for k in METEO_KEYS:
        series = []
        for d in all_dates:
            vals = per_loc_meteo[loc_id][d][k] if d in per_loc_meteo[loc_id] else []
            series.append(round(sum(vals)/len(vals), 4) if vals else None)
        entry[k] = series

# ── Langkah 4: inject ke JSON ─────────────────────────────────────────────────
data['feature_national_means'] = nat_means
data['sparklines_per_loc']     = spl  # sudah diupdate dengan meteo

with open(DEST, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print(f"✅ Selesai. feature_national_means + meteo per-lokasi disimpan ke {DEST}")
