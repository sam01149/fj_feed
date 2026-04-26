# Daun Merah — Project Context (Full Handoff)

> **Last updated:** 2026-04-26  
> **Branch:** main — semua task selesai dan di-push ke origin  
> **Working directory:** `c:\Users\sam\Downloads\Financial_Feed_App`

---

## Ringkasan Proyek

Daun Merah adalah forex news PWA (Progressive Web App) untuk trader forex Indonesia bergaya macro discretionary. Sebelumnya bernama FJFeed. Di-deploy di Vercel, single-file frontend (`index.html`) + beberapa Vercel Serverless Functions di folder `api/`.

**Deployment target:** Vercel + Upstash Redis REST API  
**Production URL:** financial-feed-app.vercel.app (atau domain Vercel yang dikonfigurasi)

---

## Stack Teknis

| Layer | Teknologi |
|-------|-----------|
| Frontend | Vanilla JS + HTML/CSS, single file `index.html` (~3000+ baris) |
| Backend | Vercel Serverless Functions (Node.js, CommonJS `module.exports`) |
| AI | Groq API — model `llama-3.3-70b-versatile` |
| Cache/DB | Upstash Redis REST API |
| RSS sumber berita | FinancialJuice (`https://www.financialjuice.com/feed.ashx?xy=rss`) |
| Kalender ekonomi | ForexFactory XML (`nfs.faireconomy.media`) |
| COT data | CFTC website scraping (`cftc.gov`) |
| Font | Syne (heading), DM Mono (body) |
| PWA | `manifest.json` dengan inline SVG icon DM merah |

**Env vars yang dibutuhkan (di Vercel):**
- `GROQ_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `FRED_API_KEY` ← ditambahkan untuk Task 1 (Risk Regime)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (Web Push)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (opsional)
- `CRON_SECRET` (untuk `/api/push` cron)

---

## Struktur File

```
Financial_Feed_App/
├── index.html              # Seluruh UI + JS frontend (~3000+ baris)
├── manifest.json           # PWA manifest
├── sw.js                   # Service Worker
├── vercel.json             # Security headers config
├── package.json            # name: "daun-merah", deps: web-push
└── api/
    ├── rss.js              # RSS proxy — Redis cache rss_cache TTL 60s
    ├── calendar.js         # ForexFactory calendar
    ├── cb-status.js        # CB tracker (static rates + Redis bias)
    ├── cot.js              # CFTC COT scraper — robustness Task 10b
    ├── fundamentals.js     # Fundamental snapshot (ada, tidak ada tab)
    ├── market-digest.js    # AI briefing (3 Groq calls: digest, bias, thesis)
    ├── push.js             # Web push — branding Daun Merah
    ├── subscribe.js        # Push subscription management
    ├── risk-regime.js      # Task 1 — VIX/MOVE/HY classifier
    ├── real-yields.js      # Task 2 — Real yield differential
    ├── rate-path.js        # Task 3 — SOFR heuristic rate path
    ├── sizing-history.js   # Task 4 — Position sizing history
    ├── journal.js          # Task 5 — Trade journal CRUD
    ├── correlations.js     # Task 9 — Cross-asset correlation (Stooq)
    ├── admin-prompts.js    # Task 10e — Admin endpoint Groq prompts
    └── package.json
