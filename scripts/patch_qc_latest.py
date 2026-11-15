"""
patch_qc_latest.py
Ambil qc_flag pada jam terakhir tiap lokasi dari combined_imputed_smoke.csv
dan simpan ke dashboard-data.json sebagai qc_latest.
"""
import json, csv
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'Dataset Fix' / 'combined_imputed_smoke.csv'
DEST = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

# SESUAIKAN: nilai qc_flag yang berarti "valid" (huruf kecil)
VALID_VALUES = {'valid', 'v', '1', 'ok', 'good', 'pass'}

latest = {}      # loc_id -> (ts_hour, qc_flag)
uniques = set()

print(f"Membaca {SRC} ...")
with open(SRC, newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        flag = (row.get('qc_flag') or '').strip()
        uniques.add(flag)
        if flag == '' or flag.lower() in ('nan', 'none'):
            continue
        loc, ts = row['location_id'], row['ts_hour']
        if loc not in latest or ts > latest[loc][0]:
            latest[loc] = (ts, flag)

print("Nilai unik qc_flag:", sorted(uniques))

result = {
    loc: {
        'ts': ts,
        'flag': flag,
        'valid': flag.lower() in VALID_VALUES,
    }
    for loc, (ts, flag) in latest.items()
}

with open(DEST, encoding='utf-8') as f:
    data = json.load(f)
data['qc_latest'] = result
with open(DEST, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print(f"Selesai. qc_latest ({len(result)} lokasi) disimpan.")