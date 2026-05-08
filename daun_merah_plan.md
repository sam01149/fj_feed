# Daun Merah — Rencana Pengembangan

*Terakhir diupdate: 2026-05-08 (sesi 3)*

---

## AI Provider Restructure ✅ (diimplementasi 2026-05-08)

### Multi-provider split
| Call | Provider | Model | Tugas |
|------|----------|-------|-------|
| Call 1 | **Cerebras** | Llama 4 Scout | Briefing prose Bahasa Indonesia |
| Call 2 & 3 | **SambaNova** | DeepSeek-V3 | CB bias JSON + Trade thesis JSON |
| Call 4 (baru) | **Groq** | llama-3.3-70b-versatile | Thesis Invalidation Monitor |

Groq juga sebagai **fallback** semua call jika Cerebras/SambaNova kena 429.

### Token budget (per request ~7000 token)
- Cerebras: 1M token/hari → ~142 full request/hari (2× lebih longgar dari Groq)
- SambaNova: rate-limited/menit → perlu tes sebelum implementasi
- Groq: freed up, dipakai Call 4 saja

### Call 4 — Thesis Invalidation Monitor
Scan headlines masuk terhadap `thesis_text` open journal entries di Redis.
Deteksi kontradiksi semantik (AI-dependent) → push notifikasi ke user.

**Contoh:** User tulis "USD data bagus, SHORT EUR/USD" → headline masuk "US jobless claims surge" → Groq deteksi kontradiksi → push notif "⚠️ Basis USD kamu mungkin melemah".

Input: open journal entries (`thesis_text` + `pair` + `direction`) + batch headlines terbaru dari `news_history`.

**Status:** ✅ Diimplementasi. Call 4 berjalan saat user generate dengan device_id — hasil ditampilkan sebagai Thesis Alert card di atas artikel.

### Env vars yang perlu ditambahkan di Vercel
- `CEREBRAS_API_KEY` — dari https://cloud.cerebras.ai
- `SAMBANOVA_API_KEY` — dari https://cloud.sambanova.ai

---

## XAU/USD di Journal ✅ (diimplementasi 2026-05-08)

Tambah `XAU/USD` ke array `SZ_PAIRS` di index.html — pair ini dipakai oleh selector di tab JURNAL dan SIZING.

---

## Countdown Timer Event Berikutnya ✅ (diimplementasi 2026-05-08)

### Tujuan
Tampilkan countdown ke high-impact economic event terdekat agar trader tidak tertangkap posisi saat rilis data.

### Cara Kerja
- Baca data kalender dari endpoint `/api/calendar` yang sudah ada (Redis-cached)
- Filter event `impact: 'High'` saja
- Cari event terdekat dari sekarang (waktu WIB)
- Hitung selisih waktu → format: `2j 34m` atau `47m` atau `< 5 menit ⚠️`
- Update countdown setiap 30 detik (setInterval di frontend)

### Tampilan UI
- **Lokasi:** Di tab CAL (bagian paling atas, sebelum tabel kalender) + badge kecil di tab header
- **Format:** `⏱ EUR CPI Flash · 1j 22m` (nama event + countdown)
- **Warning state:** warna merah jika < 30 menit, animasi pulse
- Jika tidak ada event high-impact dalam 24 jam ke depan: sembunyikan komponen

### Constraint
- Pure frontend — tidak perlu API baru, cukup gunakan data kalender yang sudah di-fetch
- Tidak ada Redis write tambahan
- Handle kasus `time_wib = 'Tentative'` (skip event tersebut)

**Status:** ✅ Diimplementasi. Kartu countdown di atas kalender + badge '!' merah di tab header CAL saat event dalam 30 menit.

---

## Economic Fundamental Tracker ✅ (diimplementasi 2026-05-08)

### Tujuan
Dua tujuan utama:
1. **Tampilkan data fundamental terbaru** per currency (GDP, CPI, dll) dengan nilai aktual — diperbarui otomatis dari headline RSS masuk
2. **AI menyimpulkan currency terkuat/terlemah** dari data fundamental yang ada, ditampilkan sebagai analisis di tab FUNDAMENTAL
3. **Bonus:** Auto-detect keputusan suku bunga dari headline → update CB rate di Redis otomatis (tidak perlu edit manual lagi)

---

### Sub-fitur A — Fundamental Data Store & Display

#### Indikator yang Ditrack (FF Medium/High impact)