```

---

## Desain UI / Color System

```css
:root {
  --bg: #0a0a08;        /* latar belakang utama */
  --surface: #111110;   /* card/nav surface */
  --border: #222220;
  --accent: #c0392b;    /* merah daun merah */
  --accent-dim: #7a1f17;
  --gate: #8b1a1a;
  --text: #e8e4d9;
  --muted: #6b6860;
  --text-mid: #a8a49a;
  --green: #27ae60;
  --green-dim: #1a5e38;
  --red: #c0392b;
  --yellow: #e67e22;
  --orange: #e67e22;
  --purple: #a78bfa;
  --pink: #f472b6;
}
```

Font: **Syne** (logo/heading), **DM Mono** (semua teks lainnya)

---

## Navigasi — Dua Baris

**Primary views** (`.nav-views`, `.nvtab`):

| Tab | `data-view` | Warna |
|-----|-------------|-------|
| NEWS | `feed` | `--accent` (merah) |
| RINGKASAN | `ringkasan` | `--accent` (merah) |
| CAL | `cal` | `--green` |
| COT | `cot` | `--purple` |
| CHECKLIST | `checklist` | `--yellow` |
| SIZING | `sizing` | `--green` |
| JURNAL | `jurnal` | `--pink` (#f472b6) |

**Secondary filters** (`.nav-filters`, `.ftab`) — hanya muncul di view NEWS:  
All, Macro, Forex, Energy, Geopolitical, Econ-Data, Equities, Commodities, Bonds, Market-Moving

**Toolbar** (refresh + auto-refresh toggle + countdown) — hanya muncul di view NEWS.

---

## Layout HTML (urutan dari atas ke bawah)

```
<header>              — logo + status pill + notif btn
<div.install-banner>  — PWA install prompt (hidden by default)
<div#regimeBanner>    — [NEW - Task 1] Risk Regime banner, selalu visible
<div.stats-bar>       — news category counts (Total, Mkt Moving, Forex, dll)
<div.nav-views>       — primary tab bar
<div.nav-filters>     — category filters (NEWS only)
<div.toolbar>         — last update + AUTO toggle + FETCH btn (NEWS only)
<div.content>         — semua panel (feed/ringkasan/cal/cot/checklist)
```

---

## Fungsi JS Kunci

```javascript
setFeedUI(show)       // toggle toolbar + navFilters visibility
hideAllPanels()       // hide semua panel sebelum show yang dipilih
fetchFeed()           // fetch /api/rss, parse, render news feed
fetchRegime()         // [NEW] fetch /api/risk-regime, update banner
renderRegimeBanner()  // [NEW] update DOM banner berdasarkan data regime
toggleRegimeDetail()  // [NEW] expand/collapse breakdown komponen
```

---

## Panel-Panel

### 1. NEWS (`feedScroll`)
Feed berita real-time dari FinancialJuice RSS. Setiap item bisa diklik untuk buka link. Dikategorikan otomatis (`detectCat()`). Bisa difilter by kategori.

### 2. RINGKASAN (`ringkasanPanel`)
- **AI Market Briefing** — teks analisis dari Groq berdasarkan 80 headline terbaru 12 jam, event kalender, dan riwayat digest sebelumnya. Disimpan ke Redis `digest_history` (max 7 entri).
- **CB Tracker** — 8 grid card untuk USD/EUR/GBP/JPY/CAD/AUD/NZD/CHF. Setiap card: interest rate, last decision (hike/cut/hold + bps), bias label berwarna, confidence dot (glowing colored dot), timestamp terakhir diperbarui.

### 3. CAL (`calPanel`)
Event ekonomi high-impact 3 hari ke depan (WIB), dari ForexFactory XML. Hanya 8 major currencies.

### 4. COT (`cotPanel`)
CFTC COT data — Leveraged Funds dan Asset Manager net positions untuk 7 pasang mata uang. Cache Redis 6 jam (`cot_cache_v2`).

### 5. CHECKLIST (`checklistPanel`)
Trading discipline checklist sebelum entry. 4 playbook tersedia: SMC/ICT, Macro Momentum, Event-Driven, Mean Reversion. Setiap playbook punya CK_SECTIONS/QUICK/GATES sendiri, dimulai dengan section REGIME CHECK (5 item dengan auto-tick dari data live). Playbook dipilih via `<select id="ckPlaybookSelector">`, persisted ke localStorage `daun_merah_playbook`. Pair selector memicu auto-tick. State per-playbook di localStorage key `daunmerah_v2`.

### 6. SIZING (`sizingPanel`)
Position sizing calculator. Input: equity, risk%, pair, stop pips, entry price. Output: lot size, dollar risk, R-multiple table. Hard block risk% > 2%. History dari Redis via `api/sizing-history.js`.

### 7. JURNAL (`jurnalPanel`)
Trade journal. List/new/detail/close views. Auto-snapshot regime + CB bias + real yield saat entry. Dapat di-prefill dari AI thesis. Data di Redis via `api/journal.js`.

---

## API Endpoints

### `GET /api/rss`
Proxy RSS FinancialJuice. Cache in-memory 50 detik. Fallback ke stale cache kalau upstream gagal. Header `X-Cache: HIT/MISS/STALE`.

> **Kenapa ada:** Vercel server IPs diblokir FinancialJuice kalau fetch langsung dari `market-digest.js`. Fix: `market-digest.js` fetch ke internal `/api/rss` yang pakai user-agent rotation dan cache.

### `POST /api/market-digest`
Main AI endpoint. Flow:
1. Load `prompt_digest` dari Redis (fallback ke hardcoded `DIGEST_INSTR_DEFAULT`)
2. Fetch RSS via internal `/api/rss`
3. Fetch ForexFactory kalender (this week + next week)
4. Load `digest_history` dari Redis
5. **Groq Call 1:** Market briefing (bahasa Indonesia, analis senior)
6. Save digest ke `digest_history` (Redis, max 7 entri)
7. **Groq Call 2:** CB Bias Assessment — JSON `{bias, confidence}` per currency
8. Merge + save ke Redis key `cb_bias`
9. **Groq Call 3:** Structured thesis JSON — `{dominant_regime, strongest_currency, weakest_currency, pair_recommendation, direction, confidence_1_to_5, invalidation_condition, time_horizon_days, catalyst_dependency}`
10. Validasi strict, retry sekali on malformed, save ke `latest_thesis` TTL 21600s
11. Return: `{article, method, news_count, cal_count, bias_updated, generated_at, thesis}`

Groq model: `llama-3.3-70b-versatile`, temperature 0.3 (briefing) / 0.1 (bias + thesis)

CB Bias values yang valid: `Hawkish`, `Cautious Hawkish`, `Neutral`, `Data Dependent`, `On Hold`, `Cautious Dovish`, `Dovish`, `Split`  
Confidence values: `High`, `Medium`, `Low`

### `GET /api/cb-status`
Return static CB data (rates, last meeting, last decision) merged dengan bias dari Redis.

**CB_DATA rates (update manual setelah meeting):**

| CB | Rate | Last Meeting | Decision |
|----|------|-------------|----------|
| Fed | 4.50% | 2026-03-19 | hold |
| ECB | 2.40% | 2026-03-06 | cut -25bps |
| BOE | 4.50% | 2026-02-06 | cut -25bps |
| BOJ | 0.50% | 2026-03-19 | hold |
| BOC | 2.75% | 2026-03-12 | hold |
| RBA | 4.10% | 2026-02-18 | cut -25bps |
| RBNZ | 3.50% | 2026-02-19 | cut -50bps |
| SNB | 0.25% | 2026-03-20 | cut -25bps |

### `GET /api/cot`
Scrape CFTC, parse Leveraged Funds + Asset Manager positions. Redis cache `cot_cache_v2` TTL 6 jam.

### `GET /api/calendar`
ForexFactory XML parser, return high-impact events next 5 days (WIB).

### `GET /api/real-yields` (Task 2)
Real yield differential. USD: DGS10 minus T10YIE dari FRED. 7 currencies lain: hardcoded inflation expectations + nominal 10Y yield dari FRED/Stooq. Cache `real_yields` TTL 21600s.

### `GET /api/rate-path` (Task 3)
USD rate path approximation. Source: FRED SOFR/EFFR + heuristic probability model (BUKAN CME FedWatch). FOMC dates hardcoded 2026. Cache `rate_path` TTL 14400s.

### `POST /api/sizing-history` / `GET /api/sizing-history?device_id=...` (Task 4)
Simpan/ambil history sizing calculation per device. Redis sorted set `sizing_history:{device_id}`, max 10 entries.

### `POST /api/journal` / `PATCH /api/journal?id=...` / `GET /api/journal?device_id=...` / `DELETE /api/journal?id=...` (Task 5)
Trade journal CRUD. Soft-delete (status → 'archived'). Redis: `journal:{device_id}:{id}` + `journal_index:{device_id}`.

### `GET /api/correlations` (Task 9)
Cross-asset Pearson correlation 20d dan 60d untuk 10 instrumen dari Stooq. On-demand via button, tidak auto-fetch. Cache `correlations` TTL 86400s.

### `GET/POST/DELETE /api/admin-prompts?key=...` (Task 10e)
Admin endpoint untuk Groq prompts. Protected by `x-admin-secret` header. Keys: `prompt_digest`, `prompt_bias`, `prompt_thesis`.

### `GET /api/risk-regime` (Task 1)
Classifier Risk-On / Neutral / Risk-Off berdasarkan VIX, MOVE Index, HY OAS spread.  
Redis cache `risk_regime` TTL 30 menit. Response:
```json
{
  "regime": "risk_off",
  "vix": 28.4,
  "move": 142,
  "hy_spread": 4.21,
  "hy_change_2d": 0.18,
  "components": { "vix_trigger": true, "move_trigger": true, "hy_trigger": true },
  "computed_at": "2026-04-25T06:30:00Z",
  "data_date": "2026-04-24"
}
```

---

## Redis Keys

| Key | Isi | TTL |
|-----|-----|-----|
| `cb_bias` | `{USD:{bias,confidence,updated_at}, ...}` | no TTL |
| `digest_history` | Array max 7 entri AI digest | no TTL |
| `cot_cache_v2` | Full COT payload | no TTL (6h manual check) |
| `risk_regime` | VIX/MOVE/HY regime payload | 1800s |
| `rss_cache` | `{xml, fetchedAt}` | 60s |
| `real_yields` | `{currencies:{...}, computed_at}` | 21600s |
| `rate_path` | `{USD:{probHold,probCut25,...}}` | 14400s |
| `latest_thesis` | Structured thesis JSON dari Groq | 21600s |
| `correlations` | Correlation matrix 20d+60d+anomalies | 86400s |
| `sizing_history:{device_id}` | Sorted set sizing calculations | no TTL |
| `journal:{device_id}:{id}` | Full journal entry JSON | no TTL |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL |
| `prompt_digest` | Groq prompt untuk briefing | no TTL |
| `prompt_bias` | Groq prompt untuk CB bias | no TTL |
| `prompt_thesis` | Groq prompt untuk thesis JSON | no TTL |
| `push_subs` | HSET push subscriptions | no TTL |
| `seen_guids` | Set GUID berita (dedup push) | 86400s |

---

## Checklist — Technical Detail

Semua di `index.html`. DOM: item = `div.ck-item`, checkbox = `div.ck-box` dengan `id="ckbox_{id}"` (BUKAN `<input>`). Jangan pakai `querySelector('[data-ck-id=...]')`.

### PLAYBOOKS Architecture
```js
const PLAYBOOKS = {
  smc_ict:        { name, color, sections:[...], quick:[...], gates:[...] },
  macro_momentum: { ... },
  event_driven:   { ... },
  mean_reversion: { ... },
};
const PB_REGIME_CHECK = { id:'regime_check', num:'00', ... }; // shared di semua playbook
let ckActivePlaybook = localStorage.getItem('daun_merah_playbook') || 'smc_ict';
let CK_SECTIONS = PLAYBOOKS[ckActivePlaybook].sections;
let CK_QUICK    = PLAYBOOKS[ckActivePlaybook].quick;
let CK_GATES    = PLAYBOOKS[ckActivePlaybook].gates;
```

localStorage key: `daunmerah_v2` (state), `daun_merah_playbook` (active playbook), `daun_merah_device_id` (device ID)

Functions: `ckLoad`, `ckSave`, `ckToggleItem`, `ckToggleSection`, `ckGetItems`, `ckGetScore`, `ckIsComplete`, `ckGetVerdict`, `ckBuildUI`, `ckRender`, `ckResetAll`, `ckUpdateClock`, `initChecklist`, `ckSwitchPlaybook`, `ckAutoTick`, `ckAutoBlock`, `ckOnPairChange`

Auto-tick: `ckAutoTick(id, hint)` set `ckState[id]=true`, cari `#ckbox_{id}`, tambah `.auto-badge` span. `ckAutoBlock` set false + badge merah.

