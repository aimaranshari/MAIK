/**
 * script.js — Dashboard Karhutla Indonesia
 * Leaflet.js peta provinsi (GeoJSON real dari LapakGIS) + inferensi model PyTorch.
 * Vanilla JS + Chart.js. Tidak ada framework.
 */
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// STATE GLOBAL
// ═══════════════════════════════════════════════════════════════════════════
const STATE = {
  data: null,
  filteredLocs: [],
  region: 'ALL',
  kabupaten: 'ALL',          // legacy single; keep for compatibility
  selectedKabupaten: [],     // [] = semua; array of kota strings for multiselect
  // periodDays: 0 = Besok (tampilkan forecast model), 1 = Hari Ini, >1 = N hari terakhir
  // periodDays: -1 = custom date range (use dateStart / dateEnd)
  periodDays: 99999,
  dateStart: null,           // Date object for custom range start (inclusive)
  dateEnd: null,             // Date object for custom range end (inclusive)
  // cutoffDate: null means "all", otherwise Date object = oldest date to include
  cutoffDate: null,
  cutoffEndDate: null,       // null means no upper cutoff; Date object = newest to include
  // showForecast: true when periodDays === 0 (Besok)
  showForecast: false,
  aqiScale: 'EPA',   // selalu EPA (standar internasional)
  mapMode: 'combined',
  forestTarget: 'resp',
  tableSort: { col: 'aqi', dir: 'desc' },
  tableSearch: '',
  activePols: new Set(['pm25','pm10','so2','co','o3','no2']),
  charts: {},
  leafletMap: null,
  leafletMarkers: [],
  leafletProvinces: null,
  modalLocId: null,
};

const POLLUTANTS = [
  { key: 'pm25', label: 'PM₂.₅', unit: 'µg/m³', color: '#ef4444' },
  { key: 'pm10', label: 'PM₁₀',  unit: 'µg/m³', color: '#f97316' },
  { key: 'so2',  label: 'SO₂',   unit: 'µg/m³', color: '#eab308' },
  { key: 'co',   label: 'CO',    unit: 'µg/m³', color: '#8b5cf6' },
  { key: 'o3',   label: 'O₃',    unit: 'µg/m³', color: '#06b6d4' },
  { key: 'no2',  label: 'NO₂',   unit: 'µg/m³', color: '#10b981' },
];

const HEALTH_TARGETS_LABEL = {
  resp:                       'Infeksi Saluran Napas',
  resp_admissions_under5:     'Rawat Napas Balita <5 th',
  resp_admissions_over60:     'Rawat Napas Lansia >60 th',
  asthma_emergency_cases:     'Darurat Asma',
  copd_admissions:            'Rawat PPOK',
  cvd:                        'Kardiovaskular',
  death:                      'Kematian',
};

const AQI_EPA = [
  { lo:0,   hi:50,  label:'Good',                          color:'#00E400', textColor:'#166534' },
  { lo:51,  hi:100, label:'Moderate',                      color:'#FFFF00', textColor:'#854d0e' },
  { lo:101, hi:150, label:'Unhealthy for Sensitive Groups', color:'#FF7E00', textColor:'#fff'    },
  { lo:151, hi:200, label:'Unhealthy',                      color:'#FF0000', textColor:'#fff'    },
  { lo:201, hi:300, label:'Very Unhealthy',                 color:'#8F3F97', textColor:'#fff'    },
  { lo:301, hi:9999,label:'Hazardous',                      color:'#7E0023', textColor:'#fff'    },
];
const AQI_ISPU = [
  { lo:0,   hi:50,  label:'Baik',              color:'#00E400', textColor:'#166534' },
  { lo:51,  hi:100, label:'Sedang',             color:'#FFFF00', textColor:'#854d0e' },
  { lo:101, hi:199, label:'Tidak Sehat',        color:'#FF7E00', textColor:'#fff'    },
  { lo:200, hi:299, label:'Sangat Tidak Sehat', color:'#FF0000', textColor:'#fff'    },
  { lo:300, hi:9999,label:'Berbahaya',          color:'#7E0023', textColor:'#fff'    },
];

function getCategory(aqi, scale) {
  const cats = scale === 'ISPU' ? AQI_ISPU : AQI_EPA;
  if (aqi == null) return { label:'N/A', color:'#9ca3af', textColor:'#fff' };
  return cats.find(c => aqi >= c.lo && aqi <= c.hi) || cats[cats.length-1];
}

// ═══ Helper satuan ppm ═══════════════════════════════════════════════════
const PPM_POLS = ['pm25', 'pm10'];

function ppmLocSet() {
  return new Set(STATE.data?.ppm_locations || ['LOC-PSW-01','LOC-BJB-01','LOC-MDN-01']);
}
function isPpmCombo(lid, polKey) {
  return PPM_POLS.includes(polKey) && ppmLocSet().has(lid);
}

/** Pilih lokasi untuk satu polutan: utamakan µg/m³; ppm dipakai hanya jika semua lokasi terpilih ppm. */
function resolveUnitLocs(polKey) {
  const ids = STATE.filteredLocs;
  const ug  = ids.filter(id => !isPpmCombo(id, polKey));
  if (ug.length) return { ids: ug, unit: 'µg/m³', excluded: ids.length - ug.length };
  return { ids, unit: 'ppm', excluded: 0 };
}

function latestPerLoc(lid, key) {
  const arr = STATE.data?.sparklines_per_loc?.[lid]?.[key] || [];
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function hexToRgba(hex, a) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  renderLoadingSpinner();
  try {
    const res = await fetch('data/dashboard-data.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    STATE.data = await res.json();
    rebuildMain();
    initFilters();
    applyFilters();
    bindEvents();
  } catch (err) {
    document.querySelector('main').innerHTML =
      `<div class="card text-center py-16 text-red-500 font-semibold text-sm">
        ❌ Gagal memuat data: ${err.message}<br>
        <span class="text-gray-400 font-normal mt-2 block text-xs">
          Jalankan dari folder <code>KARHUTLA/</code>:<br>
          <code>python -m http.server 8000</code><br>
          Buka: <a href="http://localhost:8000/dashboard/" class="underline">http://localhost:8000/dashboard/</a>
        </span>
      </div>`;
  }
});

function renderLoadingSpinner() {
  document.querySelector('main').innerHTML =
    `<div class="spinner"></div>
     <p class="text-center text-sm text-gray-400 mt-2">Memuat data dashboard…</p>`;
}

function rebuildMain() {
  // main sudah ada dari index.html — pastikan spinner hilang
  // dengan mengganti main kembali ke konten asli dari DOM (tidak di-replace)
  // Tapi karena kita replace innerHTML saat spinner, perlu restore:
  // Karena index.html sudah ada kontennya, kita perlu reload konten dari HTML string.
  // Solusi: gunakan fetch index.html dan extract main innerHTML.
  // Lebih simpel: render semua komponen via JS, biarkan placeholder tetap.
  // Spinner hanya mengganti main — kita restore dengan innerHTML dari template.
  const tpl = getMainTemplate();
  document.querySelector('main').innerHTML = tpl;
}

