# DAUN MERAH — HANDOFF DOKUMEN
> **Diupdate:** 2026-04-26 (session 2)
> **Branch:** main — Task 10f/g/h selesai secara lokal, belum di-push
> **Working directory:** `c:\Users\sam\Downloads\Financial_Feed_App`
> **Deployment:** Vercel + Upstash Redis
> **Context file terlengkap:** `daun_merah.md` (baca ini dulu sebelum mulai)

---

## STATUS SAAT INI

### ✅ SEMUA TASK 1-9 + TASK 10a-h SELESAI — Task 10f/g/h lokal, belum di-push

| Commit | Konten |
|--------|--------|
| `022dc40` | Task 7, 8, 5, 6, 3, 9, 10a, 10b, 10e — semua dikerjakan sekaligus |
| `9e5f7fa` | Task 4 — Position Sizing Calculator |
| `80030ce` | Task 2 frontend — real yield di CB cards |
| `bd16d06` | Task 10c, 10d, Task 2 backend |
| `a3baa1e` | Task 1 — Risk Regime Banner |

**File baru yang belum di-commit:**
- `api/health.js` — Task 10f
- `api/redis-keys.js` — Task 10g
- `api/_ratelimit.js` — Task 10h helper

**File yang dimodifikasi (belum di-commit):**
- `api/correlations.js` — tambah rate limiter (5 req/min)
- `api/market-digest.js` — tambah rate limiter (4 req/min)

---

## APA YANG SUDAH SELESAI (SEMUA)

### ✅ Task 1 — Risk Regime Indicator
- `api/risk-regime.js` — VIX (FRED), MOVE (Stooq `^move`), HY OAS (FRED `BAMLH0A0HYM2`)
- Banner tipis di atas stats-bar, tappable expand/collapse
- Redis `risk_regime` TTL 1800s

### ✅ Task 2 — Real Yield Differential
- `api/real-yields.js` — USD: DGS10 minus T10YIE, 7 currencies lain hardcoded inflation expectations
- Real yield muncul di setiap CB card: format `Real: +1.45%`
- Redis `real_yields` TTL 21600s

### ✅ Task 3 — Rate Path Expectations
- `api/rate-path.js` — **PENTING: BUKAN CME FedWatch (SPA, tidak bisa di-scrape)**
- Implementasi: FRED SOFR/EFFR + heuristic probability model + FOMC dates hardcoded 2026
- FOMC dates yang di-hardcode: May 7, Jun 18, Jul 30, Sep 17, Nov 5, Dec 17
- Heuristic: `probCut25 = currentRate > 4.0 ? 0.25 : currentRate > 3.0 ? 0.40 : 0.20`
- Response includes `data_note` field yang explain ini approximation
- Muncul di USD CB card: `Hold X% / Cut Y% · 6M implied: -Zbps`
- Redis `rate_path` TTL 14400s

### ✅ Task 4 — Position Sizing Calculator
- Tab `SIZING` baru di nav primary (warna `--green`)
- `api/sizing-history.js` — POST/GET, sorted set per device-id, max 10 entries
- Calculator: input equity/risk/pair/stop/entry → output lot size, dollar risk, R-table
- Hard block risk% > 2%, pip value logic (JPY pairs pakai divisor berbeda)
- `SZ_DEVICE_KEY = 'daun_merah_device_id'`, `szGetDeviceId()` dipakai di seluruh app
- Redis `sizing_history:{device_id}` no TTL

### ✅ Task 5 — Trade Journal
- Tab `JURNAL` baru di nav primary (warna `var(--pink)` = `#f472b6`)
- `api/journal.js` — POST/PATCH/GET/DELETE (soft-delete, status → 'archived')
- Redis: `journal:{device_id}:{id}` + sorted set `journal_index:{device_id}`
- GET support query: `?status=all|open|closed|archived`
- UI: list view, new form, detail view, close form
- Dapat di-prefill dari thesis AI via `jnPrefillFromThesis()`

### ✅ Task 6 — Structured Trade Thesis dari AI
- Groq Call ke-3 di `api/market-digest.js`
- Output JSON: `{dominant_regime, strongest_currency, weakest_currency, pair_recommendation, direction, confidence_1_to_5, invalidation_condition, time_horizon_days, catalyst_dependency}`
- Validasi strict + retry sekali on malformed JSON, fallback null
- Redis `latest_thesis` TTL 21600s
- Card muncul di atas RINGKASAN panel (hanya jika confidence >= 3)
- Global `_lastThesis` untuk "Gunakan untuk Jurnal" → `jnPrefillFromThesis()`