| Currency | Indikator | FF Impact |
|----------|-----------|-----------|
| **USD** | CPI YoY | HIGH |
| | Core CPI MoM | HIGH |
| | NFP (Non-Farm Payrolls) | HIGH |
| | Unemployment Rate | HIGH |
| | GDP QoQ | HIGH |
| | Core PCE Price Index | HIGH |
| | Jobless Claims | HIGH |
| | Retail Sales MoM | MEDIUM |
| | ISM Manufacturing PMI | MEDIUM |
| | ISM Services PMI | MEDIUM |
| | PPI MoM | MEDIUM |
| **EUR** | CPI Flash YoY | HIGH |
| | German CPI YoY | HIGH |
| | GDP QoQ Flash | HIGH |
| | ECB Rate Decision | HIGH |
| | Manufacturing PMI | MEDIUM |
| | Services PMI | MEDIUM |
| | Unemployment Rate | MEDIUM |
| | ZEW Economic Sentiment | MEDIUM |
| | German IFO Business Climate | MEDIUM |
| | Retail Sales MoM | MEDIUM |
| **GBP** | CPI YoY | HIGH |
| | GDP MoM/QoQ | HIGH |
| | BOE Rate Decision | HIGH |
| | Manufacturing PMI | MEDIUM |
| | Services PMI | MEDIUM |
| | Employment Change | MEDIUM |
| | Claimant Count Change | MEDIUM |
| | Retail Sales MoM | MEDIUM |
| **JPY** | CPI YoY | HIGH |
| | GDP QoQ | HIGH |
| | BOJ Rate Decision | HIGH |
| | Tankan Manufacturing Index | MEDIUM |
| | Unemployment Rate | MEDIUM |
| | Retail Sales YoY | MEDIUM |
| | Industrial Production MoM | MEDIUM |
| | Trade Balance | MEDIUM |
| **CAD** | CPI MoM/YoY | HIGH |
| | BOC Rate Decision | HIGH |
| | Employment Change | MEDIUM |
| | Unemployment Rate | MEDIUM |
| | GDP MoM | MEDIUM |
| | Retail Sales MoM | MEDIUM |
| | Trade Balance | MEDIUM |
| | Ivey PMI | MEDIUM |
| **AUD** | Employment Change | HIGH |
| | CPI QoQ | HIGH |
| | GDP QoQ | HIGH |
| | RBA Rate Decision | HIGH |
| | Unemployment Rate | MEDIUM |
| | Retail Sales MoM | MEDIUM |
| | Trade Balance | MEDIUM |
| | NAB Business Confidence | MEDIUM |
| **NZD** | CPI QoQ | HIGH |
| | GDP QoQ | HIGH |
| | RBNZ Rate Decision | HIGH |
| | Employment Change | MEDIUM |
| | Unemployment Rate | MEDIUM |
| | Trade Balance | MEDIUM |
| **CHF** | GDP QoQ | HIGH |
| | SNB Rate Decision | HIGH |
| | CPI MoM/YoY | MEDIUM |
| | KOF Economic Barometer | MEDIUM |

#### Struktur Redis

```
fundamental:{currency}     → Redis Hash
  key = indicator name (e.g. "CPI YoY")
  value = JSON string: { actual, period, date, source }

  Contoh:
  HSET fundamental:USD "CPI YoY" '{"actual":"2.4%","period":"Apr 2026","date":"2026-05-13","source":"headline"}'
  HSET fundamental:USD "NFP"     '{"actual":"177K","period":"Apr 2026","date":"2026-05-02","source":"seed"}'
```

Field `source`: `"seed"` (data awal manual) atau `"headline"` (auto-parse dari RSS).

#### Seed Data (diisi manual satu kali)

Data permulaan dari Trading Economics yang diberikan user:

```
USD: CPI YoY 3.3% | Core CPI MoM 0.2% | NFP 178K | Unemployment 4.3% | GDP QoQ 2% | Core PCE 0.3% | Jobless Claims 200K | Retail Sales MoM 1.7% | ISM Manufacturing 54.5 | ISM Services 51 | PPI MoM 0.2%
EUR: CPI Flash YoY 3% | German CPI YoY 2.9% | GDP QoQ 0.1% | ECB Rate 2.15% | Manufacturing PMI 52.2 | Services PMI 47.6 | Unemployment 6.2% | ZEW -17.2 | IFO 84.4 | Retail Sales -0.1%
GBP: CPI YoY 3.3% | GDP MoM 0.1% | BOE Rate 3.75% | Manufacturing PMI 53.7 | Services PMI 52.7 | Employment Change 25K | Claimant Count 26.8K | Retail Sales MoM 0.7%
JPY: CPI YoY 1.5% | GDP QoQ 0.3% | BOJ Rate 0.75% | Tankan 17 | Unemployment 2.7% | Retail Sales YoY 1.7% | Industrial Production -0.5% | Trade Balance 667B JPY
CAD: CPI YoY 2.4% | BOC Rate 2.25% | Employment Change 14.1K | Unemployment 6.7% | GDP MoM 0.2% | Retail Sales MoM 0.6% | Trade Balance 1780M CAD | Ivey PMI 57.7
AUD: Employment Change 17.9K | CPI QoQ 0.6% | GDP QoQ 0.8% | RBA Rate 4.35% | Unemployment 4.3% | Retail Sales MoM 0.2% | Trade Balance -1841M AUD | NAB Confidence -29
NZD: CPI QoQ 0.6% | GDP QoQ 0.2% | RBNZ Rate 2.25% | Employment Change 0.2% | Unemployment 5.3% | Trade Balance 698M NZD
CHF: GDP QoQ 0.2% | SNB Rate 0% | CPI YoY 0.6% | KOF 97.9
```