Verdict: sidebar (desktop) + `.ck-mobile-bar` strip (mobile ≤600px)

---

## Commit History (Terakhir)

```
022dc40 feat: Task 7-9, Task 10a/b/e — Regime Gate, Journal, Thesis, Playbooks, Correlations, Rate Path, Hardening
9e5f7fa feat: Task 4 — Position Sizing Calculator (SIZING tab + backend)
80030ce feat: Task 2 frontend — real yield differential in CB tracker cards
bd16d06 feat: Task 10c RSS Redis cache, Task 10d cal 60min, Task 2 real yields backend
a3baa1e feat: add risk regime banner (Task 1)
```

> **Status saat ini:** semua task di-push ke origin/main, production Vercel up to date.

---

## Bug History yang Penting

- **0 berita di RINGKASAN** — Vercel server IPs diblokir FinancialJuice kalau `market-digest.js` fetch RSS langsung. Fix: fetch ke internal `/api/rss`.
- **qwen-qwq-32b timeout** — model reasoning overhead melewati Vercel 25s limit. Rollback ke `llama-3.3-70b-versatile`.
- **Edit conflict pada CSS checklist** — orphan comment dengan spasi berbeda. Fix: baca file dulu untuk dapat exact string sebelum edit.

---

---

# EVOLUTION PLAN — 10 Tasks