### ✅ Task 7 — Regime Gate di Checklist
- Section `REGIME CHECK` (id='regime_check', num='00') sebagai bagian dari setiap playbook
- 5 item: rc1 (regime), rc2 (CB bias), rc3 (COT), rc4 (calendar), rc5 (real yield, manual)
- Auto-tick via `ckAutoTick(id, hint)` dan `ckAutoBlock(id, hint)`
- Pair selector di atas CHECKLIST panel menggunakan `SZ_PAIRS`
- Konstan `PB_REGIME_CHECK` dipakai shared di semua playbook

### ✅ Task 8 — Configurable Playbooks (4 playbook)
- Object `PLAYBOOKS` dengan key: `smc_ict`, `macro_momentum`, `event_driven`, `mean_reversion`
- `let CK_SECTIONS`, `let CK_QUICK`, `let CK_GATES` — di-reassign saat ganti playbook
- `ckActivePlaybook` persisted ke localStorage key `daun_merah_playbook`
- `ckSwitchPlaybook(id)` — reset `ckState = {}` + rebuild UI
- Playbook selector `<select id="ckPlaybookSelector">` di panel header

### ✅ Task 9 — Cross-Asset Correlation Snapshot
- `api/correlations.js` — 10 instrumen dari Stooq (DXY, EURUSD, GBPUSD, USDJPY, AUDUSD, Gold `xauusd`, WTI `cl.f`, SPX `^spx`, VIX `^vix`, US10Y `^tnx`)
- Pearson correlation 20d dan 60d windows (bukan 5d seperti di plan awal)
- Anomaly: `|r20 - r60| > 0.4`
- **On-demand via button, BUKAN auto-fetch** — 10 Stooq CSV terlalu lambat (~10s+)
- Redis `correlations` TTL 86400s

### ✅ Task 10a — Branding Consistency
- `package.json`: `"name": "daun-merah"`
- `api/push.js`: title notif = `"Daun Merah"`, Telegram = `"Daun Merah — N berita baru"`, VAPID_SUBJECT = `admin@daun-merah.app`

### ✅ Task 10b — CFTC Parser Robustness
- `api/cot.js`: jika parsed currencies < 5 → log warning + return stale cache dengan field `parse_warning`
- Error JSON jika keduanya gagal

### ✅ Task 10c — RSS Cache to Redis
- `api/rss.js`: Redis key `rss_cache` TTL 60s (ganti module-level cache)

### ✅ Task 10d — Calendar Refetch 60 menit
- `index.html`: auto-refetch calendar dari 15min → 60min, "last updated" indicator

### ✅ Task 10e — Prompt Externalization
- `api/admin-prompts.js` — GET/POST/DELETE untuk Redis keys: `prompt_digest`, `prompt_bias`, `prompt_thesis`
- Protected by `x-admin-secret` header (= `CRON_SECRET` env var)
- `api/market-digest.js` loads `prompt_digest` dari Redis at runtime, fallback ke hardcoded
- `DIGEST_INSTR_DEFAULT` = instruction-only text, dynamic context di-inject di `prompt` var

---

## YANG BELUM SELESAI

### ✅ Task 10f — Health Monitoring — SELESAI (lokal)
- `api/health.js` dibuat
- Test 6 sources: fred, stooq, forexfactory, financialjuice, cftc, redis
- Telegram alert jika source DOWN > 2 jam (via `health_last_ok` HSET di Redis)
- Protected by `x-admin-secret` header
- **Setup cron-job.org** (langkah manual): hit `GET /api/health` dengan header `x-admin-secret` setiap 60 menit

### ✅ Task 10g — Redis Key Registry — SELESAI (lokal)
- `api/redis-keys.js` dibuat
- Registry 19 key aktif + 2 key deprecated (`cot_cache`, `fundamentals_cache`)
- `GET /api/redis-keys` — tampilkan semua key dengan live TTL info dari Redis
- `POST /api/redis-keys?action=cleanup` — hapus deprecated keys
- Protected by `x-admin-secret` header

### ✅ Task 10h — Rate Limiting — SELESAI (lokal)
- `api/_ratelimit.js` dibuat (shared module, tidak jadi public route karena prefix `_`)
- Rate limit via Redis sliding-window counter per IP
- Whitelist: private IPs, localhost, cron-job.org IPs
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- 429 response dengan `Retry-After` header jika exceeded
- Diterapkan ke:
  - `api/market-digest.js` — 4 req/min (3 Groq calls, endpoint paling mahal)
  - `api/correlations.js` — 5 req/min (10 Stooq CSV fetch)