function getMainTemplate() {
  return `
  <!-- ROW 1: AQI + Tren Polutan -->
  <section id="sec-aqi" class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <!-- AQI Card kiri -->
    <div class="lg:col-span-1 card aqi-main-card flex flex-col">
      <div class="font-black text-gray-800 dark:text-gray-100 uppercase leading-none mb-1" style="font-size:2rem;letter-spacing:.04em">
        <div>Air</div>
        <div>Quality</div>
        <div>Index</div>
      </div>
      <div id="aqi-date-label" class="text-xs text-gray-400 mb-2"></div>
      <!-- Angka AQI besar mengisi ruang tersisa -->
      <div class="flex items-center gap-4 flex-1">
        <div id="aqi-value-big" class="aqi-big-num" style="font-size:5rem;line-height:1">--</div>
        <div class="flex flex-col gap-1">
          <div id="aqi-cat-badge" class="aqi-badge text-sm font-bold px-3 py-1 rounded-full self-start">--</div>
          <div id="aqi-main-pol" class="text-xs text-gray-500 dark:text-gray-400"></div>
        </div>
      </div>
      <div id="weather-grid" class="weather-grid mt-auto pt-2">
        <div class="weather-chip">
          <span class="weather-chip-label">Temperatur</span>
          <span class="weather-chip-value"><span id="nat-temp">--</span> °C</span>
        </div>
        <div class="weather-chip">
          <span class="weather-chip-label">Kelembapan</span>
          <span class="weather-chip-value"><span id="nat-hum">--</span> %</span>
        </div>
        <div class="weather-chip">
          <span class="weather-chip-label">Angin</span>
          <span class="weather-chip-value"><span id="nat-wind">--</span> m/s</span>
        </div>
        <div class="weather-chip">
          <span class="weather-chip-label">Stasiun</span>
          <span class="weather-chip-value"><span id="aqi-loc-count">--</span></span>
        </div>
      </div>
    </div>

    <!-- Kanan — Tren Polutan (judul dihapus) -->
    <div class="lg:col-span-2 card flex flex-col">
      <!-- Chips kiri + grafik kanan -->
      <div class="flex gap-3 flex-1" style="min-height:180px;">
        <!-- Kolom chips rata-rata: klik untuk toggle garis -->
        <div id="pol-avg-summary" class="flex flex-col gap-1 justify-around" style="min-width:120px;max-width:140px;flex-shrink:0"></div>
        <!-- Grafik -->
        <div class="chart-fixed-h flex-1">
          <canvas id="chart-pollutant-trend"></canvas>
        </div>
      </div>
    </div>
  </section>

  <!-- ROW 2: Peta + SHAP Feature Importance -->
  <section id="sec-map-forest" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <div class="card overflow-hidden" style="min-height:500px">
      <div id="leaflet-map" style="height:420px;border-radius:0.75rem;overflow:hidden;position:relative;z-index:0"></div>
      <div id="map-legend" class="mt-2 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400"></div>
    </div>
    <div class="card flex flex-col" style="min-height:500px">
      <div class="mb-3" id="outcome-btns">
        <button class="outcome-btn active" data-target="resp">Infeksi Napas</button>
        <button class="outcome-btn" data-target="resp_admissions_under5">Balita &lt;5</button>
        <button class="outcome-btn" data-target="resp_admissions_over60">Lansia &gt;60</button>
        <button class="outcome-btn" data-target="asthma_emergency_cases">Asma</button>
        <button class="outcome-btn" data-target="copd_admissions">PPOK</button>
        <button class="outcome-btn" data-target="cvd">CVD</button>
        <button class="outcome-btn" data-target="death">Kematian</button>
      </div>
      <div id="outcome-mean-badge" class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300"></div>
      <div id="forest-plot" class="flex-1" style="display:flex;flex-direction:column;min-height:0"></div>
    </div>
  </section>

  <section id="sec-forecast" class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div class="card flex flex-col">
      <h2 class="card-title mb-3">Prediksi Kasus Penyakit Pernapasan</h2>
      <div id="forecast-btns" class="mb-3"></div>
      <div class="chart-fixed-h flex-1" style="min-height:160px;">
        <canvas id="chart-rastgnn-forecast"></canvas>
      </div>
    </div>
    <div class="card flex flex-col">
      <h2 class="card-title mb-3">Peramalan Polutan</h2>
      <div id="pol-forecast-btns" class="mb-3"></div>
      <div class="chart-fixed-h flex-1" style="min-height:160px;">
        <canvas id="chart-miagnn-forecast"></canvas>
      </div>
    </div>
  </section>

  <section id="sec-table">
    <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
      <h2 class="section-title">📋 Semua Lokasi</h2>
      <input id="table-search" type="text" placeholder="Cari lokasi…" class="search-input"/>
    </div>
    <div class="card overflow-x-auto p-0">
      <table class="data-table w-full text-sm">
        <thead>
          <tr>
            <th class="sortable" data-col="kota">Kota / Wilayah</th>
            <th class="sortable" data-col="aqi">AQI</th>
            <th class="sortable" data-col="pm25_latest">PM₂.₅</th>
            <th>Tipe Stasiun</th>
            <th>Status</th>
            <th class="sortable" data-col="valid_pct">% Valid</th>
            <th>Pred. Kematian h+1</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody id="location-table-body"></tbody>
      </table>
    </div>
  </section>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════════════════
function initTheme() {
  const saved = localStorage.getItem('karhutla-theme') || 'light';
  document.documentElement.classList.toggle('dark', saved === 'dark');
  updateThemeIcon(saved);
}
function updateThemeIcon(t) {
  const el = document.getElementById('theme-icon');
  if (el) el.textContent = t === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  const t = isDark ? 'dark' : 'light';
  localStorage.setItem('karhutla-theme', t);
  updateThemeIcon(t);
  Object.values(STATE.charts).forEach(c => c?.update?.());
  if (STATE.leafletMap) {
    // Update Leaflet tile layer untuk dark mode (opsional, pakai same tiles)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BIND EVENTS
// ═══════════════════════════════════════════════════════════════════════════
function bindEvents() {
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  // ── Wilayah: custom checkbox dropdown ─────────────────────────────────────
  const dropBtn   = document.getElementById('wilayah-dropdown-btn');
  const dropPanel = document.getElementById('wilayah-dropdown-panel');

  dropBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const open = dropPanel.classList.toggle('hidden');
    dropBtn.setAttribute('aria-expanded', String(!open));
  });

  // Tutup panel saat klik di luar
  document.addEventListener('click', e => {
    const wrap = document.getElementById('wilayah-filter-wrap');
    if (wrap && !wrap.contains(e.target)) {
      dropPanel?.classList.add('hidden');
      dropBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  document.getElementById('wilayah-select-all')?.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('#wilayah-checkbox-list input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
    });
    _syncWilayahState();
  });

  document.getElementById('wilayah-clear-all')?.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('#wilayah-checkbox-list input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
    });
    _syncWilayahState();
  });

  // Delegate: checkbox item click
  document.getElementById('wilayah-checkbox-list')?.addEventListener('change', () => {
    _syncWilayahState();
  });

  // ── Interval waktu: date start / end ──────────────────────────────────────
  document.getElementById('filter-date-start')?.addEventListener('change', e => {
    STATE.dateStart  = e.target.value ? new Date(e.target.value + 'T00:00:00') : null;
    STATE.periodDays = (STATE.dateStart || STATE.dateEnd) ? -1 : 99999;
    computeCutoffDate();
    applyFilters();
  });

  document.getElementById('filter-date-end')?.addEventListener('change', e => {
    STATE.dateEnd    = e.target.value ? new Date(e.target.value + 'T23:59:59') : null;
    STATE.periodDays = (STATE.dateStart || STATE.dateEnd) ? -1 : 99999;
    computeCutoffDate();
    applyFilters();
  });


  document.querySelectorAll('.outcome-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.outcome-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.forestTarget = btn.dataset.target;
      renderForestPlot();
    })
  );

  document.getElementById('table-search')?.addEventListener('input', e => {
    STATE.tableSearch = e.target.value.toLowerCase();
    renderLocationTable();
  });

  document.querySelectorAll('.data-table th.sortable').forEach(th =>
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      STATE.tableSort.dir = STATE.tableSort.col === col
        ? (STATE.tableSort.dir === 'asc' ? 'desc' : 'asc') : 'desc';
      STATE.tableSort.col = col;
      renderLocationTable();
    })
  );

  document.querySelectorAll('.modal-overlay').forEach(o =>
    o.addEventListener('click', e => { if (e.target === o) o.classList.add('hidden'); })
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      document.querySelectorAll('.modal-overlay').forEach(o => o.classList.add('hidden'));
  });

  // Pol avg rows — toggle polutan di grafik (delegate karena dirender ulang)
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-pol]');
    if (!chip) return;
    const key = chip.dataset.pol;
    if (STATE.activePols.has(key)) STATE.activePols.delete(key);
    else STATE.activePols.add(key);
    renderPollutantTrend();
  });

  // Chip tren penyakit di modal lokasi — toggle garis
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-health]');
    if (!chip) return;
    const key = chip.dataset.health;
    if (ACTIVE_HEALTH.has(key)) ACTIVE_HEALTH.delete(key);
    else ACTIVE_HEALTH.add(key);
    if (ACTIVE_HEALTH.size === 0) ACTIVE_HEALTH.add(key);   // minimal satu garis aktif
    renderLocHealthTrend();
  });

  // Kotak prediksi: pilih penyakit untuk bar chart
  document.addEventListener('click', e => {
    const box = e.target.closest('[data-fc]');
    if (!box) return;
    forecastTarget = box.dataset.fc;
    renderRaStgnnForecastChart();
  });

  // MiAGNN pol selector (lokasi ikut global filter)
  // Kotak peramalan polutan: pilih polutan untuk bar chart
  document.addEventListener('click', e => {
    const box = e.target.closest('[data-pfc]');
    if (!box) return;
    polForecastTarget = box.dataset.pfc;
    renderMiagnnForecastChart();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTER INIT
// ═══════════════════════════════════════════════════════════════════════════
function initFilters() {
  // ── Wilayah: bangun daftar checkbox dari lokasi dataset ─────────────────
  const checkboxList = document.getElementById('wilayah-checkbox-list');
  if (checkboxList && STATE.data) {
    const kabList = [...new Set(STATE.data.locations.map(d => d.kota).filter(Boolean))].sort();
    kabList.forEach(k => {
      const item = document.createElement('label');
      item.className = 'wilayah-checkbox-item';
      item.innerHTML = `<input type="checkbox" value="${k}"><span>${k}</span>`;
      checkboxList.appendChild(item);
    });
  }

  // ── Date inputs: set min/max + default ke full range dataset ──────────
  const D = STATE.data;
  if (D?.meta) {
    const { start, end } = D.meta.data_date_range;
    const dsEl = document.getElementById('filter-date-start');
    const deEl = document.getElementById('filter-date-end');
    if (dsEl) { dsEl.min = start; dsEl.max = end; dsEl.value = start; }
    if (deEl) { deEl.min = start; deEl.max = end; deEl.value = end;   }
    // Set STATE ke full range secara default
    STATE.dateStart  = new Date(start + 'T00:00:00');
    STATE.dateEnd    = new Date(end   + 'T23:59:59');
    STATE.periodDays = -1;
  }

  const info = document.getElementById('data-date-info');
  if (info && STATE.data?.meta) {
    const { start, end } = STATE.data.meta.data_date_range;
    info.textContent = `${start} → ${end}`;
  }

  // ── MiAGNN: hanya selector polutan ──────────────────────────────────────
  const fPolSel = document.getElementById('forecast-pol-sel');
  if (fPolSel) {
    POLLUTANTS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.key; opt.textContent = p.label; fPolSel.appendChild(opt);
    });
  }
}

/**
 * Baca status semua checkbox wilayah → update STATE → update label → applyFilters.
 * Dipanggil setiap kali ada perubahan checkbox.
 */
function _syncWilayahState() {
  const checked = Array.from(
    document.querySelectorAll('#wilayah-checkbox-list input[type="checkbox"]:checked')
  ).map(cb => cb.value);
  STATE.selectedKabupaten = checked;
  STATE.kabupaten = checked.length === 0 ? 'ALL' : checked[0];
  _updateWilayahLabel();
  applyFilters();
}

/** Perbarui teks tombol dropdown wilayah sesuai pilihan saat ini. */
function _updateWilayahLabel() {
  const lbl = document.getElementById('wilayah-dropdown-label');
  if (!lbl) return;
  const n = STATE.selectedKabupaten.length;
  if (n === 0)      lbl.textContent = 'Semua Wilayah';
  else if (n === 1) lbl.textContent = STATE.selectedKabupaten[0];
  else              lbl.textContent = `${n} Wilayah Dipilih`;
}

// ═══════════════════════════════════════════════════════════════════════════
// DATE CUTOFF HELPER
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Compute STATE.cutoffDate and STATE.showForecast from STATE.periodDays.
 * Uses the dataset's latest date as "today" (not wall-clock), so the filter
 * always makes sense regardless of when the dashboard is viewed.
 *
 * periodDays = 0  → Besok: showForecast=true, show only the latest day's data
 * periodDays = 1  → Hari Ini: show only the latest day
 * periodDays = N  → show last N days ending at the latest date in dataset
 * periodDays = 99999 → show all data
 */
function computeCutoffDate() {
  const D = STATE.data;
  if (!D) return;

  const latestStr = D.meta.data_date_range.end;          // e.g. "2026-10-14"
  const latestDate = new Date(latestStr + 'T00:00:00');  // dataset "today"

  // Custom date range mode
  if (STATE.periodDays === -1) {
    STATE.showForecast = false;
    STATE.cutoffDate    = STATE.dateStart || null;
    STATE.cutoffEndDate = STATE.dateEnd   || null;
    return;
  }

  STATE.cutoffEndDate = null;  // no upper cutoff for quick periods

  if (STATE.periodDays === 0) {
    // Besok: show only latest day + highlight forecast
    STATE.showForecast = true;
    STATE.cutoffDate = latestDate;  // show only the latest day's data
  } else if (STATE.periodDays === 99999) {
    STATE.showForecast = false;
    STATE.cutoffDate = null;        // no cutoff → all data
  } else {
    STATE.showForecast = false;
    // Cutoff = latestDate minus (periodDays - 1) days → shows exactly N days
    const cutoff = new Date(latestDate);
    cutoff.setDate(cutoff.getDate() - (STATE.periodDays - 1));
    STATE.cutoffDate = cutoff;
  }
}

/** Filter an array of {date, ...} objects by STATE.cutoffDate and STATE.cutoffEndDate. */
function filterByDate(arr, dateKey = 'date') {
  return arr.filter(row => {
    const d = new Date(row[dateKey] + 'T00:00:00');
    if (STATE.cutoffDate    && d < STATE.cutoffDate)    return false;
    if (STATE.cutoffEndDate && d > STATE.cutoffEndDate) return false;
    return true;
  });
}

/** Slice sparkline arrays (parallel date + value arrays) by cutoff dates.
 *  Clamps to available window — never returns empty due to out-of-range dates. */
function sliceSparkline(dates, values) {
  if (!dates?.length) return { dates: dates ?? [], values: values ?? [] };
  let startIdx = 0, endIdx = dates.length;

  if (STATE.cutoffDate) {
    const ts = STATE.cutoffDate.getTime();
    const i = dates.findIndex(d => new Date(d + 'T00:00:00').getTime() >= ts);
    // If cutoffDate is after all available dates → clamp to last available day
    startIdx = i === -1 ? dates.length - 1 : i;
  }

  if (STATE.cutoffEndDate) {
    const ts = STATE.cutoffEndDate.getTime();
    const i = dates.findIndex(d => new Date(d + 'T00:00:00').getTime() > ts);
    if (i !== -1) endIdx = i;
    // If cutoffEndDate is before all available dates → show at least the first day
    if (endIdx <= startIdx) endIdx = startIdx + 1;
  }

  return { dates: dates.slice(startIdx, endIdx), values: values.slice(startIdx, endIdx) };
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLY FILTERS → rebuild semua komponen
// ═══════════════════════════════════════════════════════════════════════════
function applyFilters() {
  if (!STATE.data) return;
  computeCutoffDate();   // ensure cutoff is fresh on every apply
  STATE.filteredLocs = STATE.data.locations
    .filter(l => STATE.selectedKabupaten.length === 0 || STATE.selectedKabupaten.includes(l.kota))
    .map(l => l.location_id);

  renderAQIPanel();
  renderPollutantTrend();
  renderMap();
  renderForestPlot();
  renderLocationTable();
  renderRaStgnnForecastChart();
  renderMiagnnForecastChart();
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL AGGREGATION HELPER — Dua-tingkat: (1) avg per-wilayah dalam rentang
// tanggal yang aktif, lalu (2) avg dari semua wilayah terfilter.
// Mengembalikan satu angka atau null.
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Hitung rata-rata dua tingkat untuk satu metrik numerik dari health_trends.
 *   Langkah 1: untuk setiap lokasi terfilter, hitung mean nilai dalam rentang tanggal.
 *   Langkah 2: rata-ratakan semua mean per-lokasi.
 * @param {string} metricKey — kunci di health_trends[locId][metricKey]
 * @returns {number|null}
 */
function computeTwoLevelMean(metricKey) {
  const D = STATE.data; if (!D) return null;
  const locIds = STATE.filteredLocs;
  const perLocMeans = [];
  locIds.forEach(lid => {
    const tr = D.health_trends?.[lid];
    if (!tr?.dates?.length) return;
    const { values } = sliceSparkline(tr.dates, tr[metricKey] || []);
    const valid = values.filter(v => v != null);
    if (valid.length) perLocMeans.push(valid.reduce((a,b)=>a+b,0)/valid.length);
  });
  if (!perLocMeans.length) return null;
  return perLocMeans.reduce((a,b)=>a+b,0) / perLocMeans.length;
}

/**
 * Hitung rata-rata dua tingkat untuk satu polutan dari sparklines per-lokasi
 * atau sparklines_national (jika semua lokasi dipilih).
 * @param {string} polKey — 'pm25'|'pm10'|'so2'|'co'|'o3'|'no2'
 * @returns {number|null}
 */
function computePolMeanInfo(polKey) {
  const D = STATE.data;
  if (!D) return { value: null, unit: 'µg/m³', excluded: 0 };
  const fullDates = D.sparklines_full_dates || (D.sparklines_national_full ?? D.sparklines_national).dates || [];
  const meanOf = arr => {
    const v = arr.filter(x => x != null);
    return v.length ? v.reduce((a,b) => a+b, 0) / v.length : null;
  };

  // Semua wilayah: sparklines_national_full (sudah tanpa lokasi ppm)
  if (STATE.selectedKabupaten.length === 0) {
    const natSpark = (D.sparklines_national_full ?? D.sparklines_national);
    const { values } = sliceSparkline(fullDates, natSpark[polKey] || []);
    const excluded = PPM_POLS.includes(polKey) ? ppmLocSet().size : 0;
    return { value: meanOf(values), unit: 'µg/m³', excluded };
  }

  const { ids, unit, excluded } = resolveUnitLocs(polKey);
  const perLoc = ids.map(lid => {
    const sp = D.sparklines_per_loc?.[lid];
    return sp ? meanOf(sliceSparkline(fullDates, sp[polKey] || []).values) : null;
  }).filter(v => v != null);
  return { value: meanOf(perLoc), unit, excluded };
}

function computePolMean(polKey) { return computePolMeanInfo(polKey).value; }

/** AQI rata-rata harian + proporsi data valid (QC) per lokasi pada periode aktif. */
function locPeriodStats(lid) {
  const D = STATE.data;
  const sp = D?.sparklines_per_loc?.[lid];
  const fullDates = D?.sparklines_full_dates || [];
  if (!sp?.aqi || !fullDates.length) return null;
  const sl  = a => sliceSparkline(fullDates, a || []).values;
  const sum = a => a.reduce((x, y) => x + (y || 0), 0);
  const aq  = sl(sp.aqi).filter(v => v != null);
  const totalN = sum(sl(sp.qc_n));
  return {
    aqi:   aq.length ? sum(aq) / aq.length : null,
    days:  aq.length,
    qcPct: totalN > 0 ? sum(sl(sp.qc_valid_n)) / totalN * 100 : null,
  };
}

function computeMeteoMean(metKey) {
  const D = STATE.data;
  if (!D?.sparklines_per_loc) return null;
  const fullDates = D.sparklines_full_dates || [];
  const meanOf = arr => {
    const v = arr.filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const perLoc = STATE.filteredLocs.map(lid => {
    const series = D.sparklines_per_loc[lid]?.[metKey];
    return series ? meanOf(sliceSparkline(fullDates, series).values) : null;
  }).filter(v => v != null);
  return meanOf(perLoc);
}

// ═══ AQI dari gas saja (untuk lokasi yang PM-nya dalam ppm) ═══════════════
// Breakpoint EPA: SO2/NO2/O3 dalam ppb, CO dalam ppm. Format: [Clo, Chi, Ilo, Ihi]
const AQI_GAS_BP = {
  so2: { mw: 64.07, div: 1,    trunc: 0, bp: [[0,35,0,50],[36,75,51,100],[76,185,101,150],[186,304,151,200],[305,604,201,300],[605,804,301,400],[805,1004,401,500]] },
  no2: { mw: 46.01, div: 1,    trunc: 0, bp: [[0,53,0,50],[54,100,51,100],[101,360,101,150],[361,649,151,200],[650,1249,201,300],[1250,1649,301,400],[1650,2049,401,500]] },
  o3:  { mw: 48.00, div: 1,    trunc: 0, bp: [[0,54,0,50],[55,70,51,100],[71,85,101,150],[86,105,151,200],[106,200,201,300]] },
  co:  { mw: 28.01, div: 1000, trunc: 1, bp: [[0,4.4,0,50],[4.5,9.4,51,100],[9.5,12.4,101,150],[12.5,15.4,151,200],[15.5,30.4,201,300],[30.5,40.4,301,400],[40.5,50.4,401,500]] },
};
const AQI_GAS_LABEL = { so2: 'SO2', no2: 'NO2', o3: 'O3', co: 'CO' };

/** Sub-indeks satu gas dari konsentrasi µg/m³ (25 °C, 1 atm: 24.45 L/mol). */
function gasSubIndex(pol, ugm3) {
  const cfg = AQI_GAS_BP[pol];
  if (!cfg || ugm3 == null || ugm3 < 0) return null;
  let c = ugm3 * 24.45 / cfg.mw / cfg.div;
  const k = Math.pow(10, cfg.trunc);
  c = Math.floor(c * k) / k;                       // EPA: potong, bukan bulatkan
  const last = cfg.bp[cfg.bp.length - 1];
  if (c > last[1]) return last[3];
  const b = cfg.bp.find(x => c >= x[0] && c <= x[1]);
  return b ? Math.round((b[3] - b[2]) / (b[1] - b[0]) * (c - b[0]) + b[2]) : null;
}

/**
 * AQI lokasi dari 4 gas, mengikuti rentang tanggal aktif.
 * AQI harian = sub-indeks tertinggi; hasil = rata-rata AQI harian.
 * Dominan = gas dengan rata-rata sub-indeks tertinggi.
 */
function computeGasAqi(lid) {
  const D = STATE.data;
  const sp = D?.sparklines_per_loc?.[lid];
  const fullDates = D?.sparklines_full_dates || [];
  if (!sp || !fullDates.length) return { aqi: null, dominant: null, days: 0 };

  const { dates: sd } = sliceSparkline(fullDates, fullDates);
  const start = fullDates.indexOf(sd[0]);
  if (start < 0) return { aqi: null, dominant: null, days: 0 };

  const dailyAqi = [];
  const sums = {}, cnts = {};
  Object.keys(AQI_GAS_BP).forEach(p => { sums[p] = 0; cnts[p] = 0; });

  for (let i = start; i < start + sd.length; i++) {
    let best = null;
    Object.keys(AQI_GAS_BP).forEach(p => {
      const si = gasSubIndex(p, sp[p]?.[i]);
      if (si == null) return;
      sums[p] += si; cnts[p]++;
      if (best == null || si > best) best = si;
    });
    if (best != null) dailyAqi.push(best);
  }
  if (!dailyAqi.length) return { aqi: null, dominant: null, days: 0 };

  let dom = null, domVal = -1;
  Object.keys(sums).forEach(p => {
    const m = cnts[p] ? sums[p] / cnts[p] : -1;
    if (m > domVal) { domVal = m; dom = p; }
  });
  return {
    aqi: dailyAqi.reduce((a, b) => a + b, 0) / dailyAqi.length,
    dominant: AQI_GAS_LABEL[dom] || null,
    days: dailyAqi.length,
  };
}


/**
 * Hitung AQI rata-rata dua tingkat dari sparklines per-lokasi.
 * Gunakan sparkline.aqi per-lokasi (7 hari terakhir) + national sparklines untuk rentang lebih panjang.
 * @returns {number|null}
 */
function computeAggAQI() {
  const D = STATE.data; if (!D) return null;
  const ppm  = ppmLocSet();
  const locs = D.locations.filter(l => STATE.filteredLocs.includes(l.location_id));
    
  // Jika rentang waktu sangat pendek (1 hari) atau pakai data terkini → gunakan loc.aqi langsung
  // Untuk agregasi multi-hari → rata-ratakan sparkline.aqi dalam rentang waktu
  const natSpark = (D.sparklines_national_full ?? D.sparklines_national);
  const allDates = natSpark.dates || [];
  const { dates: slicedDates } = sliceSparkline(allDates, allDates);
  const dateOffset = allDates.length - slicedDates.length;

  const perLocMeans = locs.map(l => {
    const ps = locPeriodStats(l.location_id);
    if (ps?.aqi != null) return ps.aqi;
    if (ppm.has(l.location_id)) return computeGasAqi(l.location_id).aqi;
    const sp = l.sparkline?.aqi || [];
    const locLen = sp.length;
    const locOffset = allDates.length - locLen;
    const vals = slicedDates.map((_, si) => {
      const absIdx = dateOffset + si;
      if (absIdx >= locOffset) return sp[absIdx - locOffset] ?? null;
      return null;
    }).filter(v => v != null);
    // Fallback ke loc.aqi jika sparkline tidak ada dalam rentang
    if (!vals.length && l.aqi != null) return l.aqi;
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
  }).filter(v => v != null);

  return perLocMeans.length ? perLocMeans.reduce((a,b)=>a+b,0)/perLocMeans.length : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// A1 — AQI PANEL
// ═══════════════════════════════════════════════════════════════════════════

/** Konversi derajat angin ke label mata angin (8 arah). */
function windDegToLabel(deg) {
  if (deg == null) return '--';
  const dirs = ['U','TL','T','TG','S','BD','B','BL'];
  return dirs[Math.round(deg / 45) % 8];
}

function renderAQIPanel() {
  const D = STATE.data; if (!D) return;
  const locs = D.locations.filter(l => STATE.filteredLocs.includes(l.location_id));

  // ── AQI: rata-rata dua-tingkat dari sparkline (filter-aware) ──────────────
  const aggAqi = computeAggAQI();
  const natAqi = aggAqi != null ? Math.round(aggAqi) : null;
  const cat = getCategory(natAqi, STATE.aqiScale);

  setElText('aqi-value-big', natAqi ?? '--');
  setElStyle('aqi-value-big', 'color', cat.color);

  // ── Border-left chip cuaca mengikuti warna angka AQI ──
  const wGrid = document.getElementById('weather-grid');
  if (wGrid) wGrid.style.setProperty('--aqi-color', cat.color);

  const badge = document.getElementById('aqi-cat-badge');
  if (badge) {
    badge.textContent = cat.label;
    badge.style.background = cat.color;
    badge.style.color = cat.textColor;
  }

  // ── Polutan dominan dari lokasi terfilter ─────────────────────────────────
  const mainPols = locs.map(l =>
    ppmLocSet().has(l.location_id) ? computeGasAqi(l.location_id).dominant : l.main_pol
  ).filter(Boolean);
  const freqPol = mainPols.length
    ? [...mainPols].sort((a,b) => mainPols.filter(x=>x===b).length - mainPols.filter(x=>x===a).length)[0]
    : D.national_summary.main_pollutant;
  setElText('aqi-main-pol', `Dominan: ${freqPol ?? '--'}`);

  // ── Label tanggal / rentang ───────────────────────────────────────────────
  const kabSuffix = STATE.selectedKabupaten.length > 0
    ? ' · ' + (STATE.selectedKabupaten.length === 1
        ? STATE.selectedKabupaten[0]
        : `${STATE.selectedKabupaten.length} wilayah`)
    : '';
  if (STATE.periodDays === -1) {
    // Custom interval — tampilkan tanggal yang dipilih user
    // Clamp ke window sparkline yang tersedia
    const sparkDates = (D.sparklines_national_full ?? D.sparklines_national).dates || [];
    const sparkStart = sparkDates[0] ?? D.meta.data_date_range.start;
    const sparkEnd   = sparkDates[sparkDates.length - 1] ?? D.meta.data_date_range.end;
    const s = STATE.dateStart
      ? (STATE.dateStart.toISOString().slice(0,10) < sparkStart ? sparkStart : STATE.dateStart.toISOString().slice(0,10))
      : sparkStart;
    const e = STATE.dateEnd
      ? (STATE.dateEnd.toISOString().slice(0,10) > sparkEnd ? sparkEnd : STATE.dateEnd.toISOString().slice(0,10))
      : sparkEnd;
    setElText('aqi-date-label', `📅 ${s} → ${e}${kabSuffix}`);
  } else {
    // Tanpa filter — tampilkan rentang sparkline yang tersedia (bukan full dataset)
    const sparkDates = (D.sparklines_national_full ?? D.sparklines_national).dates || [];
    const s = sparkDates[0] ?? D.meta.data_date_range.start;
    const e = sparkDates[sparkDates.length - 1] ?? D.meta.data_date_range.end;
    setElText('aqi-date-label', `📅 ${s} → ${e}${kabSuffix}`);
  }

  // ── Meteo: agregasi dari national_summary (temperature & humidity tidak ada di per-loc sparklines)
  // Jika satu wilayah dipilih, gunakan national_summary sebagai proxy; data meteo per-lokasi tidak tersedia.
  const temp = computeMeteoMean('temperature_c') ?? D.national_summary.temperature_c;
  const hum  = computeMeteoMean('humidity_pct')  ?? D.national_summary.humidity_pct;
  const wind = computeMeteoMean('wind_speed_ms') ?? D.national_summary.wind_speed_ms;
  // wind_direction_deg tidak ada di JSON — tampilkan wind_speed_ms sebagai gantinya
  setElText('nat-temp',      temp != null ? temp.toFixed(1) : '--');
  setElText('nat-hum',       hum  != null ? hum.toFixed(0)  : '--');
  setElText('nat-wind',      wind != null ? wind.toFixed(1) : '--');
  setElText('aqi-loc-count', locs.length);

  renderAQILegend();
  renderPollutantTrend();
}

function renderAQILegend() {
  // Legend dots dihapus — tidak perlu render apapun
  const el = document.getElementById('aqi-legend');
  if (el) el.innerHTML = '';
}

// ═══════════════════════════════════════════════════════════════════════════
// TREN POLUTAN — multi-line chart 6 polutan, berdasarkan filter waktu+wilayah
// Menggantikan pollutant-compare-grid dan pollutant-cards lama
// ═══════════════════════════════════════════════════════════════════════════
function renderPollutantTrend() {
  const D = STATE.data;
  const canvas = document.getElementById('chart-pollutant-trend');
  if (!canvas || !D) return;

  if (STATE.charts['pol-trend']) { STATE.charts['pol-trend'].destroy(); delete STATE.charts['pol-trend']; }

  const natSpark  = (D.sparklines_national_full ?? D.sparklines_national);
  const fullDates = D.sparklines_full_dates || natSpark.dates || [];

  // Hitung sumbu waktu (dates) yang sudah di-slice sesuai filter
  const { dates: slicedDates } = sliceSparkline(fullDates, fullDates);

  // Daftar polutan aktif dari STATE (dikelola oleh klik chip)
  const activePols = STATE.activePols;
  // Fallback: jika kosong, aktifkan semua
  if (activePols.size === 0) POLLUTANTS.forEach(p => activePols.add(p.key));

  // Helper: hitung rata-rata nilai polutan per tanggal dari lokasi terfilter
  function computeAggSeries(polKey) {
    if (STATE.selectedKabupaten.length === 0) {
      const { values } = sliceSparkline(fullDates, natSpark[polKey] || []);
      return { values, unit: 'µg/m³' };
    }
    const { ids, unit } = resolveUnitLocs(polKey);
    const dateIdx = Object.fromEntries(fullDates.map((d, i) => [d, i]));
    const values = slicedDates.map(date => {
      const absIdx = dateIdx[date];
      const vals = ids.map(lid => D.sparklines_per_loc?.[lid]?.[polKey]?.[absIdx] ?? null)
                      .filter(v => v != null);
      return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
    });
    return { values, unit };
  }

  // Format label tanggal — pakai YYYY-MM jika rentang > 60 hari, MM-DD jika pendek
  const longRange = slicedDates.length > 60;
  const labels = slicedDates.map(d => longRange ? d.slice(0, 7) : d.slice(5)); // "YYYY-MM" or "MM-DD"

  const datasets = POLLUTANTS
    .filter(p => activePols.has(p.key))
    .map(p => {
      const { values, unit } = computeAggSeries(p.key);
      const isPpm = unit === 'ppm';
      return {
        label: `${p.label} (${isPpm ? 'ppm' : p.unit})`,
        data: values.map(v => v ?? null),
        borderColor: p.color,
        backgroundColor: hexToRgba(p.color, 0.07),
        borderWidth: 1.8,
        pointRadius: labels.length <= 15 ? 3 : 0,
        tension: 0.4,
        fill: false,
        spanGaps: true,
        yAxisID: isPpm ? 'y2' : 'y',
    };});

  // ── Chips rata-rata vertical — kiri grafik, klik toggle garis ────────────
  const summaryEl = document.getElementById('pol-avg-summary');
  if (summaryEl) {
    summaryEl.innerHTML = POLLUTANTS.map(p => {
      const info     = computePolMeanInfo(p.key);
      const valStr   = info.value != null ? fmtNum(info.value, p.key, info.unit) : '--';
      const unitStr  = info.unit === 'ppm' ? 'ppm' : p.unit;
      const isActive = activePols.has(p.key);
      const note     = info.excluded > 0 ? ` (${info.excluded} wilayah ppm tidak dihitung)` : '';
      return `<div class="pol-avg-row" data-pol="${p.key}"
        style="border-left:3px solid ${p.color};opacity:${isActive ? '1' : '0.3'};cursor:pointer"
        title="Klik untuk ${isActive ? 'sembunyikan' : 'tampilkan'} di grafik${note}">
        <span class="pol-avg-row-label" style="color:${p.color}">${p.label}</span>
        <span class="pol-avg-row-val">${valStr} <span class="pol-avg-row-unit">${unitStr}</span></span>
      </div>`;
    }).join('');
  }

  STATE.charts['pol-trend'] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => slicedDates[items[0]?.dataIndex] || '',
          }
        }
      },
      scales: {
        x: { ticks: { font: { size: 8 }, maxTicksLimit: longRange ? 20 : 12, maxRotation: longRange ? 30 : 0 } },
        y: { ticks: { font: { size: 9 } }, title: { display: true, text: 'Konsentrasi (µg/m³)', font: { size: 9 } } },
        y2: {
          display: datasets.some(d => d.yAxisID === 'y2'),
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { font: { size: 9 } },
          title: { display: true, text: 'ppm', font: { size: 9 } }
        }
      }
    }
  });
}

// Keep renderPollutantCards as no-op (called nowhere now, kept for modal compatibility)
function renderPollutantCards() { /* replaced by renderPollutantTrend */ }

function fmtNum(v, key, unit) {
  if (v == null) return '--';
  if (unit === 'ppm') return v.toFixed(4);
  return key === 'co' ? v.toFixed(0) : v.toFixed(1);
}

function getConcentrationBadge(polKey, val) {
  if (val==null) return { label:'N/A', cls:'badge-gray' };
  const thr = {
    pm25: [{hi:9,'l':'Baik','c':'badge-green'},{hi:35.4,'l':'Sedang','c':'badge-yellow'},{hi:55.4,'l':'Sensitif','c':'badge-orange'},{hi:125.4,'l':'Tidak Sehat','c':'badge-red'},{hi:999,'l':'Berbahaya','c':'badge-purple'}],
    pm10: [{hi:54,'l':'Baik','c':'badge-green'},{hi:154,'l':'Sedang','c':'badge-yellow'},{hi:254,'l':'Sensitif','c':'badge-orange'},{hi:354,'l':'Tidak Sehat','c':'badge-red'},{hi:999,'l':'Berbahaya','c':'badge-purple'}],
    so2:  [{hi:50,'l':'Baik','c':'badge-green'},{hi:150,'l':'Sedang','c':'badge-yellow'},{hi:300,'l':'Tidak Sehat','c':'badge-orange'},{hi:999,'l':'Berbahaya','c':'badge-red'}],
    co:   [{hi:1000,'l':'Baik','c':'badge-green'},{hi:2000,'l':'Sedang','c':'badge-yellow'},{hi:5000,'l':'Tidak Sehat','c':'badge-orange'},{hi:99999,'l':'Berbahaya','c':'badge-red'}],
    o3:   [{hi:30,'l':'Baik','c':'badge-green'},{hi:70,'l':'Sedang','c':'badge-yellow'},{hi:120,'l':'Tidak Sehat','c':'badge-orange'},{hi:999,'l':'Berbahaya','c':'badge-red'}],
    no2:  [{hi:40,'l':'Baik','c':'badge-green'},{hi:80,'l':'Sedang','c':'badge-yellow'},{hi:200,'l':'Tidak Sehat','c':'badge-orange'},{hi:999,'l':'Berbahaya','c':'badge-red'}],
  };
  for (const t of (thr[polKey]||[])) if (val<=t.hi) return { label:t.l, cls:t.c };
  return { label:'Berbahaya', cls:'badge-purple' };
}

function drawSparkline(id, labels, data, color) {
  const canvas = document.getElementById(id); if (!canvas) return;
  if (STATE.charts[id]) { STATE.charts[id].destroy(); delete STATE.charts[id]; }
  STATE.charts[id] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{ data: data.map(v=>v??NaN), borderColor: color, borderWidth:1.5,
      fill:true, backgroundColor:hexToRgba(color,0.12), pointRadius:0, tension:0.4, spanGaps:true }] },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{enabled:false}},
      scales:{x:{display:false},y:{display:false}}, animation:false }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// B3 — LEAFLET MAP (peta provinsi GeoJSON nyata + marker per sensor)
// ═══════════════════════════════════════════════════════════════════════════
async function renderMap() {
  const D = STATE.data; if (!D) return;

  // Inisialisasi Leaflet sekali saja
  if (!STATE.leafletMap) {
    const map = L.map('leaflet-map', {
      center: [-2.5, 118],
      zoom: 5,
      zoomControl: true,
      attributionControl: true,
    });

    // Tile layer OpenStreetMap (atau CartoDB light)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 12,
    }).addTo(map);

    STATE.leafletMap = map;

    // Load GeoJSON provinsi
    try {
      const res = await fetch('data/provinces.geojson');
      if (res.ok) {
        const gj = await res.json();
        STATE.leafletProvinces = L.geoJSON(gj, {
          style: () => ({
            color: '#6ee7b7',
            weight: 0.8,
            fillColor: '#d1fae5',
            fillOpacity: 0.25,
          }),
          onEachFeature: (feature, layer) => {
            layer.bindTooltip(feature.properties?.provinsi || '', { sticky: true, className: 'leaflet-prov-tooltip' });
          }
        }).addTo(map);
      }
    } catch (e) {
      console.warn('GeoJSON provinsi tidak tersedia:', e.message);
    }
  }

  renderMapDots();
}

function renderMapDots() {
  const D = STATE.data;
  const map = STATE.leafletMap;
  if (!D || !map) return;

  // Hapus marker lama
  STATE.leafletMarkers.forEach(m => map.removeLayer(m));
  STATE.leafletMarkers = [];

  const mode = STATE.mapMode;
  const mapLocs = D.map_data.filter(l => STATE.filteredLocs.includes(l.location_id));

  // ── Hitung nilai per-lokasi berbasis filter tanggal (agregasi rata-rata dua tingkat) ──
  // Untuk cases/deaths: rata-ratakan dari health_trends dalam rentang tanggal aktif
  // Untuk AQI: rata-ratakan dari sparkline.aqi dalam rentang tanggal aktif
  const natSpark = (D.sparklines_national_full ?? D.sparklines_national);
  const allDates  = natSpark.dates || [];
  const { dates: slicedDates } = sliceSparkline(allDates, allDates);
  const dateOffset = allDates.length - slicedDates.length;

  // Hitung nilai per-lokasi yang sudah difilter tanggal
  const locStats = {};
  D.locations.filter(l => STATE.filteredLocs.includes(l.location_id)).forEach(l => {
    // AQI dari sparkline per-lokasi (last 7 days)
    const aqiSp = l.sparkline?.aqi || [];
    const locAqiOffset = allDates.length - aqiSp.length;
    const aqiVals = slicedDates.map((_, si) => {
      const absIdx = dateOffset + si;
      return absIdx >= locAqiOffset ? (aqiSp[absIdx - locAqiOffset] ?? null) : null;
    }).filter(v => v != null);
    const ps = locPeriodStats(l.location_id);
    const aggAqi = ps?.aqi ?? (aqiVals.length ? aqiVals.reduce((a,b)=>a+b,0)/aqiVals.length : (l.aqi ?? null));
    const aqiDays = ps?.aqi != null ? ps.days : aqiVals.length;
    const qcPct = ps?.qcPct ?? null;

    // Kasus & kematian dari health_trends dalam rentang tanggal
    const tr = D.health_trends?.[l.location_id];
    let aggCases = l.mean_resp ?? 0;
    let aggDeath = l.mean_death ?? 0;
    let caseDays = 0;
    if (tr?.dates?.length) {
      const { values: casesVals } = sliceSparkline(tr.dates, tr.resp || []);
      const { values: deathVals } = sliceSparkline(tr.dates, tr.death || []);
      const vc = casesVals.filter(v=>v!=null);
      const vd = deathVals.filter(v=>v!=null);
      if (vc.length) { aggCases = vc.reduce((a,b)=>a+b,0)/vc.length; caseDays = vc.length; }
      if (vd.length) aggDeath = vd.reduce((a,b)=>a+b,0)/vd.length;
    }

    // PM2.5 latest dari sparkline jika tersedia
    const pm25Sp = l.sparkline?.pm25 || [];
    const pm25Agg = pm25Sp.length ? pm25Sp[pm25Sp.length-1] : l.pm25_latest;

    locStats[l.location_id] = { aggAqi, aggCases, aggDeath, pm25Agg, aqiDays, caseDays, qcPct };
  });

  const maxCases = Math.max(...Object.values(locStats).map(s=>s.aggCases), 1);
  const maxDeath = Math.max(...Object.values(locStats).map(s=>s.aggDeath), 1);

  mapLocs.forEach(loc => {
    const stats  = locStats[loc.location_id] || {};
    const isPpm  = ppmLocSet().has(loc.location_id);
    const aqiRaw = stats.aggAqi ?? (isPpm ? computeGasAqi(loc.location_id).aqi : (loc.aqi ?? null));
    const cat    = getCategory(aqiRaw != null ? Math.round(aqiRaw) : null, STATE.aqiScale);
    const cases = stats.aggCases ?? loc.avg_cases_day ?? 0;
    const death = stats.aggDeath ?? 0;

    // Semua titik ukuran seragam
    const baseR = 9;

    // Warna dot
    let fillColor = '#3b82d4';
    if (mode === 'combined' || mode === 'aqi') fillColor = cat.color;
    if (mode === 'forecast') {
      const locFull = D.locations.find(l => l.location_id === loc.location_id);
      const deathPred = locFull?.pred_rastgnn_B?.death ?? null;
      fillColor = deathPred != null
        ? (deathPred > 5 ? '#7E0023' : deathPred > 2 ? '#8F3F97' : deathPred > 1 ? '#FF7E00' : '#00E400')
        : '#9ca3af';
    }
    if (aqiRaw == null && mode !== 'forecast') fillColor = '#9ca3af';

    const circleOpts = {
      radius: baseR,
      fillColor,
      color: '#fff',
      weight: 1,
      opacity: 0.9,
      fillOpacity: 0.85,
    };

    const marker = L.circleMarker([loc.lat, loc.lon], circleOpts);

    // Tooltip
    const dayLbl = n => n > 0 ? ` <span style="color:#9ca3af">(rata-rata ${n} hari)</span>` : '';
    marker.bindTooltip(`
      <div style="font-size:12px;line-height:1.6">
        <b>${loc.kota}</b><br>
        <span style="color:#9ca3af">${loc.provinsi}</span><br>
        AQI: ${aqiRaw != null
          ? `<b style="color:${cat.color}">${Math.round(aqiRaw)}</b> ${cat.label}${dayLbl(stats.aqiDays)}`
          : '<b>N/A</b>'}<br>
        Kasus/hari: <b>${cases.toFixed(1)}</b>${dayLbl(stats.caseDays)}<br>
        Kematian/hari: <b>${death.toFixed(2)}</b>${dayLbl(stats.caseDays)}<br>
        Data valid (QC): <b>${stats.qcPct != null ? stats.qcPct.toFixed(0) + '%' : '--'}</b>
      </div>`, { sticky: true }
    );

    marker.on('click', () => openLocationModal(loc.location_id));
    marker.addTo(map);
    STATE.leafletMarkers.push(marker);
  });

  renderMapLegend(mode);
}

function renderMapLegend(mode) {
  const el = document.getElementById('map-legend'); if (!el) return;
  const cats = (STATE.aqiScale==='ISPU' ? AQI_ISPU : AQI_EPA);
  const item = c => `<span style="display:flex;align-items:center;gap:4px;font-size:11px;">
    <span style="background:${c.color};width:11px;height:11px;border-radius:50%;flex-shrink:0;border:1px solid rgba(0,0,0,0.18)"></span>
    <span style="color:${c.color==='#FFFF00'?'#854d0e':'inherit'};white-space:nowrap">${c.label}</span>
  </span>`;
  // 2 baris: 3 item atas, 3 item bawah
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px 12px;width:100%">
      ${cats.map(item).join('')}
    </div>`;
}