> Dikerjakan secara berurutan. Setiap task harus deployed sebelum lanjut ke berikutnya.  
> Constraint utama: no new deps, no build step, single `index.html`, backward compatible, Redis cache mandatory, mobile-first, Indonesian UI text.

---

## ✅ TASK 1 — Risk Regime Indicator
**Status: SELESAI (lokal, belum di-push)**

**Apa yang dikerjakan:**
- `api/risk-regime.js` dibuat — fetch VIX dari FRED (`VIXCLS`), MOVE dari Stooq CSV (`^move`), HY OAS dari FRED (`BAMLH0A0HYM2`) secara paralel
- Classifier: Risk-Off jika VIX>25 OR MOVE>130 OR HY widening >0.15%/2hari; Risk-On jika semua benign; Neutral jika di antaranya
- Redis cache `risk_regime` TTL 30 menit; fallback ke stale cache jika semua source gagal
- `index.html` dimodifikasi: banner tipis di antara install-banner dan stats-bar, tappable untuk expand breakdown komponen
- Auto-fetch saat app load (800ms delay) + setiap 15 menit
- Warna: merah gelap (Risk-Off), hijau gelap (Risk-On), abu (Neutral)

**File yang diubah/dibuat:**
- `api/risk-regime.js` ← baru
- `index.html` ← modifikasi (CSS, HTML banner, JS fetchRegime/renderRegimeBanner/toggleRegimeDetail, init wiring)