- Endpoint lain bisa tambah sendiri: `if (await rateLimit(req, res, {...})) return;`

---

## STRUKTUR FILE LENGKAP (POST-SEMUA-TASK)

```
Financial_Feed_App/
├── index.html              # Seluruh UI + JS — ~3000+ baris
├── manifest.json           # PWA manifest
├── sw.js                   # Service Worker
├── vercel.json             # Security headers
├── package.json            # name: "daun-merah", deps: web-push
└── api/
    ├── _ratelimit.js       # Task 10h — Shared rate limiter helper (tidak jadi route publik)
    ├── rss.js              # RSS proxy — Redis cache rss_cache TTL 60s
    ├── calendar.js         # ForexFactory calendar
    ├── cb-status.js        # CB tracker + bias dari Redis
    ├── cot.js              # CFTC COT scraper — robustness Task 10b
    ├── fundamentals.js     # Fundamental snapshot (tab tidak ada di UI)
    ├── market-digest.js    # AI briefing (3 Groq calls) — rate limited 4/min
    ├── push.js             # Web push notifications — branding Daun Merah
    ├── subscribe.js        # Push subscription management
    ├── risk-regime.js      # Task 1 — VIX/MOVE/HY classifier
    ├── real-yields.js      # Task 2 — Real yield differential
    ├── rate-path.js        # Task 3 — SOFR heuristic rate path
    ├── sizing-history.js   # Task 4 — Position sizing history
    ├── journal.js          # Task 5 — Trade journal CRUD
    ├── correlations.js     # Task 9 — Cross-asset correlation — rate limited 5/min
    ├── admin-prompts.js    # Task 10e — Admin endpoint untuk Groq prompts
    ├── health.js           # Task 10f — Health check semua external sources
    ├── redis-keys.js       # Task 10g — Redis key registry + cleanup utility
    └── package.json
```

---

## ARSITEKTUR CHECKLIST (PENTING UNTUK AI BARU)

Checklist diimplementasikan murni di `index.html`. Ini pola yang harus dipahami:

### DOM Pattern
Item checklist adalah `div.ck-item` dengan `div.ck-box` yang punya `id="ckbox_{id}"`.  
**BUKAN** `<input type="checkbox">`. Jangan gunakan `querySelector('[data-ck-id=...]')` — akan gagal.

### Toggle
```js
ckToggleItem(id)        // user toggle — update ckState[id], ckSave(), ckRender()
ckAutoTick(id, hint)    // auto-set true — tambah '.auto-badge' span
ckAutoBlock(id, hint)   // auto-set false — tambah '.auto-badge' merah
```

### State
```js
let ckState = {};          // {id: true/false}
// persisted ke localStorage key 'daunmerah_v2'
```

### Playbook Architecture
```js
const PLAYBOOKS = {
  smc_ict:         { name, color, sections:[...], quick:[...], gates:[...] },
  macro_momentum:  { ... },
  event_driven:    { ... },
  mean_reversion:  { ... },
};
const PB_REGIME_CHECK = { id:'regime_check', num:'00', title:'REGIME CHECK', ... }; // shared
let ckActivePlaybook = localStorage.getItem('daun_merah_playbook') || 'smc_ict';
let CK_SECTIONS = PLAYBOOKS[ckActivePlaybook].sections;
let CK_QUICK    = PLAYBOOKS[ckActivePlaybook].quick;
let CK_GATES    = PLAYBOOKS[ckActivePlaybook].gates;
```

### Auto-tick flow
Auto-tick dipanggil dari fetch callbacks setelah data tersedia:
- `fetchRegime()` → `ckAutoTick('rc1', ...)`
- `fetchCBStatus()` → `ckAutoTick('rc2', ...)`
- `fetchCOT()` → `ckAutoTick('rc3', ...)`
- `fetchCalendar()` → `ckAutoTick/Block('rc4', ...)`
- Real yield → hint text di `#ckPairHint`, rc5 tetap manual

---

## REDIS KEYS LENGKAP