// Label singkat fitur penyakit di forest plot (sama dengan tombol target)
const DISEASE_FEAT_LABEL = {
  resp:                   'Infeksi Napas',
  resp_admissions_under5: 'Balita <5',
  resp_admissions_over60: 'Lansia >60',
  asthma_emergency_cases: 'Asma',
  copd_admissions:        'PPOK',
  cvd:                    'Kardiovaskular',
  death:                  'Kematian',
};

// Rata-rata nasional fitur penyakit: seluruh lokasi, seluruh tanggal (dengan cache)
const _natHealthCache = {};
function nationalHealthMean(key) {
  if (key in _natHealthCache) return _natHealthCache[key];
  const D = STATE.data;
  const perLoc = [];
  Object.values(D?.health_trends || {}).forEach(tr => {
    const v = (tr[key] || []).filter(x => x != null);
    if (v.length) perLoc.push(v.reduce((a, b) => a + b, 0) / v.length);
  });
  return (_natHealthCache[key] = perLoc.length
    ? perLoc.reduce((a, b) => a + b, 0) / perLoc.length
    : null);
}

// ═══════════════════════════════════════════════════════════════════════════
// B4 — FOREST PLOT (SHAP, lag-1h, filter-aware)
// ═══════════════════════════════════════════════════════════════════════════
function renderForestPlot() {
  const D = STATE.data;
  const container = document.getElementById('forest-plot');
  if (!container || !D) return;
  const target = STATE.forestTarget;

  // Gunakan shap_v2 (signed, CI) jika tersedia; fallback ke shap lama
  const shapV2 = D.shap_v2?.[target];
  if (!shapV2?.length) {
    container.innerHTML = '<div class="text-xs text-gray-400 italic">Data SHAP tidak tersedia.</div>';
    return;
  }

  const locs = D.locations.filter(l => STATE.filteredLocs.includes(l.location_id));

  // ── Hitung overallMean kasus/hari ─────────────────────────────────────────
  let overallMean = '--';
  const mean = computeTwoLevelMean(target);
  if (mean != null) {
    overallMean = mean.toFixed(1);
  } else {
    const meanVals = locs.map(l => l.health_means?.[`mean_${target}`]).filter(v=>v!=null);
    if (meanVals.length) overallMean = (meanVals.reduce((a,b)=>a+b,0)/meanVals.length).toFixed(1);
  }

  // Rentang tanggal aktif (mengikuti filter waktu navbar)
  const _fd = D.sparklines_full_dates || [];
  const { dates: _rd } = sliceSparkline(_fd, _fd);
  const rangeTxt = _rd.length
    ? `${_rd[0]} – ${_rd[_rd.length - 1]}`
    : 'periode terpilih';

  const badge = document.getElementById('outcome-mean-badge');
  if (badge) badge.innerHTML =
    `<span class="outcome-badge-label">${HEALTH_TARGETS_LABEL[target] || target}:</span> ` +
    `<span class="outcome-badge-value">${overallMean}</span> ` +
    `<span class="outcome-badge-range">(rata-rata ${rangeTxt})</span>`;

  // ── Helper: rata-rata fitur aktual di wilayah/periode terpilih ───────────
  const natMeans = D.feature_national_means || {};
  const fullDates = D.sparklines_full_dates || [];
  const dateIdxMap = Object.fromEntries(fullDates.map((d,i) => [d,i]));
  const { dates: slicedDates } = sliceSparkline(fullDates, fullDates);

  function computeActualFeatureMean(featKey) {
    const spl = D.sparklines_per_loc;
    if (!spl) return null;
    if (DISEASE_FEAT_LABEL[featKey]) return computeTwoLevelMean(featKey);
    // Polutan: pakai computePolMean yang sudah filter-aware
    if (['pm25','pm10','so2','co','o3','no2'].includes(featKey)) {
      return computePolMean(featKey);
    }
    // Meteo: rata-rata per-lokasi dalam rentang → mean antar lokasi
    const locIds = STATE.selectedKabupaten.length === 0
      ? Object.keys(spl)
      : STATE.filteredLocs;
    const perLocMeans = locIds.map(lid => {
      const sp = spl[lid];
      if (!sp?.[featKey]) return null;
      const vals = slicedDates.map(d => {
        const idx = dateIdxMap[d];
        return idx !== undefined ? (sp[featKey][idx] ?? null) : null;
      }).filter(v => v != null);
      return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    }).filter(v => v != null);
    return perLocMeans.length ? perLocMeans.reduce((a,b)=>a+b,0)/perLocMeans.length : null;
  }

  // ── Hitung contribution score = signed_pct × (actual / national_mean) ────
  // Ini rescale importance berdasarkan seberapa tinggi nilai fitur di wilayah ini
  // relatif terhadap nasional. Jika PM10 Aceh = 2× nasional → bar 2× lebih panjang.
  const featuresWithScore = shapV2.map(f => {
    const actual  = computeActualFeatureMean(f.feature);
    const natMean = DISEASE_FEAT_LABEL[f.feature]
      ? nationalHealthMean(f.feature)
      : natMeans[f.feature];
    const featUnit = PPM_POLS.includes(f.feature) ? computePolMeanInfo(f.feature).unit : null;
    const ratio = (featUnit === 'ppm') ? 1
      : (actual != null && natMean && natMean > 0) ? (actual / natMean) : 1;
    return {
      ...f,
      actual,
      ratio,
      contrib_signed: f.signed_pct * ratio,
      contrib_abs:    f.abs_pct    * ratio,
      contrib_ci:     f.ci_half_pct * ratio,
    };
  });

  const features = [...featuresWithScore].sort((a,b) => b.contrib_abs - a.contrib_abs);

  // Sumbu tetap -100% .. +100%; nilai di luar rentang dipotong di ujung.
  const AX = 100;
  const sc = 50 / AX;                                   // 1% = 0.5% lebar area bar
  const clamp = v => Math.max(-AX, Math.min(AX, v));

  const tick = (pos, txt) =>
    `<span style="position:absolute;left:${pos}%;transform:translateX(-50%)">${txt}</span>`;
  const axisLabels = `
    <div style="flex:none;display:flex;margin-bottom:4px">
      <div style="width:110px;flex-shrink:0"></div>
      <div style="flex:1;position:relative;height:12px;font-size:9px;color:#9ca3af">
        ${tick(0, '-100%')}${tick(25, '-50%')}${tick(50, '0%')}${tick(75, '+50%')}${tick(100, '+100%')}
      </div>
      <div style="width:56px;flex-shrink:0"></div>
    </div>`;

  const rows = features.map(f => {
    const s      = f.contrib_signed;          // nilai asli (untuk teks di kanan)
    const ci     = f.contrib_ci;
    const isPos  = s >= 0;
    const crossesZero = (s - ci < 0) && (s + ci > 0);

    const sC    = clamp(s);                   // nilai yang digambar
    const ciLoC = clamp(s - ci);
    const ciHiC = clamp(s + ci);

    const barColor = crossesZero ? '#fca5a5' : isPos ? '#ef4444' : '#3b82f6';
    const barLeft  = isPos ? 50 : 50 + sC * sc;
    const barWidth = Math.abs(sC) * sc;
    const ciLeft   = 50 + ciLoC * sc;
    const ciWidth  = (ciHiC - ciLoC) * sc;

    const sign = s >= 0 ? '+' : '';
    const pctColor = crossesZero ? '#9ca3af' : isPos ? '#ef4444' : '#3b82f6';

    return `<div style="flex:1 1 0;min-height:20px;display:flex;align-items:center">
      <div style="width:110px;flex-shrink:0;font-size:11px;text-align:right;padding-right:6px;overflow:hidden;white-space:nowrap;color:inherit" title="${HEALTH_TARGETS_LABEL[f.feature] || f.label}">
        ${DISEASE_FEAT_LABEL[f.feature] || f.label}
      </div>
      <div style="flex:1;position:relative;height:16px">
        <div style="position:absolute;left:50%;top:0;width:1px;height:100%;background:#d1d5db;z-index:1"></div>
        <div style="position:absolute;top:3px;height:10px;left:${barLeft.toFixed(1)}%;width:${Math.max(barWidth,0.5).toFixed(1)}%;background:${barColor};z-index:2;border-radius:1px"></div>
        <div style="position:absolute;top:1px;height:14px;left:${ciLeft.toFixed(1)}%;width:${ciWidth.toFixed(1)}%;background:rgba(55,65,81,0.25);z-index:3;border-radius:1px"></div>
        <div style="position:absolute;top:0;height:16px;left:${ciLeft.toFixed(1)}%;width:1px;background:#6b7280;z-index:4"></div>
        <div style="position:absolute;top:0;height:16px;left:${(ciLeft + ciWidth).toFixed(1)}%;width:1px;background:#6b7280;z-index:4"></div>
      </div>
      <div style="width:56px;flex-shrink:0;font-size:11px;font-weight:600;padding-left:4px;color:${pctColor}">${sign}${s.toFixed(1)}%</div>
    </div>`;
  }).join('');

  const legend = `<div style="flex:none;display:flex;gap:12px;font-size:10px;color:#6b7280;margin-top:6px;padding-top:4px;border-top:1px solid #e5e7eb">
    <span style="display:flex;align-items:center;gap:3px"><span style="width:10px;height:10px;background:#ef4444;border-radius:2px;display:inline-block"></span> risiko naik</span>
    <span style="display:flex;align-items:center;gap:3px"><span style="width:10px;height:10px;background:#3b82f6;border-radius:2px;display:inline-block"></span> risiko turun</span>
  </div>`;

  container.innerHTML = axisLabels + rows + legend;
}