**Env var baru yang diperlukan:**
- `FRED_API_KEY` — harus di-set di Vercel sebelum deploy

**Langkah deploy:**
1. `git add api/risk-regime.js index.html`
2. `git commit -m "feat: add risk regime banner (Task 1)"`
3. `git push origin main`
4. Set `FRED_API_KEY` di Vercel dashboard → Settings → Environment Variables
5. Vercel auto-deploy setelah push
6. Test: `curl https://<domain>/api/risk-regime`

**Acceptance criteria:**
- [x] Banner visible di semua tab
- [x] Classifier rationale visible on tap
- [x] Works 380px viewport
- [x] Fallback graceful jika source gagal
- [ ] **Belum diverifikasi di production** (belum di-push)

---

## ⬜ TASK 2 — Real Yield Differential
**Status: BELUM DIMULAI**
**Prerequisite:** Task 1 deployed ✓ (setelah Task 1 di-push)

**Apa yang akan dikerjakan:**
- Buat `api/real-yields.js` — FRED `T10YIE` (TIPS breakeven) untuk USD real yield
- Untuk EUR/GBP/JPY/CAD/AUD: 10Y nominal minus inflation expectation yang di-hardcode per currency (diupdate quarterly)
- Redis cache `real_yields` TTL 6 jam
- Extend CB tracker card di RINGKASAN: tambah baris `Real: +1.45% (Nom 4.50% − Inf 3.05%)` di bawah interest rate
- Indikator dot jika data inflasi >90 hari stale

**Data sources:**
- FRED `T10YIE` — US 10Y breakeven inflation (TIPS-derived)
- FRED `IRLTLT01EZM156N` — Euro area 10Y nominal yield (proxy ECB)
- Hardcoded inflation expectations untuk non-TIPS currencies

---

## ⬜ TASK 3 — Rate Path Expectations
**Status: BELUM DIMULAI**
**Prerequisite:** Task 1 deployed

**Apa yang akan dikerjakan:**
- Buat `api/rate-path.js` — scrape atau parse CME FedWatch untuk probabilitas hold/cut/hike di 3 FOMC meeting berikutnya
- Hitung cumulative bps implied di 3M dan 6M horizon
- Redis cache `rate_path` TTL 4 jam
- Extend CB card USD: `Next Meeting: Hold 78% / Cut 22%` dan `6M implied: -42bps`
- Diarsitektur untuk tambah EUR/GBP/JPY nanti

