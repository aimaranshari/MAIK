"""
patch_aqi_daily.py
Hitung AQI harian per lokasi dari data per jam + hitung jumlah jam berflag valid per hari.
Hasil: sparklines_per_loc[lokasi]['aqi' | 'qc_valid_n' | 'qc_n'] sejajar dengan sparklines_full_dates.
"""
import json
import numpy as np
import pandas as pd
from pathlib import Path

ROOT = Path(__file__).parent.parent
SRC  = ROOT / 'Dataset Fix' / 'combined_imputed_smoke.csv'
DEST = ROOT / 'Dashboard' / 'data' / 'dashboard-data.json'

PPM_LOCS = {'LOC-PSW-01', 'LOC-BJB-01', 'LOC-MDN-01'}      # PM-nya ppm: AQI dari gas saja
VALID_VALUES = {'valid', 'v', '1', 'ok', 'good', 'pass'}   # SESUAIKAN dengan qc_flag Anda
ONLY_VALID_FOR_AQI = False   # True: AQI hanya dari jam berflag valid
MIN_HOURS_24H = 18           # syarat minimal jam untuk rata-rata 24 jam (75%)
MIN_HOURS_8H  = 6            # syarat minimal jam untuk rata-rata 8 jam (75%)

# Breakpoint EPA: [Clo, Chi, Ilo, Ihi]
BP = {
    'pm25': [(0.0,9.0,0,50),(9.1,35.4,51,100),(35.5,55.4,101,150),(55.5,125.4,151,200),(125.5,225.4,201,300),(225.5,325.4,301,500)],
    'pm10': [(0,54,0,50),(55,154,51,100),(155,254,101,150),(255,354,151,200),(355,424,201,300),(425,504,301,400),(505,604,401,500)],
    'so2':  [(0,35,0,50),(36,75,51,100),(76,185,101,150),(186,304,151,200),(305,604,201,300),(605,804,301,400),(805,1004,401,500)],
    'no2':  [(0,53,0,50),(54,100,51,100),(101,360,101,150),(361,649,151,200),(650,1249,201,300),(1250,1649,301,400),(1650,2049,401,500)],
    'o3':   [(0,54,0,50),(55,70,51,100),(71,85,101,150),(86,105,151,200),(106,200,201,300)],
    'co':   [(0.0,4.4,0,50),(4.5,9.4,51,100),(9.5,12.4,101,150),(12.5,15.4,151,200),(15.5,30.4,201,300),(30.5,40.4,301,400),(40.5,50.4,401,500)],
}
DECIMALS = {'pm25': 1, 'pm10': 0, 'so2': 0, 'no2': 0, 'o3': 0, 'co': 1}
MW = {'so2': 64.07, 'no2': 46.01, 'o3': 48.00, 'co': 28.01}   # g/mol; 25 C, 1 atm = 24.45 L/mol

def to_epa_unit(pol, ug):
    if pol in ('pm25', 'pm10'): return ug                     # tetap µg/m³
    v = ug * 24.45 / MW[pol]                                  # ppb
    return v / 1000 if pol == 'co' else v                     # CO dalam ppm

def sub_index(pol, c):
    if c is None or np.isnan(c) or c < 0: return np.nan
    k = 10 ** DECIMALS[pol]
    c = np.floor(c * k) / k
    bps = BP[pol]
    if c > bps[-1][1]: return bps[-1][3]
    for lo, hi, ilo, ihi in bps:
        if lo <= c <= hi:
            return round((ihi - ilo) / (hi - lo) * (c - lo) + ilo)
    return np.nan

print(f"Membaca {SRC} ...")
df = pd.read_csv(SRC, usecols=['ts_hour', 'location_id', 'qc_flag', 'pm25', 'pm10', 'so2', 'co', 'o3', 'no2'])
df['ts'] = pd.to_datetime(df['ts_hour'])
df['qc'] = df['qc_flag'].astype(str).str.strip().str.lower()
df['has_qc'] = ~df['qc'].isin(['', 'nan', 'none'])
df['is_valid'] = df['qc'].isin(VALID_VALUES)
print("Nilai unik qc_flag:", sorted(df['qc'].unique()))

with open(DEST, encoding='utf-8') as f:
    data = json.load(f)
all_dates = data['sparklines_full_dates']
idx = pd.Index(all_dates)
spl = data['sparklines_per_loc']

def to_list(series):
    s = series.reindex(idx)
    return [None if pd.isna(v) else round(float(v), 3) for v in s]

for loc, g in df.groupby('location_id'):
    g = g.sort_values('ts').set_index('ts')
    day = g.index.strftime('%Y-%m-%d')

    # Jumlah jam: berflag & valid per hari
    qc_n = g['has_qc'].groupby(day).sum()
    qc_valid_n = (g['is_valid'] & g['has_qc']).groupby(day).sum()

    # Nilai yang dipakai untuk AQI
    src = g.copy()
    if ONLY_VALID_FOR_AQI:
        for p in BP: src.loc[~src['is_valid'], p] = np.nan

    sub = {}
    for p in BP:
        if p in ('pm25', 'pm10') and loc in PPM_LOCS:
            continue
        vals = src[p].astype(float)
        if p in ('pm25', 'pm10'):
            # rata-rata 24 jam per hari
            grp = vals.groupby(day)
            daily = grp.mean().where(grp.count() >= MIN_HOURS_24H)
        elif p in ('so2', 'no2'):
            daily = vals.map(lambda x: to_epa_unit(p, x)).groupby(day).max()   # maks 1 jam
        else:  # o3, co: maksimum rata-rata bergulir 8 jam
            conv = vals.map(lambda x: to_epa_unit(p, x))
            roll = conv.rolling('8h', min_periods=MIN_HOURS_8H).mean()
            daily = roll.groupby(day).max()
        sub[p] = daily.map(lambda c, p=p: sub_index(p, c))

    aqi = pd.DataFrame(sub).max(axis=1) if sub else pd.Series(dtype=float)

    entry = spl.setdefault(loc, {})
    entry['aqi']        = to_list(aqi)
    entry['qc_n']       = to_list(qc_n)
    entry['qc_valid_n'] = to_list(qc_valid_n)
    n = sum(v is not None for v in entry['aqi'])
    print(f"  {loc}: AQI harian tersedia {n}/{len(all_dates)} hari")

with open(DEST, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
print("Selesai.")