// Tujuh penyakit (urutan = urutan kotak). Nama mengikuti DISEASE_FEAT_LABEL.
const FORECAST_SERIES = [
  { key: 'resp',                   color: '#3b82f6', model: 'A' },
  { key: 'resp_admissions_under5', color: '#06b6d4', model: 'A' },
  { key: 'resp_admissions_over60', color: '#10b981', model: 'A' },
  { key: 'asthma_emergency_cases', color: '#f97316', model: 'A' },
  { key: 'copd_admissions',        color: '#eab308', model: 'A' },
  { key: 'cvd',                    color: '#8b5cf6', model: 'A' },
  { key: 'death',                  color: '#ef4444', model: 'B' },   // B-chained
];
let forecastTarget = 'resp';

/** Tanggal data terakhir + n hari, format YYYY-MM-DD (tanpa geser zona waktu). */
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderRaStgnnForecastChart() {
  const D = STATE.data; if (!D) return;
  const canvas = document.getElementById('chart-rastgnn-forecast'); if (!canvas) return;
  if (STATE.charts['rastgnn-fc']) { STATE.charts['rastgnn-fc'].destroy(); delete STATE.charts['rastgnn-fc']; }

  const horizons = D.model_forecasts_meta?.rastgnn_horizons || [1,2,3,4,5,6,7];
  const baseDate = D.meta.data_date_range.end;                 // tanggal "terkini"
  const dates    = [baseDate, ...horizons.map(h => addDaysStr(baseDate, h))];
  const labels   = dates.map(d => d.slice(5));                 // MM-DD

  const locs = D.locations.filter(l => STATE.filteredLocs.includes(l.location_id));
  const avg = arr => {
    const v = arr.filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  // Nilai terkini = nilai tidak kosong terakhir per lokasi, dirata-rata antar lokasi terfilter
  const latestMean = key => avg(locs.map(l => {
    const arr = D.health_trends?.[l.location_id]?.[key] || [];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }));

  // Prediksi 7 hari = rata-rata antar lokasi terfilter
  const forecastOf = s => {
    const preds = locs.map(l => s.model === 'A'
      ? l.pred_rastgnn_horizons?.model_A?.[s.key]?.predicted
      : l.pred_rastgnn_horizons?.model_B_chained?.death?.predicted
    ).filter(p => p?.length);
    let data = horizons.map((_, i) => avg(preds.map(p => p[i])));
    if (data.every(v => v == null) && D.national_forecast_rastgnn?.[s.key]) {
      data = D.national_forecast_rastgnn[s.key];               // cadangan
    }
    return data;
  };

  const series = FORECAST_SERIES.map(s => {
    const fc = forecastOf(s);
    return { ...s, current: latestMean(s.key), forecast: fc, mean: avg(fc) };
  });

  // Tujuh kotak (klik = pilih penyakit); angka = rata-rata prediksi 7 hari
  const btns = document.getElementById('forecast-btns');
  if (btns) {
    btns.innerHTML = series.map(s => `
      <div class="fc-box ${s.key === forecastTarget ? 'active' : ''}" data-fc="${s.key}"
        style="--fc-color:${s.color}" title="${HEALTH_TARGETS_LABEL[s.key] || s.key}">
        <span class="fc-box-label">${DISEASE_FEAT_LABEL[s.key] || s.key}</span>
        <span class="fc-box-value">${s.mean != null ? s.mean.toFixed(2) : '--'}</span>
      </div>`).join('');
  }

  // Bar chart: 1 bar terkini + 7 bar prediksi untuk penyakit terpilih
  const sel = series.find(s => s.key === forecastTarget) || series[0];
  const values = [sel.current, ...sel.forecast].map(v => v != null ? +v.toFixed(3) : null);
  const colors = values.map((_, i) => i === 0 ? '#9ca3af' : hexToRgba(sel.color, 0.85));

  STATE.charts['rastgnn-fc'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: HEALTH_TARGETS_LABEL[sel.key] || sel.key,
        data: values,
        backgroundColor: colors,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const i = items[0]?.dataIndex ?? 0;
              return i === 0 ? `${dates[0]} (terkini)` : `${dates[i]} (prediksi h+${horizons[i - 1]})`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 0 } },
        y: { beginAtZero: true, ticks: { font: { size: 9 } },
             title: { display: true, text: 'Kasus / Kematian per hari', font: { size: 9 } } }
      }
    }
  });
}