---

## ⬜ TASK 4 — Position Sizing Calculator
**Status: BELUM DIMULAI**
**Prerequisite:** Tidak bergantung Task 1-3 (bisa dikerjakan paralel)

**Apa yang akan dikerjakan:**
- Tab baru `SIZING` di nav-views
- Client-side calculator: input (equity, risk%, pair, stop pips, entry price) → output (lot size, dollar risk, R-multiple table)
- Hard limit: risk% >2 diblok dengan warning
- Default risk%: 0.5
- Pip value table untuk major pairs di-hardcode sebagai konstanta
- `api/sizing-history.js` — POST/GET sizing history per device-id (Redis `sizing_history:{device_id}`, last 10)

---

## ⬜ TASK 5 — Trade Journal
**Status: BELUM DIMULAI**
**Prerequisite:** Task 1 (untuk auto-snapshot regime saat entry)

**Apa yang akan dikerjakan:**
- Tab baru `JURNAL` di nav-views
- `api/journal.js` — POST/PATCH/GET/DELETE (soft-delete) untuk trade entries
- Entry schema: pair, direction, regime_at_entry, thesis_text, cb_bias_snapshot, cot_snapshot, entry/stop/target price, size, planned RR, time horizon
- Exit schema: exit_price, exit_reason, r_actual, attribution_notes
- Redis: `journal:{device_id}:{entry_id}` + sorted set index `journal_index:{device_id}`
- UI: list open + closed trades, detail view, form log new trade (pre-filled regime + CB snapshot), form close trade

---

## ⬜ TASK 6 — Structured Trade Thesis dari AI
**Status: BELUM DIMULAI**
**Prerequisite:** Task 1, Task 5

**Apa yang akan dikerjakan:**
- Tambah Groq Call ke-3 di `api/market-digest.js`
- Output JSON schema: `{dominant_regime, strongest_currency, weakest_currency, pair_recommendation, direction, confidence_1_to_5, invalidation_condition, time_horizon_days, catalyst_dependency}`
- Validasi strict, retry sekali, fallback null jika malformed
- Redis `latest_thesis` dengan TTL sama dengan digest cycle
- Card di atas tab RINGKASAN: pair, direction, confidence stars, invalidation
- Tombol "Gunakan thesis ini untuk mulai jurnal" → prefill journal form

---

## ⬜ TASK 7 — Regime Gate di Checklist
**Status: BELUM DIMULAI**
**Prerequisite:** Task 1 deployed (untuk auto-tick item 1)

**Apa yang akan dikerjakan:**
- Insert section baru `num: '00'` sebelum gate saat ini di `CK_SECTIONS`
- 5 item: regime ditentukan, CB bias kedua currency dikonfirmasi, COT tidak extreme, tidak ada high-impact event <6 jam, real yield mendukung bias
- Auto-tick item 1 jika regime banner sudah di-fetch
- Auto-tick item 2 jika kedua currencies punya bias di cb-status
- Auto-tick item 3 jika COT fresh + extremity check pass
- Auto-tick item 4 dengan query calendar untuk currencies pair yang dipilih
- Item 5 tetap manual

---

## ⬜ TASK 8 — Configurable Playbooks
**Status: BELUM DIMULAI**
**Prerequisite:** Task 7

**Apa yang akan dikerjakan:**
- Playbook selector di atas tab CHECKLIST: Macro Momentum / Event-Driven / SMC-ICT (current) / Mean Reversion
- `CK_SECTIONS` dipindahkan ke dalam object `PLAYBOOKS`
- Setiap playbook punya CK_SECTIONS-nya sendiri, dimulai dengan REGIME CHECK section (Task 7)
- Pilihan persisted di localStorage
- Ganti playbook → reset state checklist

---

## ⬜ TASK 9 — Cross-Asset Correlation Snapshot
**Status: BELUM DIMULAI**
**Prerequisite:** Task 1 (konteks regime)

**Apa yang akan dikerjakan:**
- Buat `api/correlations.js` — fetch 60 hari daily closes untuk DXY, EURUSD, GBPUSD, USDJPY, AUDUSD, Gold, WTI, SPX, VIX, US10Y
- Hitung rolling 20-day correlation matrix
- Flag pair dengan korelasi menyimpang >2 std dari 1-year average
- Redis cache `correlations` TTL 24 jam
- Panel kecil di tab RINGKASAN: heatmap (merah=negatif, hijau=positif, abu=netral) + anomali highlighted
- Tooltip: "Korelasi saat ini menyimpang dari norma historis"