Seed dimasukkan via script atau action `?action=fundamental_seed` di `admin.js` — dijalankan sekali saat deploy.

---

### Sub-fitur B — Auto-parse Headline → Update Fundamental Data

#### Cara Kerja

Di `market-digest.js` (cron, sudah ada), saat fetch RSS headline masuk:

1. **Loop setiap headline baru** yang belum pernah diproses
2. **Regex match** pattern Forex Factory: `{Prefix} {Indicator} {m/m|q/q|y/y} {actual} ({forecast}, {previous})`
   - Contoh headline FF: `"US CPI m/m 0.2% (0.3% forecast, 0.1% prev)"`
   - Atau: `"German CPI y/y 2.9% (3.0% forecast)"`
3. **Map prefix ke currency:**
   - `US / American` → USD
   - `German / Germany / EZ / Eurozone / Euro` → EUR
   - `UK / British` → GBP
   - `Japanese / Japan / JN` → JPY
   - `Canadian / Canada` → CAD
   - `Australian / Australia / AU` → AUD
   - `New Zealand / NZ` → NZD
   - `Swiss / Switzerland / SZ` → CHF
4. **Map nama indikator** ke key yang dikenal (lookup table)
5. **HSET** `fundamental:{currency}` dengan nilai baru
6. **Detect CB rate change** (lihat Sub-fitur C)

#### Lookup Table Indikator (contoh)
```
"cpi m/m" | "cpi mom" | "consumer price index m/m" → "CPI MoM"
"cpi y/y" | "cpi yoy" → "CPI YoY"
"non-farm" | "nfp" | "employment change" (USD) → "NFP"
"unemployment rate" → "Unemployment Rate"
"gdp q/q" | "gdp qq" → "GDP QoQ"
"retail sales m/m" → "Retail Sales MoM"
"ism manufacturing" → "ISM Manufacturing PMI"
"ism services" → "ISM Services PMI"
"jobless claims" | "unemployment claims" → "Jobless Claims"
"ppi m/m" → "PPI MoM"
"core pce" → "Core PCE Price Index"
... dst
```

---

### Sub-fitur C — Auto-update CB Rate dari Headline

#### Tujuan
Jika headline masuk mengandung keputusan suku bunga (rate decision), otomatis overwrite `cb_status` di Redis → CB Tracker di tab CAL terupdate tanpa edit manual.

#### Pattern Deteksi
Regex scan setiap headline untuk pola:
```
"Fed (cuts|raises|holds) rates? (by )?(\d+\.?\d*)%?"
"ECB (cuts|raises|holds|leaves) (rate|rates) (at|by|unchanged) (\d+\.?\d*)%?"
"BOE (cuts|raises|holds) base rate (to|by) (\d+\.?\d*)%?"
"BOJ (raises|cuts|holds|keeps) (rate|policy rate) (at|to|by) (\d+\.?\d*)%?"
"RBA (cuts|raises|holds) (cash rate|rate) (to|by) (\d+\.?\d*)%?"
"RBNZ (cuts|raises|holds) (OCR|rate) (to|by) (\d+\.?\d*)%?"
"BOC (cuts|raises|holds) (rate|overnight rate) (to|by) (\d+\.?\d*)%?"
"SNB (cuts|raises|holds|keeps) (policy rate|rate) (at|to|by) (\d+\.?\d*)%?"
```

#### Mapping ke Redis
Deteksi → parse bps change atau nilai absolut → `HSET cb_status:{currency} rate {value}`

Contoh: `"ECB cuts rates by 25bps"` → EUR rate lama 2.40% - 0.25% = 2.15% → overwrite.

**Catatan:** Kalau headline bilang nilai absolut (`"at 4.50%"`), pakai langsung. Kalau bps (`"by 25bps"`), hitung dari nilai sebelumnya di Redis.

---

### Sub-fitur D — Tab FUNDAMENTAL & AI Analysis

#### Lokasi UI
Tab baru **FUNDAMENTAL** di nav bar, antara COT dan CHECKLIST.
Nav bar baru: `NEWS | RINGKASAN | CAL | COT | FUNDAMENTAL | CHECKLIST | SIZING | JURNAL | PETUNJUK`

