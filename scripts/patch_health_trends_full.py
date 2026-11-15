"""
patch_health_trends_full.py
Bangun ulang health_trends penuh (seluruh tanggal) per lokasi dari
HLT-01_health_outcomes_daily_with_smoke.csv dan inject ke dashboard-data.json.
"""
import json, csv
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'Dataset Fix' / 'HLT-01_health_outcomes_daily_with_smoke.csv'   # SESUAIKAN
DEST = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

TARGETS = ['resp', 'resp_admissions_under5', 'resp_admissions_over60',
           'asthma_emergency_cases', 'copd_admissions', 'cvd', 'death']

# buckets[loc][date][target] = [nilai...]
buckets = defaultdict(lambda: defaultdict(lambda: {t: [] for t in TARGETS}))

print(f"Membaca {SRC} ...")
with open(SRC, newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        loc  = row['location_id']
        date = row['date'][:10]
        for t in TARGETS:
            raw = (row.get(t) or '').strip()
            if not raw or raw.lower() in ('nan', 'none'):
                continue
            try:
                buckets[loc][date][t].append(float(raw))
            except ValueError:
                pass

all_dates = sorted({d for loc in buckets.values() for d in loc})
print(f"  Rentang: {all_dates[0]} -> {all_dates[-1]} ({len(all_dates)} hari)")

result = {}
for loc, by_date in buckets.items():
    entry = {'dates': all_dates}
    for t in TARGETS:
        series = []
        for d in all_dates:
            vals = by_date[d][t] if d in by_date else []
            series.append(round(sum(vals) / len(vals), 4) if vals else None)
        entry[t] = series
    result[loc] = entry

with open(DEST, encoding='utf-8') as f:
    data = json.load(f)

old = data.get('health_trends', {})
if old:
    sample = next(iter(old.values()))
    print(f"  Sebelumnya: {len(sample.get('dates', []))} hari")

data['health_trends'] = result

with open(DEST, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print(f"Selesai. health_trends ({len(result)} lokasi) disimpan.")