| Key | Isi | TTL |
|-----|-----|-----|
| `cb_bias` | `{USD:{bias,confidence,updated_at},...}` | no TTL |
| `digest_history` | Array max 7 entri digest AI | no TTL |
| `cot_cache_v2` | Full COT payload | no TTL (6h manual check) |
| `risk_regime` | VIX/MOVE/HY regime payload | 1800s |
| `rss_cache` | `{xml, fetchedAt}` | 60s |
| `real_yields` | `{currencies:{...}, computed_at}` | 21600s |
| `rate_path` | `{USD:{probHold,probCut25,meetings,...}}` | 14400s |
| `latest_thesis` | Structured thesis JSON dari Groq | 21600s |
| `correlations` | Correlation matrix 20d+60d+anomalies | 86400s |
| `sizing_history:{device_id}` | Sorted set sizing history | no TTL |
| `journal:{device_id}:{id}` | Full journal entry JSON | no TTL |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL |
| `prompt_digest` | Groq prompt untuk briefing | no TTL |
| `prompt_bias` | Groq prompt untuk CB bias | no TTL |
| `prompt_thesis` | Groq prompt untuk structured thesis | no TTL |
| `push_subs` | HSET push subscriptions | no TTL |
| `seen_guids` | Set GUID berita (dedup push) | 86400s |

| `health_last_ok` | HSET: source → last OK ISO timestamp (health monitoring) | no TTL |
| `rl:{endpoint}:{ip}:{window}` | Rate limiter counter per IP per window | auto (2×windowSecs) |

**Deprecated (boleh di-delete):** `cot_cache` (diganti `cot_cache_v2`), `fundamentals_cache`

Gunakan `POST /api/redis-keys?action=cleanup` untuk hapus deprecated keys.

---

## NAVIGASI / TAB LAYOUT

Primary tabs (`data-view`):
| Tab | View | Warna |
|-----|------|-------|
| NEWS | `feed` | `--accent` (#c0392b) |
| RINGKASAN | `ringkasan` | `--accent` |
| CAL | `cal` | `--green` |
| COT | `cot` | `--purple` |
| CHECKLIST | `checklist` | `--yellow` |
| SIZING | `sizing` | `--green` |
| JURNAL | `jurnal` | `--pink` (#f472b6) |

---

## CATATAN IMPLEMENTASI PENTING

### Rate Path — BUKAN CME FedWatch
CME FedWatch adalah SPA, tidak bisa di-scrape. Implementasi pakai SOFR/EFFR dari FRED + heuristic probability + hardcoded FOMC dates. Hasilnya approximation — ada `data_note` di response. Jika ingin data lebih akurat, perlu sumber alternatif (Atlanta Fed, Polymarket API, dll).

### Correlations — On-Demand
10 Stooq CSV fetch memakan ~10+ detik. Data tidak di-auto-fetch saat load, hanya via tombol "Muat Korelasi" di RINGKASAN panel. Setelah fetch, data disimpan ke Redis TTL 24 jam.

### Device ID
Semua per-device storage (journal, sizing history) pakai `szGetDeviceId()` dari localStorage key `SZ_DEVICE_KEY = 'daun_merah_device_id'`. Satu function, reuse di seluruh app.

### Thesis → Journal
Global `_lastThesis` menyimpan thesis object terbaru. Tombol "Gunakan untuk Jurnal" → `jnPrefillFromThesis()` → switch ke tab JURNAL, tampilkan form baru, pre-fill pair/direction/thesis.

### Prompt Externalization
`DIGEST_INSTR_DEFAULT` di `market-digest.js` hanya berisi instruction text (no dynamic data). Dynamic context (headlines, calendar, history) diinject sekali di variabel `prompt`. Prompts bisa diupdate via:
```
curl -X POST /api/admin-prompts?key=prompt_digest \
  -H "x-admin-secret: <CRON_SECRET>" \
  -d "New prompt text here"
```

---

## CONSTRAINT ABSOLUT (TIDAK BOLEH DILANGGAR)

1. No new npm dependencies
2. Frontend tetap single `index.html` — no bundler, no framework
3. Backward compatible — jangan break endpoints/Redis keys yang ada
4. Setiap external API call harus ada Redis cache dengan explicit TTL
5. Cold-start safe — pakai Redis, bukan module-level cache
6. No silent failures — log context di setiap failure
7. Honest data — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport
9. Indonesian UI text, English code/comments/variables

---

## ENVIRONMENT

```
Stack:  Vanilla JS + HTML, Vercel Serverless Functions (Node.js CommonJS), Upstash Redis REST
AI:     Groq llama-3.3-70b-versatile (max 25s timeout)
CSS:    --accent: #c0392b, Font: Syne + DM Mono, --pink: #f472b6 (JURNAL tab)
Redis:  Upstash REST — pola: async function redisCmd(...args) di setiap api/*.js
Env:    GROQ_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
        FRED_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
        TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET
```
