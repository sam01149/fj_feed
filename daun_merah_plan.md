# Daun Merah — Rencana Pengembangan

*Terakhir diupdate: 2026-05-08 (sesi 2)*

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

## Economic Fundamental Tracker (belum diimplementasi)

### Tujuan
Auto-parse headline econ data dari RSS → hitung Economic Surprise Score per currency → tampilkan 3 terkuat / 3 terlemah.

### Cara Kerja
1. **Parse headline** (regex, tanpa AI) — format FJ: `{Indicator} Actual {value} (Forecast {value}, Previous {value})`
2. **Map ke currency** — contoh: `German` → EUR, `UK` → GBP, `Japan/Japanese` → JPY, `Swiss` → CHF, `Canada/Canadian` → CAD, `Australia/Australian` → AUD, `New Zealand` → NZD, tanpa prefix = USD
3. **Hitung skor** — beat (+1) / miss (-1) / in-line (0), weight: High impact ×2 / Medium ×1, direction-aware per indikator (misalnya Unemployment Rate: actual < forecast = bagus = beat)
4. **Rolling window** — 4–6 minggu, data lama di-expire
5. **Simpan Redis** — `econ_scores` hash: `{ USD: 12, EUR: -4, ... }` + `econ_events` list per currency

### Indikator yang Ditrack
Hanya FF medium + high impact. Fokus pada yang paling sering muncul:
- **USD:** NFP, CPI, Unemployment Rate, Retail Sales, GDP, PMI, FOMC, Jobless Claims, PPI, ISM
- **EUR:** CPI Flash, GDP, PMI, Unemployment, ZEW/IFO, ECB
- **GBP:** CPI, GDP, PMI, Employment, BOE
- **JPY:** CPI, GDP, Tankan, BOJ, Trade Balance
- **CAD:** Employment, CPI, BOC, GDP, Retail Sales
- **AUD:** Employment, CPI, RBA, GDP, Retail Sales
- **NZD:** Employment, CPI, RBNZ, GDP
- **CHF:** CPI, GDP, SNB, KOF

### Tampilan UI
- Kartu di tab baru atau embed di RINGKASAN
- Dua kolom: **Terkuat** (hijau, 3 teratas) | **Terlemah** (merah, 3 terbawah)
- Skor ditampilkan, tooltip breakdown per indikator
- Label: "Fundamental Score (4 minggu terakhir)"

### Constraint
- Tidak perlu API function baru — parse bisa dilakukan di dalam market-digest.js (saat fetch RSS) atau cron terpisah via existing function
- Vercel 12-function limit: tidak boleh tambah function baru tanpa hapus yang lain

**Status:** Disetujui — belum diimplementasi.

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
- **Lokasi:** Di tab CAL (bagian paling atas, sebelum tabel kalender) + opsional badge kecil di tab header
- **Format:** `⏱ EUR CPI Flash · 1j 22m` (nama event + countdown)
- **Warning state:** warna merah jika < 30 menit, animasi pulse
- Jika tidak ada event high-impact dalam 24 jam ke depan: sembunyikan komponen

### Constraint
- Pure frontend — tidak perlu API baru, cukup gunakan data kalender yang sudah di-fetch
- Tidak ada Redis write tambahan
- Harus handle kasus `time_wib = 'Tentative'` (skip event tersebut)

**Status:** ✅ Diimplementasi. Kartu countdown di atas kalender + badge '!' merah di tab header CAL saat event dalam 30 menit.
