"""
patch_shap_v2.py
Baca shap_summary.csv setiap target (lag=-1), hitung:
  - mean_shap (signed): positif = risiko naik, negatif = risiko turun
  - mean_abs_shap: untuk CI proxy (±std tidak tersedia, pakai mean_abs - |mean| sebagai CI half-width)
  - relative_effect_pct: dinormalisasi ke |mean_abs_shap| terbesar = 100
  - signed_pct: signed, skala yg sama dengan relative_effect_pct
  - ci_half_pct: CI half-width dalam skala yang sama

Inject ke dashboard-data.json sebagai shap_v2.
"""
import json, csv, math
from pathlib import Path

ROOT   = Path(__file__).parent.parent
SHAP   = ROOT / 'RA-STGNN' / 'outputs' / 'shap'
DEST   = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

TARGET_MAP = {
    'modelA_resp':                    'resp',
    'modelA_resp_admissions_under5':  'resp_admissions_under5',
    'modelA_resp_admissions_over60':  'resp_admissions_over60',
    'modelA_asthma_emergency_cases':  'asthma_emergency_cases',
    'modelA_copd_admissions':         'copd_admissions',
    'modelA_cvd':                     'cvd',
    'modelB_death':                   'death',
}

FEAT_LABEL = {
    'pm25':              'PM2.5',
    'pm10':              'PM10',
    'so2':               'SO₂',
    'co':                'CO',
    'o3':                'O₃',
    'no2':               'NO₂',
    'wind_speed_ms':     'Kec. Angin',
    'wind_direction_deg':'Arah Angin',
    'temperature_c':     'Suhu',
    'humidity_pct':      'Kelembapan',
}

result = {}

for folder, target_key in TARGET_MAP.items():
    csv_path = SHAP / folder / 'shap_summary.csv'
    if not csv_path.exists():
        print(f'  SKIP {folder}: tidak ada shap_summary.csv')
        continue

    rows = list(csv.DictReader(open(csv_path, encoding='utf-8')))
    lag1 = [r for r in rows if r['lag_day'] == '-1']

    if not lag1:
        print(f'  SKIP {folder}: tidak ada lag=-1')
        continue

    # Normalisasi: max(mean_abs_shap) di lag-1 = 100%
    max_abs = max(float(r['mean_abs_shap']) for r in lag1)
    if max_abs == 0:
        continue

    features = []
    for r in lag1:
        mean_s   = float(r['mean_shap'])
        abs_s    = float(r['mean_abs_shap'])
        signed_pct  = (mean_s / max_abs) * 100          # signed, bisa negatif
        abs_pct     = (abs_s  / max_abs) * 100           # magnitude
        # CI half-width: selisih abs dan |mean| = variasi/uncertainty
        ci_half_pct = abs_pct - abs(signed_pct)
        ci_half_pct = max(ci_half_pct, abs_pct * 0.08)  # minimal 8% dari bar

        features.append({
            'feature':      r['feature'],
            'label':        FEAT_LABEL.get(r['feature'], r['feature']),
            'signed_pct':   round(signed_pct, 1),
            'abs_pct':      round(abs_pct, 1),
            'ci_half_pct':  round(ci_half_pct, 1),
        })

    # Urut berdasarkan abs_pct descending
    features.sort(key=lambda x: -x['abs_pct'])
    result[target_key] = features
    print(f'  {target_key}: {len(features)} fitur lag=-1')

print(f'\nMemuat {DEST} ...')
with open(DEST, encoding='utf-8') as f:
    data = json.load(f)

data['shap_v2'] = result

with open(DEST, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

print(f'✅ shap_v2 ({len(result)} target) disimpan ke {DEST}')