#### Layout Tab FUNDAMENTAL

```
┌─────────────────────────────────────────────┐
│  FUNDAMENTAL DATA                [Refresh]  │
│  Last updated: 5 menit lalu                 │
├─────────────────────────────────────────────┤
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐  │
│  │  USD  │ │  EUR  │ │  GBP  │ │  JPY  │  │
│  │ CPI   │ │ CPI   │ │ CPI   │ │ CPI   │  │
│  │ 3.3%  │ │ 3.0%  │ │ 3.3%  │ │ 1.5%  │  │
│  │ NFP   │ │ GDP   │ │ GDP   │ │ GDP   │  │
│  │ 178K  │ │ 0.1%  │ │ 0.1%  │ │ 0.3%  │  │
│  │ ...   │ │ ...   │ │ ...   │ │ ...   │  │
│  └───────┘ └───────┘ └───────┘ └───────┘  │
│  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐  │
│  │  CAD  │ │  AUD  │ │  NZD  │ │  CHF  │  │
│  │ ...   │ │ ...   │ │ ...   │ │ ...   │  │
│  └───────┘ └───────┘ └───────┘ └───────┘  │
├─────────────────────────────────────────────┤
│  [Analisis AI — Currency Terkuat/Terlemah]  │
│                                             │
│  ● USD — Terkuat: data NFP kuat, CPI...    │
│  ● EUR — Terlemah: GDP lemah, PMI...       │
│  ...                                        │
│  Diperbarui: 2 jam lalu  [Generate Ulang]  │
└─────────────────────────────────────────────┘
```

#### Kartu per Currency
Setiap currency = kartu dengan:
- Header: nama currency + rate suku bunga (dari `cb_status`)
- Baris per indikator: nama indikator | nilai aktual | periode
- Indikator kosong (belum ada data) ditampilkan sebagai `—`
- Warna rate: hijau (hawkish range) / merah (dovish range) — tidak ada value judgment, hanya display

#### AI Analysis
- Provider: **Groq** `llama-3.3-70b-versatile` (model yang sudah ada, tidak tambah env baru)
- Input: semua data fundamental yang ada di Redis per currency
- Output: paragraf analisis + ranking currency dari terkuat ke terlemah dari sisi fundamental
- Cache: hasil simpan di Redis `fundamental_analysis` dengan TTL 6 jam
- Tombol: **"Analisis Fundamental"** — user trigger manual (bukan auto)
- Cooldown: 6 jam (sama seperti Ringkasan)

#### Prompt ke AI (sketch)
```
Kamu adalah analis forex makro. Berikut data fundamental terbaru per currency:

USD: CPI YoY 3.3%, NFP 178K, Unemployment 4.3%, GDP 2%, ...
EUR: CPI Flash 3%, GDP 0.1%, PMI Mfg 52.2, PMI Svc 47.6, ...
[... semua currency ...]

Berikan analisis: currency mana yang paling kuat dan paling lemah dari sisi fundamental?
Pertimbangkan: tingkat inflasi vs target CB, kekuatan pasar kerja, pertumbuhan GDP, dan arah kebijakan moneter.
Jawab dalam Bahasa Indonesia, singkat dan actionable untuk trader forex.
Format: ranking + alasan singkat per currency.
```

---

### API — Endpoint (numpang admin.js, tidak tambah function baru)

```
GET  /api/admin?action=fundamental_get
     → return semua data fundamental per currency dari Redis

POST /api/admin?action=fundamental_seed
     → seed data awal (dijalankan sekali, body: JSON seed data)

GET  /api/admin?action=fundamental_analysis
     → return cached AI analysis (atau generate baru jika expired)
```

---

### Alur Implementasi

1. **Redis seed** — tambah `?action=fundamental_seed` ke `admin.js`, jalankan sekali dengan data user
2. **Auto-parse di market-digest.js** — tambah loop regex scan headline baru → HSET fundamental + deteksi CB rate
3. **Frontend tab FUNDAMENTAL** — tambah tab nav, panel HTML, CSS kartu, fetch + render data
4. **AI analysis** — tambah call ke Groq di `admin.js?action=fundamental_analysis`, tombol + render di frontend

### Constraint
- Tidak tambah function baru (numpang `admin.js` dan `market-digest.js`)
- Vercel 12-function limit tetap terjaga
- Tidak ada npm dependency baru
- Mobile-first — kartu 2×4 grid di mobile (2 kolom, 4 baris)
- Cache fundamental_analysis di Redis TTL 6 jam
- Fundamental data per indikator tidak expire — overwrite saja saat ada data baru

**Status:** ✅ Diimplementasi. Tab FUNDAMENTAL aktif. Seed data via POST /api/admin?action=fundamental_seed (sekali setelah deploy).

---