let polForecastTarget = 'pm25';

function renderMiagnnForecastChart() {
  const D = STATE.data; if (!D) return;
  const canvas = document.getElementById('chart-miagnn-forecast'); if (!canvas) return;
  if (STATE.charts['miagnn-fc']) { STATE.charts['miagnn-fc'].destroy(); delete STATE.charts['miagnn-fc']; }

  const avg = arr => {
    const v = arr.filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  // Mode peramalan: harian (7 hari) jika data tersedia, jika tidak per jam
  const hasDaily = D.locations.some(l =>
    Object.values(l.pred_miagnn || {}).some(v => v?.forecast_daily?.length));
  const horizHours = D.model_forecasts_meta?.miagnn_horizon_hours || [1, 2, 3];
  const baseDate   = D.meta.data_date_range.end;

  let labels, tipTitles;
  if (hasDaily) {
    const dates = [baseDate, ...Array.from({ length: 7 }, (_, i) => addDaysStr(baseDate, i + 1))];
    labels    = dates.map(d => d.slice(5));
    tipTitles = dates.map((d, i) => i === 0 ? `${d} (terkini)` : `${d} (prediksi h+${i})`);
  } else {
    labels    = ['Terkini', ...horizHours.map(h => `+${h} jam`)];
    tipTitles = labels;
  }

  const series = POLLUTANTS.map(p => {
    // PM dalam ppm tidak dicampur dengan µg/m³ (aturan yang sama dengan panel lain)
    const { ids, unit } = resolveUnitLocs(p.key);
    const locs = D.locations.filter(l => ids.includes(l.location_id));

    const current = avg(locs.map(l => l.pred_miagnn?.[p.key]?.current));
    let forecast;
    if (hasDaily) {
      forecast = Array.from({ length: 7 }, (_, i) =>
        avg(locs.map(l => l.pred_miagnn?.[p.key]?.forecast_daily?.[i])));
    } else {
      forecast = horizHours.map((_, i) =>
        avg(locs.map(l => l.pred_miagnn?.[p.key]?.forecast?.[i])));
      if (forecast.every(v => v == null)) forecast = D.national_forecast_miagnn?.[p.key] || forecast;
    }
    return { ...p, unit, current, forecast, mean: avg(forecast) };
  });

  // Enam kotak (klik = pilih polutan); angka = rata-rata nilai peramalan
  const btns = document.getElementById('pol-forecast-btns');
  if (btns) {
    btns.innerHTML = series.map(s => `
      <div class="fc-box ${s.key === polForecastTarget ? 'active' : ''}" data-pfc="${s.key}"
        style="--fc-color:${s.color}" title="${s.label} (${s.unit})">
        <span class="fc-box-label">${s.label}</span>
        <span class="fc-box-value">${s.mean != null ? fmtNum(s.mean, s.key, s.unit) : '--'}</span>
      </div>`).join('');
  }

  const sel = series.find(s => s.key === polForecastTarget) || series[0];
  const values = [sel.current, ...sel.forecast].map(v => v != null ? +v.toFixed(sel.unit === 'ppm' ? 4 : 2) : null);
  const colors = values.map((_, i) => i === 0 ? '#9ca3af' : hexToRgba(sel.color, 0.85));

  STATE.charts['miagnn-fc'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: `${sel.label} (${sel.unit})`, data: values, backgroundColor: colors, borderRadius: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => tipTitles[items[0]?.dataIndex ?? 0] } }
      },
      scales: {
        x: { ticks: { font: { size: 9 }, maxRotation: 0 } },
        y: { beginAtZero: true, ticks: { font: { size: 9 } },
             title: { display: true, text: sel.unit, font: { size: 9 } } }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// C5 — LOCATION TABLE
// ═══════════════════════════════════════════════════════════════════════════
function renderLocationTable() {
  const D = STATE.data;
  const tbody = document.getElementById('location-table-body');
  if (!tbody || !D) return;

  let locs = D.locations.filter(l => STATE.filteredLocs.includes(l.location_id));
  if (STATE.tableSearch) {
    locs = locs.filter(l =>
      (l.kota||'').toLowerCase().includes(STATE.tableSearch) ||
      (l.provinsi||'').toLowerCase().includes(STATE.tableSearch) ||
      (l.location_id||'').toLowerCase().includes(STATE.tableSearch)
    );
  }

  const { col, dir } = STATE.tableSort;
  locs = [...locs].sort((a,b) => {
    const val = (l) => (col === 'pm25_latest' && ppmLocSet().has(l.location_id))
      ? -Infinity : (l[col] ?? -Infinity);
    let av = val(a), bv = val(b);
    if (typeof av==='string') av=av.toLowerCase();
    if (typeof bv==='string') bv=bv.toLowerCase();
    return dir==='asc' ? (av<bv?-1:av>bv?1:0) : (av>bv?-1:av<bv?1:0);
  });

  document.querySelectorAll('.data-table th.sortable').forEach(th => {
    th.classList.remove('sorted-asc','sorted-desc');
    if (th.dataset.col===col) th.classList.add(dir==='asc'?'sorted-asc':'sorted-desc');
  });

  if (!locs.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-gray-400">Tidak ada data.</td></tr>`;
    return;
  }

  tbody.innerHTML = locs.map(loc => {
    const isActive = (loc.valid_pct||0) > 50;
    const deathPred = loc.pred_rastgnn_B?.death;
    const isPpm  = ppmLocSet().has(loc.location_id);
    const gas    = isPpm ? computeGasAqi(loc.location_id) : null;
    const aqiVal = isPpm ? (gas.aqi != null ? Math.round(gas.aqi) : null) : loc.aqi;
    const cat    = getCategory(aqiVal, STATE.aqiScale);
    const pmVal  = isPpm ? (latestPerLoc(loc.location_id, 'pm25') ?? loc.pm25_latest) : loc.pm25_latest;

    return `<tr onclick="openLocationModal('${loc.location_id}')" style="cursor:pointer">
      <td>
        <div class="font-semibold">${loc.kota}</div>
        <div class="text-xs text-gray-400">${loc.provinsi}</div>
      </td>
      <td>
        ${aqiVal != null
          ? `<span class="inline-block font-bold text-sm px-2 py-0.5 rounded-full" style="background:${cat.color};color:${cat.textColor}">${aqiVal}</span>
             <div class="text-xs text-gray-400 mt-0.5">${cat.label}</div>`
          : `<span class="text-gray-400 text-xs">N/A</span>`}
      </td>
      <td class="font-mono text-xs">${pmVal != null
        ? (isPpm ? `${pmVal.toFixed(4)} <span class="text-gray-400">ppm</span>` : pmVal.toFixed(1))
        : '--'}</td>
      <td><span class="badge badge-gray">${loc.site_type?.split('/')[0].trim()||'-'}</span></td>
      <td><span class="badge ${isActive?'badge-green':'badge-red'}">${isActive?'Aktif':'Nonaktif'}</span></td>
      <td>
        <span class="valid-pct-bar"><span class="valid-pct-fill" style="width:${Math.min(loc.valid_pct||0,100)}%"></span></span>
        <span class="text-xs">${(loc.valid_pct||0).toFixed(0)}%</span>
      </td>
      <td class="font-mono text-xs text-purple-600 dark:text-purple-400">
        ${deathPred != null ? deathPred.toFixed(2) : '<span class="text-gray-400">--</span>'}
      </td>
      <td>
        <button class="detail-btn" onclick="event.stopPropagation();openLocationModal('${loc.location_id}')">Detail</button>
      </td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════════════════
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }
window.closeModal = closeModal;

function openPollutantModal(pol) {
  const D = STATE.data;
  const modal = document.getElementById('modal-pollutant');
  if (!modal || !D) return;
  document.getElementById('modal-pol-title').textContent = `${pol.label} — Detail`;

  // Always destroy existing charts BEFORE showing modal to avoid stale canvases
  ['pol-daily','pol-rank','pol-forecast'].forEach(k => {
    if (STATE.charts[k]) { STATE.charts[k].destroy(); delete STATE.charts[k]; }
  });

  const natSpark = (D.sparklines_national_full ?? D.sparklines_national);
  // Use date-aware slicing instead of .slice(-days)
  const { dates: labels, values: rawVals } = sliceSparkline(
    natSpark.dates || [], natSpark[pol.key] || []
  );
  const data = rawVals.map(v => v ?? NaN);

  modal.classList.remove('hidden');

  // Use requestAnimationFrame instead of setTimeout so the DOM has laid out
  // the fixed-height wrappers before Chart.js reads their dimensions.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Tren harian — line chart inside fixed-height wrapper
    const c1 = document.getElementById('chart-pol-daily');
    if (c1) {
      STATE.charts['pol-daily'] = new Chart(c1, {
        type:'line', data:{ labels, datasets:[{
          label:pol.label, data, borderColor:pol.color,
          backgroundColor:hexToRgba(pol.color,0.1), fill:true,
          tension:0.4, pointRadius:0, borderWidth:2, spanGaps:true }] },
        options:{
          responsive:true, maintainAspectRatio:false, animation:false,
          plugins:{legend:{display:false}},
          scales:{x:{ticks:{maxTicksLimit:6,font:{size:9},maxRotation:0}},
                  y:{ticks:{font:{size:9}}}}}
      });
    }

    // Peringkat lokasi — horizontal bar inside fixed-height wrapper
    const c2 = document.getElementById('chart-pol-rank');
    if (c2) {
      const locs = D.locations.filter(l=>STATE.filteredLocs.includes(l.location_id));
      const ranked = [...locs]
        .map(l=>({ label:(l.kota||l.location_id).split(' ').slice(-1)[0],
                   val:l.sparkline?.[pol.key]?.filter(Boolean)?.slice(-1)[0]??null }))
        .filter(x=>x.val!=null).sort((a,b)=>b.val-a.val);
      STATE.charts['pol-rank'] = new Chart(c2, {
        type:'bar',
        data:{ labels:ranked.map(r=>r.label),
               datasets:[{data:ranked.map(r=>r.val),
                 backgroundColor:hexToRgba(pol.color,0.75), borderRadius:4}] },
        options:{
          indexAxis:'y', responsive:true, maintainAspectRatio:false, animation:false,
          plugins:{legend:{display:false}},
          scales:{x:{ticks:{font:{size:9}}},y:{ticks:{font:{size:8},maxRotation:0}}}}
      });
    }

    // MiAGNN forecast per polutan — bar chart inside fixed-height wrapper
    const c3 = document.getElementById('chart-pol-forecast');
    if (c3) {
      const horizHours = D.model_forecasts_meta?.miagnn_horizon_hours || [1,2,3];
      const locs = D.locations.filter(l=>STATE.filteredLocs.includes(l.location_id));
      const currVals = locs.map(l=>l.pred_miagnn?.[pol.key]?.current).filter(v=>v!=null);
      const curr = currVals.length ? currVals.reduce((a,b)=>a+b,0)/currVals.length : null;
      const nat  = D.national_forecast_miagnn?.[pol.key] || [];
      const fcLabels = ['Terkini', ...horizHours.map(h=>`+${h}h`)];
      const fcData   = [curr, ...nat].map(v=>v!=null?+v.toFixed(2):null);
      STATE.charts['pol-forecast'] = new Chart(c3, {
        type:'bar',
        data:{ labels:fcLabels, datasets:[{
          label:`${pol.label} (${pol.unit})`,
          data:fcData,
          backgroundColor:[hexToRgba('#9ca3af',0.6),...nat.map(()=>hexToRgba(pol.color,0.8))],
          borderRadius:4 }] },
        options:{
          responsive:true, maintainAspectRatio:false, animation:false,
          plugins:{legend:{display:false}},
          scales:{x:{ticks:{font:{size:9}}},y:{ticks:{font:{size:9}}}}}
      });
    }
  }));
}
window.openPollutantModal = openPollutantModal;

// Daftar target kesehatan untuk tren (urutan = urutan chip)
const HEALTH_TREND_SERIES = [
  { key: 'resp_admissions_under5', color: '#06b6d4' },
  { key: 'resp_admissions_over60', color: '#10b981' },
  { key: 'asthma_emergency_cases', color: '#f97316' },
  { key: 'copd_admissions',        color: '#eab308' },
  { key: 'cvd',                    color: '#8b5cf6' },
];
const ACTIVE_HEALTH = new Set(HEALTH_TREND_SERIES.map(s => s.key));

function openLocationModal(locationId) {
  const D = STATE.data;
  const modal = document.getElementById('modal-location');
  if (!modal || !D) return;
  const loc = D.locations.find(l => l.location_id === locationId);
  if (!loc) return;

  document.getElementById('modal-loc-title').textContent = `${loc.kota} — ${loc.location_id}`;
  const _g = ppmLocSet().has(locationId) ? computeGasAqi(locationId).aqi : null;
  const aqiNow = _g != null ? Math.round(_g) : loc.aqi;
  const cat = getCategory(aqiNow, STATE.aqiScale);

  // Nilai terkini = data valid terakhir di health_trends
  const trend = D.health_trends?.[locationId] || {};
  const latest = key => {
    const arr = trend[key] || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null) return { v: arr[i], date: trend.dates?.[i] ?? '' };
    }
    return { v: null, date: '' };
  };
  const lastCase  = latest('resp');
  const lastDeath = latest('death');
  const qc = D.qc_latest?.[locationId] || null;

  document.getElementById('modal-loc-content').innerHTML = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <div class="card bg-gray-50 dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-400">AQI Terkini</div>
        <div class="text-2xl font-bold" style="color:${cat.color}">${aqiNow ?? 'N/A'}</div>
        <div class="text-xs">${cat.label}</div>
      </div>
      <div class="card bg-gray-50 dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-400">Kasus Terkini</div>
        <div class="text-2xl font-bold">${lastCase.v != null ? lastCase.v.toFixed(1) : '--'}</div>
        <div class="text-xs">Infeksi napas${lastCase.date ? ' · ' + lastCase.date : ''}</div>
      </div>
      <div class="card bg-gray-50 dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-400">Kematian Terkini</div>
        <div class="text-2xl font-bold">${lastDeath.v != null ? lastDeath.v.toFixed(2) : '--'}</div>
        <div class="text-xs">Per hari${lastDeath.date ? ' · ' + lastDeath.date : ''}</div>
      </div>
      <div class="card bg-gray-50 dark:bg-gray-800 p-3">
        <div class="text-xs text-gray-400">QC Flag</div>
        <div class="text-2xl font-bold" style="color:${qc ? (qc.valid ? '#16a34a' : '#dc2626') : 'inherit'}">
          ${qc ? String(qc.flag).toUpperCase() : '--'}
        </div>
        <div class="text-xs">${qc ? 'Per hari · ' + (qc.date || qc.ts.slice(0, 10)) : 'Data QC tidak tersedia'}</div>
      </div>
    </div>

    <div class="card bg-gray-50 dark:bg-gray-800 p-3 mb-3">
      <div class="text-xs font-semibold mb-2">Info Stasiun</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Provinsi</span>
          <span class="info-value">${loc.provinsi ?? '--'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Kecamatan</span>
          <span class="info-value">${loc.kecamatan ?? '--'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Tipe</span>
          <span class="info-value">${loc.site_type ?? '--'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Alat PM</span>
          <span class="info-value">${loc.pm25_equipment ?? '--'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Jarak Jalan</span>
          <span class="info-value">${loc.distance_road ?? '--'} m</span>
        </div>
        <div class="info-item">
          <span class="info-label">Baseline PM₂.₅</span>
          <span class="info-value">${loc.baseline_pm25 ?? '--'} µg/m³</span>
        </div>
      </div>
    </div>

    <div class="card bg-gray-50 dark:bg-gray-800 p-3 mb-4">
      <div class="text-xs font-semibold mb-2">Info Rumah Sakit</div>
      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">Nama</span>
          <span class="info-value">${loc.hospital_name ?? '--'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Kelas Faskes</span>
          <span class="info-value">${loc.hospital_kelas ?? '--'}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Kapasitas Tempat Tidur</span>
          <span class="info-value">${loc.hospital_beds ?? '--'}</span>
        </div>
      </div>
    </div>

    <div class="card bg-gray-50 dark:bg-gray-800 p-3">
      <div class="flex items-center justify-between flex-wrap gap-1 mb-2">
        <div class="text-xs font-semibold">Tren Penyakit</div>
        <div id="loc-health-range" class="text-xs text-gray-400"></div>
      </div>
      <div class="flex gap-3" style="min-height:200px;">
        <div id="loc-health-summary" class="flex flex-col gap-1"
             style="min-width:150px;max-width:170px;flex-shrink:0"></div>
        <div class="chart-fixed-h flex-1" style="min-height:200px;">
          <canvas id="chart-loc-health"></canvas>
        </div>
      </div>
    </div>`;

  modal.classList.remove('hidden');
  STATE.modalLocId = locationId;

  requestAnimationFrame(() => requestAnimationFrame(() => renderLocHealthTrend()));
}
window.openLocationModal = openLocationModal;

/** Tren penyakit di modal lokasi — mengikuti filter tanggal global. */
function renderLocHealthTrend() {
  const D = STATE.data;
  const lid = STATE.modalLocId;
  if (!D || !lid) return;
  const canvas = document.getElementById('chart-loc-health');
  if (!canvas) return;

  if (STATE.charts['loc-health']) { STATE.charts['loc-health'].destroy(); delete STATE.charts['loc-health']; }

  const trend = D.health_trends?.[lid];
  if (!trend?.dates?.length) {
    document.getElementById('loc-health-summary').innerHTML =
      '<div class="text-xs text-gray-400 italic">Data tren tidak tersedia.</div>';
    return;
  }

  // Potong sesuai rentang waktu filter
  const { dates: slicedDates } = sliceSparkline(trend.dates, trend.dates);
  const longRange = slicedDates.length > 60;
  const labels = slicedDates.map(d => longRange ? d.slice(0, 7) : d.slice(5));

  const rangeEl = document.getElementById('loc-health-range');
  if (rangeEl && slicedDates.length) {
    rangeEl.textContent = `${slicedDates[0]} → ${slicedDates[slicedDates.length - 1]}`;
  }

  const meanOf = arr => {
    const v = arr.filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  // Chip rata-rata (klik untuk tampil/sembunyi garis)
  document.getElementById('loc-health-summary').innerHTML = HEALTH_TREND_SERIES.map(s => {
    const { values } = sliceSparkline(trend.dates, trend[s.key] || []);
    const m = meanOf(values);
    const on = ACTIVE_HEALTH.has(s.key);
    return `<div class="pol-avg-row" data-health="${s.key}"
      style="border-left:3px solid ${s.color};opacity:${on ? 1 : 0.3};cursor:pointer"
      title="Klik untuk ${on ? 'sembunyikan' : 'tampilkan'} di grafik">
      <span class="pol-avg-row-label" style="color:${s.color}">${HEALTH_TARGETS_LABEL[s.key] || s.key}</span>
      <span class="pol-avg-row-val">${m != null ? m.toFixed(2) : '--'} <span class="pol-avg-row-unit">/hari</span></span>
    </div>`;
  }).join('');

  const datasets = HEALTH_TREND_SERIES
    .filter(s => ACTIVE_HEALTH.has(s.key))
    .map(s => {
      const { values } = sliceSparkline(trend.dates, trend[s.key] || []);
      return {
        label: HEALTH_TARGETS_LABEL[s.key] || s.key,
        data: values.map(v => v ?? null),
        borderColor: s.color,
        backgroundColor: hexToRgba(s.color, 0.07),
        borderWidth: s.key === 'death' ? 2.2 : 1.8,
        pointRadius: labels.length <= 15 ? 3 : 0,
        tension: 0.4,
        fill: false,
        spanGaps: true,
      };
    });

  STATE.charts['loc-health'] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: items => slicedDates[items[0]?.dataIndex] || '' } }
      },
      scales: {
        x: { ticks: { font: { size: 8 }, maxTicksLimit: longRange ? 20 : 12, maxRotation: longRange ? 30 : 0 } },
        y: { ticks: { font: { size: 9 } }, title: { display: true, text: 'Kasus / Kematian per hari', font: { size: 9 } } }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// E — MODEL METRICS FOOTER
// ═══════════════════════════════════════════════════════════════════════════
function renderModelsFooter() {
  const D = STATE.data; if (!D) return;
  renderMetricsTable('metrics-model-a', D.models?.RA_STGNN?.model_A?.metrics||[], ['target','mae','rmse','mape','r2']);
  renderMetricsTable('metrics-model-b', D.models?.RA_STGNN?.model_B?.metrics||[], ['target','mae','rmse','mape','r2']);
  renderMetricsTable('metrics-miagnn-imp', D.models?.MiAGNN?.imputation_metrics||[], ['model','pattern','n_eval','MAE','RMSE']);
  renderMetricsTable('metrics-miagnn-fore', D.models?.MiAGNN?.forecast_metrics||[], ['model','horizon','MAE','RMSE','MAPE']);
}

function renderMetricsTable(containerId, rows, cols) {
  const el = document.getElementById(containerId); if (!el||!rows.length) return;
  el.innerHTML = `<div class="metrics-table"><table>
    <thead><tr>${cols.map(c=>`<th>${c.toUpperCase()}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row=>`<tr>${cols.map(c=>{
      const v = row[c];
      return `<td>${typeof v==='number'?(v>10?v.toFixed(2):v.toFixed(4)):(v??'--')}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════
function setElText(id, v) { const e=document.getElementById(id); if(e) e.textContent=v??'--'; }
function setElStyle(id, prop, val) { const e=document.getElementById(id); if(e) e.style[prop]=val; }