---

## ⬜ TASK 10 — System Hardening
**Status: BELUM DIMULAI**
**Prerequisite:** Bisa dikerjakan kapan saja, paralel dengan task lain jika ada bug

**Sub-tasks:**
- **(a) Branding consistency** — update README.md, package.json, push.js Telegram messages, notification titles ke "Daun Merah"
- **(b) CFTC parser robustness** — jika parsed currencies <5, return stale + log warning; error JSON jika keduanya gagal
- **(c) RSS cache ke Redis** — ganti module-level cache di `rss.js` dengan Redis, TTL tetap 50s, tambah header `X-Cache-Source: REDIS/MEMORY/MISS`
- **(d) Calendar refetch interval** — ubah client-side dari 15min ke 60min, tambah "Last updated X min ago"
- **(e) Prompt externalization** — pindah Groq prompts di `market-digest.js` ke Redis keys (`prompt_digest`, `prompt_bias`, `prompt_thesis`); admin endpoint untuk update tanpa redeploy

---

## Progress Overview

```
Task 1  ✅  Risk Regime Indicator        SELESAI — deployed commit a3baa1e
Task 2  ✅  Real Yield Differential      SELESAI — deployed commit bd16d06 + 80030ce
Task 3  ✅  Rate Path Expectations       SELESAI — deployed commit 022dc40 (SOFR heuristic)
Task 4  ✅  Position Sizing Calculator   SELESAI — deployed commit 9e5f7fa
Task 5  ✅  Trade Journal                SELESAI — deployed commit 022dc40
Task 6  ✅  Structured Trade Thesis AI   SELESAI — deployed commit 022dc40
Task 7  ✅  Regime Gate di Checklist     SELESAI — deployed commit 022dc40
Task 8  ✅  Configurable Playbooks       SELESAI — deployed commit 022dc40 (4 playbook)
Task 9  ✅  Cross-Asset Correlation      SELESAI — deployed commit 022dc40
Task 10a ✅ Branding Consistency         SELESAI — deployed commit 022dc40
Task 10b ✅ CFTC Parser Robustness       SELESAI — deployed commit 022dc40
Task 10c ✅ RSS Cache to Redis           SELESAI — deployed commit bd16d06
Task 10d ✅ Calendar Refetch 60min       SELESAI — deployed commit bd16d06
Task 10e ✅ Prompt Externalization       SELESAI — deployed commit 022dc40
Task 10f ✅ Health Monitoring            SELESAI — lokal, belum di-push
Task 10g ✅ Redis Key Registry           SELESAI — lokal, belum di-push
Task 10h ✅ Rate Limiting                SELESAI — lokal, belum di-push
```

---

## Next Action

### SEMUA TASK SELESAI ✅

Task 10f/g/h sudah diimplementasikan secara lokal. Langkah deploy:

```bash
git add api/health.js api/redis-keys.js api/_ratelimit.js api/correlations.js api/market-digest.js
git commit -m "feat: Task 10f/g/h — Health Monitoring, Redis Registry, Rate Limiting"
git push origin main
```

Setelah push, setup **cron-job.org** (manual):
- URL: `https://<domain>/api/health`
- Method: GET
- Header: `x-admin-secret: <CRON_SECRET>`
- Interval: 60 menit

Setelah itu, jalankan cleanup deprecated Redis keys:
```bash
curl -X POST https://<domain>/api/redis-keys?action=cleanup \
  -H "x-admin-secret: <CRON_SECRET>"
```

Tidak ada task baru yang direncanakan. Project Daun Merah feature-complete.

---

## Absolute Constraints (Ringkasan)

1. No new dependencies unless approved
2. No build step — frontend tetap single `index.html`
3. Backward compatible — jangan break endpoints/Redis keys/UI flow yang ada
4. Caching mandatory — setiap external API call harus ada Redis cache dengan TTL explicit
5. Cold-start safe — pakai Redis, bukan module-level cache, untuk data yang harus persist
6. No silent failures — log context di setiap fetch/parse failure
7. Honest data only — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport sebelum commit
9. One feature per PR
10. Indonesian UI text, English code/comments/variables
