# DAUN MERAH — TASK 2-10 (REVISED)

## STATUS UPDATE (2026-04-26) — SEMUA TASK SELESAI

✅ **TASK 1 — Risk Regime Indicator** — DEPLOYED (commit a3baa1e)
✅ **TASK 2 — Real Yield Differential** — DEPLOYED (commit bd16d06 + 80030ce)
✅ **TASK 3 — Rate Path Expectations** — DEPLOYED (commit 022dc40) — SOFR heuristic, bukan CME FedWatch
✅ **TASK 4 — Position Sizing Calculator** — DEPLOYED (commit 9e5f7fa)
✅ **TASK 5 — Trade Journal** — DEPLOYED (commit 022dc40)
✅ **TASK 6 — Structured Trade Thesis** — DEPLOYED (commit 022dc40)
✅ **TASK 7 — Regime Gate Checklist** — DEPLOYED (commit 022dc40)
✅ **TASK 8 — Configurable Playbooks** — DEPLOYED (commit 022dc40) — 4 playbook
✅ **TASK 9 — Cross-Asset Correlations** — DEPLOYED (commit 022dc40)
✅ **TASK 10a — Branding Consistency** — DEPLOYED (commit 022dc40)
✅ **TASK 10b — CFTC Parser Robustness** — DEPLOYED (commit 022dc40)
✅ **TASK 10c — RSS Cache to Redis** — DEPLOYED (commit bd16d06)
✅ **TASK 10d — Calendar Refetch Interval** — DEPLOYED (commit bd16d06)
✅ **TASK 10e — Prompt Externalization** — DEPLOYED (commit 022dc40)
✅ **TASK 10f — Health Monitoring** — SELESAI (lokal, belum di-push)
✅ **TASK 10g — Redis Key Registry** — SELESAI (lokal, belum di-push)
✅ **TASK 10h — Rate Limiting** — SELESAI (lokal, belum di-push)

---

## ACTUAL EXECUTION ORDER (SELESAI)

1. ✅ Task 1
2. ✅ Task 10c + 10d
3. ✅ Task 2
4. ✅ Task 4
5. ✅ Task 7 — Regime gate
6. ✅ Task 5 — Trade journal
7. ✅ Task 6 — Structured thesis
8. ✅ Task 8 — Configurable playbooks (4 playbook sekaligus, bukan bertahap)
9. ✅ Task 3 — Rate path (SOFR heuristic, bukan CME FedWatch)
10. ✅ Task 9 — Correlations
11. ✅ Task 10a/b/e — Hardening
12. ✅ Task 10f/g/h — SELESAI (lokal, belum di-push)

---

## ✅ TASK 10c — RSS Cache to Redis (QUICK WIN)
**Status: DEPLOYED — commit bd16d06**
**Prerequisite:** None
**Estimasi effort:** 1-2 jam

**Kegunaan:**
Saat ini cache RSS di-reset setiap kali Vercel function cold start (sering terjadi di tier free). Akibatnya FinancialJuice di-fetch berulang, risk rate-limit dari upstream, dan response time lebih lambat untuk user. Pindah ke Redis = cache konsisten lintas invocation, lebih sedikit kemungkinan diblokir FinancialJuice, app load lebih cepat.

**Apa yang dikerjakan:**
- Ganti module-level `cache` object di `api/rss.js` dengan Redis-backed cache
- Redis key: `rss_cache` dengan TTL 50s
- Tambah header `X-Cache-Source: REDIS | UPSTREAM | STALE`
- Fallback ke stale cache jika upstream fetch gagal (sudah ada, tetap pertahankan)
- Cold start sekarang reuse cache, bukan re-fetch

**Acceptance:**
- Cold start function panggil Redis dulu sebelum fetch upstream
- Header `X-Cache-Source` reflect actual source
- TTL 50s konsisten lintas invocation

---

## ✅ TASK 10d — Calendar Refetch Interval (QUICK WIN)
**Status: DEPLOYED — commit bd16d06**
**Prerequisite:** None
**Estimasi effort:** 30 menit

**Kegunaan:**
Calendar economic data dari ForexFactory hanya update beberapa kali sehari (saat data rilis aktual masuk). Refetch tiap 15 menit = boros bandwidth, boros Vercel invocation, tidak menambah informasi. 60 menit cukup untuk capture update tanpa overhead. User juga jadi tahu kapan terakhir data di-refresh untuk decide manual refresh.

**Apa yang dikerjakan:**
- Ubah client-side calendar refetch dari 15 menit ke 60 menit di `index.html`
- Tambah indikator "Diperbarui X menit yang lalu" di toolbar calendar
- Update tooltip tombol REFRESH dengan info timing

**Acceptance:**
- Auto-refetch interval 60 menit
- Manual refresh tetap available
- "Last updated" indicator visible

---

## ✅ TASK 2 — Real Yield Differential (CORRECTED)
**Status: DEPLOYED — backend commit bd16d06, frontend commit 80030ce**
**Prerequisite:** Task 1 deployed ✓

**Kegunaan:**
CB rate nominal saja menyesatkan. USD 4.50% dengan inflasi 3% (real 1.5%) berbeda fundamental dari USD 4.50% dengan inflasi 2% (real 2.5%) — yang kedua jauh lebih hawkish secara efektif. Real yield differential adalah driver FX paling kuat di rezim normal — institusi trade berdasarkan ini, bukan nominal rate. Tanpa data ini, "USD vs JPY" hanya 4.50% vs 0.50%; dengan data ini Anda lihat USD real +1.45% vs JPY real -2.30% = differential +3.75% yang menjelaskan kenapa USD/JPY bisa hold di level tinggi meski Fed pause.

**KOREKSI DARI PLANNING AWAL:**
- ❌ Awalnya: `T10YIE` sebagai sumber real yield USD → SALAH (T10YIE = breakeven inflation, bukan real yield)
- ✅ Yang benar: `DFII10` (10Y TIPS yield direct) ATAU compute `DGS10 - T10YIE`

**Apa yang dikerjakan:**
- Buat `api/real-yields.js`
- USD: pakai `DGS10` (nominal 10Y) minus `T10YIE` (breakeven) = real yield. Pendekatan ini konsisten dengan pendekatan currency lain.
- EUR: 10Y Bund yield (FRED `IRLTLT01EZM156N` atau Stooq) minus ECB SPF inflation expectation (hardcoded, refresh quarterly)
- GBP: 10Y Gilt yield minus BoE Inflation Attitudes Survey median (hardcoded)
- JPY: 10Y JGB yield minus BoJ Tankan inflation expectation (hardcoded)
- AUD/CAD/NZD: 10Y govt bond yield minus survey-based expectation (hardcoded, lower priority)

**Inflation expectations hardcoded** harus ada source attribution dan tanggal di code comment:
```js
const INFLATION_EXPECTATIONS = {
  // Source: ECB SPF Q1 2026, refresh next: April 2026
  EUR: { value: 2.1, source: 'ECB SPF', as_of: '2026-01-15' },
  // Source: BoE Inflation Attitudes Survey Feb 2026
  GBP: { value: 3.2, source: 'BoE IAS', as_of: '2026-02-12' },
  // ...
};
```

**Backend:**
- Redis cache `real_yields` TTL 6 jam
- Return: `{ USD: { nominal, inflation_exp, real, source, updated }, EUR: {...}, ... }`
- Stale flag: jika `as_of` >90 hari, set `stale: true`

**Frontend:**
- Extend CB tracker card: tambah baris di bawah "Interest Rate"
- Format: `Real: +1.45% (Nom 4.50% − Inf 3.05%)`
- Dot indikator merah jika data inflasi >90 hari stale
- Color coding: real yield positif = hijau, negatif = merah

**Acceptance:**
- Real yield visible USD, EUR, GBP, JPY (minimum)
- Sources documented in code comments dengan tanggal refresh
- Stale indicator works correctly
- Differential bisa dihitung dari card (tidak perlu screen lain)

---

## ✅ TASK 4 — Position Sizing Calculator
**Status: DEPLOYED — commit 9e5f7fa**
**Prerequisite:** None (independent)

**Kegunaan:**
Position sizing salah adalah penyebab #1 retail account blow-up — bukan analisis salah. Trader hitung manual cenderung pakai "feeling" atau round numbers (0.5 lot, 1 lot) yang tidak proporsional terhadap stop distance dan equity. Calculator ini paksa hitung berbasis risk %, dan hard-block input >2% dengan edukasi kenapa. R-multiple table memvisualisasi konsekuensi tiap trade terhadap equity — jadi lebih sadar bahwa "$200 risk" itu artinya berapa di akun yang $5K vs $50K. Saved history + integrasi ke Task 5 (journal) = audit trail risk discipline Anda dari waktu ke waktu.

**KOREKSI DARI PLANNING AWAL:**
- Pip value untuk JPY pairs (0.01) berbeda dari non-JPY (0.0001) — calculator harus aware
- Account currency conversion penting untuk akurasi (default ke USD account untuk launch)

**Apa yang dikerjakan:**

**Frontend** — tab baru `SIZING`:
- Inputs:
  - Account equity (default currency: USD)
  - Account currency dropdown (USD, EUR, IDR untuk v2; USD-only untuk launch)
  - Risk percentage (default 0.5%, max 2% hard limit)
  - Pair selector (28 major pairs)
  - Stop distance (in pips)
  - Entry price (untuk pip value calculation pair non-USD-quote)

- Outputs:
  - Lot size (standard/mini/micro)
  - Dollar risk (atau account currency risk)
  - R-multiple table:
    ```
    -2R: $X (equity setelah loss)
    -1R: $X
    Entry: $X
    +1R: $X
    +2R: $X (target jika RR 1:2)
    +3R: $X
    ```

- Hard limits:
  - Risk% > 2% → BLOCKED dengan info text:
    > "Risk per trade di atas 2% secara historis berasosiasi dengan blow-up rate >70% untuk akun retail. Sistem ini menolak input ini untuk melindungi modal."
  - Stop distance < 5 pips → warning (tidak block) — "Stop terlalu sempit, slippage bisa hit prematurely"
  - Lot size > 5% account margin → warning

- Pip value table hardcoded:
  ```js
  const PIP_VALUES_USD = {
    // For 1 standard lot (100,000 units), pip value when quote currency is USD
    'EUR/USD': 10, 'GBP/USD': 10, 'AUD/USD': 10, 'NZD/USD': 10,
    // For pairs where USD is base (need to divide by spot)
    'USD/JPY': null, // calculate: (0.01 / spot) * 100000
    'USD/CAD': null, 'USD/CHF': null,
    // Cross pairs need triangulation via spot rate
    'EUR/JPY': null, 'GBP/JPY': null, // ...
  };
  ```

**Backend** — `api/sizing-history.js`:
- POST: save calculation `{ pair, risk_pct, lot_size, equity, timestamp }`
- GET: retrieve last 10 for device-id
- Redis: `sizing_history:{device_id}` (sorted set by timestamp, max 10 entries)

**Acceptance:**
- Calculator works offline (after first load)
- Risk % > 2 blocked dengan edukasi text
- JPY pairs handled correctly
- History retrievable across devices via device-id
- Account currency dropdown ada (USD-only functional di launch)

---

## ✅ TASK 7 — Regime Gate Checklist (SELESAI — commit 022dc40)
**Status: DEPLOYED**
**Prerequisite:** Task 1 deployed ✓, Task 2 deployed (untuk auto-tick item 5)

**Kegunaan:**
Checklist Daun Merah saat ini langsung masuk ke "validitas driver" — melewati layer makro yang Anda sudah build (regime, CB bias, COT, real yield). Hasilnya: setup teknikal bisa terlihat valid padahal regime makronya kontradiksi (misal long EUR/USD saat regime risk-off + Fed hawkish + EUR Lev Funds heavy short). Section regime gate ini paksa user verify alignment makro dulu sebelum lanjut ke checklist teknikal. Auto-tick dari data yang sudah ada di sistem = no extra work, tapi catch contradictions yang sering invisible saat trader excited dengan setup chart.

**KOREKSI DARI PLANNING AWAL:**
- ❌ Item 3 awalnya: "COT tidak extreme (<90th percentile historical)" — tidak feasible tanpa historical buffer
- ✅ Diganti: "COT positioning aligned dengan directional bias"

**Apa yang dikerjakan:**

Insert section baru `num: '00'` sebelum gate saat ini di `CK_SECTIONS`:

```
REGIME CHECK (PRE-GATE)
- Item 1: Regime saat ini sudah ditentukan (Risk-On / Neutral / Risk-Off)
- Item 2: CB bias kedua currency dalam pair sudah dikonfirmasi
- Item 3: COT positioning ALIGNED dengan directional bias (bukan extreme check)
- Item 4: Tidak ada high-impact event <6 jam ke depan untuk pair ini
- Item 5: Real yield differential mendukung directional bias
```

**Pair selector:**
- Tambahkan pair selector di top of CHECKLIST tab (28 major pairs dropdown)
- Tanpa pair, item 4 dan 5 tidak bisa auto-tick

**Auto-tick logic:**
- Item 1: auto-tick jika `risk_regime` API returned valid data dalam 30 menit terakhir
- Item 2: auto-tick jika kedua currencies di pair punya bias di `cb-status` (not null)
- Item 3: auto-tick jika COT untuk currency di pair menunjukkan alignment:
  - Long pair (USD/JPY long) → check Lev Net JPY negatif (short JPY) ✓
  - System hint: "Lev Funds JPY net: -45K (short) → aligned dengan long USD/JPY"
- Item 4: auto-tick setelah pair dipilih + query calendar untuk currencies tersebut
  - Jika ada event high-impact dalam 6 jam, BLOCK dengan warning, jangan auto-tick
- Item 5: system hint dengan computed differential
  - Format: "USD real +1.45%, JPY real -0.85% → spread +2.30% mendukung USD long"
  - User confirm manual

**UI requirements:**
- Each auto-ticked item shows small "✓ auto" badge
- User can manually un-tick auto items (override possible)
- Hint text visible in tooltip atau di bawah item

**Future upgrade path (TIDAK di Task 7):**
- Mulai store COT snapshots ke Redis time-series setelah Task 7 deploy
- Setelah 6 bulan ada baseline → Task 7.1 ganti alignment check ke percentile-based extremity check

**Acceptance:**
- Section baru muncul sebelum existing gate
- Pair selector functional
- Auto-tick works untuk item 1, 2, 3, 4
- Item 5 shows hint, requires manual confirm
- Manual override possible untuk semua auto-ticks

---

## ✅ TASK 5 — Trade Journal (SELESAI — commit 022dc40)
**Status: DEPLOYED**
**Prerequisite:** Task 1 ✓, Task 4 (untuk integrasi sizing → journal)

**Kegunaan:**
Tanpa journal, tidak ada feedback loop. Trader cenderung remember trade yang menang dan suppress yang kalah — hindsight bias yang menghancurkan improvement. Journal struktural memaksa user record: thesis sebelum entry, market context (regime/CB bias/COT) saat entry, dan post-mortem (apakah thesis benar tapi execution salah, atau thesis salah tapi luck). Setelah 50-100 trade, attribution analysis akan reveal pola: "Saya menang 70% saat regime aligned, tapi 30% saat counter-trend" — ini insight yang tidak akan didapat dari memori. Auto-snapshot makro saat entry = tidak perlu input manual data yang sudah ada di sistem.

**KOREKSI DARI PLANNING AWAL:**
- Task 4 ditambahkan sebagai prerequisite
- Schema diperluas dengan field yang missing

**Apa yang dikerjakan:**

**Backend** — `api/journal.js`:

Schema entry (CREATE):
```js
{
  id: string,
  device_id: string,
  created_at: ISO timestamp,
  status: 'open' | 'closed' | 'archived',

  // Trade setup
  pair: string,
  direction: 'long' | 'short',
  entry_price: number,
  stop_price: number,
  target_price: number,
  size_lots: number,
  rr_planned: number,
  time_horizon_days: number,

  // Market context snapshot (auto-filled)
  regime_at_entry: string,
  cb_bias_snapshot: object, // { USD: 'Hawkish', JPY: 'Dovish', ... }
  cot_snapshot: object,
  real_yield_snapshot: object,

  // Thesis
  thesis_text: string,
  driver_references: string[], // ['CPI 3.2% YoY beat', 'Powell hawkish testimony']

  // Optional
  screenshot_url: string | null,
  tags: string[], // ['event-driven', 'breakout', 'mean-reversion']

  // Cost tracking
  commission_paid: number | null,
}
```

Schema exit (PATCH):
```js
{
  exit_price: number,
  exit_at: ISO timestamp,
  exit_reason: 'target_hit' | 'stop_hit' | 'manual_close' | 'time_stop' | 'thesis_invalidated',
  r_actual: number, // computed: (exit - entry) / (entry - stop) for long
  attribution_notes: string,
  lessons_learned: string,
  thesis_was_correct: boolean,
  execution_was_correct: boolean,
}
```

Endpoints:
- `POST /api/journal` — create entry, returns `{ id, ...entry }`
- `PATCH /api/journal?id=...` — update with exit data
- `GET /api/journal?device_id=...&status=open` — list entries
- `GET /api/journal?id=...` — single entry detail
- `DELETE /api/journal?id=...` — soft-delete (set status='archived')

Storage:
- `journal:{device_id}:{entry_id}` — full entry JSON
- `journal_index:{device_id}` — Redis sorted set, score = created_at, member = entry_id

**Retention policy:**
- Closed trades: keep 365 hari, auto-archive setelah itu
- Archived trades: keep 1095 hari (3 tahun) untuk historical analysis
- User can export to CSV before deletion

**Frontend** — tab baru `JURNAL`:

List view:
- Filter: open / closed / archived / all
- Sort: newest first (default), R-multiple, pair
- Show: pair, direction, status, R-actual (jika closed), thesis truncated

Detail view:
- Full entry display
- Market context at entry time (read-only snapshots)
- Edit thesis button (open trades only)
- Close trade button (open trades only)

Form log new trade:
- Pre-filled with current regime, CB bias snapshot, real yield
- Pre-filled with sizing data jika user datang dari Task 4 calculator
- Pair selector
- Manual entry/stop/target prices
- Thesis textarea (required)
- Driver references multi-input
- Tags multi-select

Form close trade:
- Exit price (required)
- Exit reason dropdown
- Attribution: thesis correct? yes/no
- Attribution: execution correct? yes/no
- Lessons learned textarea
- Auto-compute R-actual

**Acceptance:**
- Trade can be logged in <60 seconds with auto-snapshots
- Sizing calculator → journal flow works (prefill)
- All entries retrievable across devices via device-id
- Soft-delete works (archived trades visible in archive view)
- Retention policy enforced

---

## ✅ TASK 6 — Structured Trade Thesis (SELESAI — commit 022dc40)
**Status: DEPLOYED**
**Prerequisite:** Task 1 ✓, Task 5

**Kegunaan:**
AI digest saat ini menghasilkan prose article — informatif tapi tidak actionable. User masih harus baca, ekstrak insight, dan decide pair. Structured thesis output (JSON dengan pair, direction, confidence, invalidation) = AI sudah pre-process informasi jadi rekomendasi yang clear. User tidak perlu sepakat dengan AI, tapi punya baseline thesis untuk dibandingkan dengan analisis sendiri. Confidence rating + invalidation condition juga memaksa AI ekspresikan ketidakpastian — jika confidence <3, sistem skip rekomendasi (lebih baik no setup daripada force trade). Integrasi ke journal = user bisa track AI thesis vs hasil aktual sebagai data point untuk evaluasi reliability AI ini.

**KOREKSI DARI PLANNING AWAL:**
- Tambah Groq JSON mode jika tersedia untuk reliability
- Two-stage prompting sebagai fallback
- TTL clarification: hard 12 jam, bukan "digest cycle"

**Apa yang dikerjakan:**

**Backend** — modify `api/market-digest.js`:

Setelah existing article + bias calls, tambah Call 3:

```js
// Call 3: Structured thesis extraction
const thesisRes = await fetch(GROQ_URL, {
  method: 'POST',
  headers: { /* ... */ },
  body: JSON.stringify({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: 'You return only valid JSON. No markdown, no commentary.' },
      { role: 'user', content: thesisPrompt }
    ],
    temperature: 0.1,
    max_tokens: 400,
    response_format: { type: 'json_object' }, // Use JSON mode if model supports
  }),
  signal: AbortSignal.timeout(15000),
});
```

Output schema (validated strict):
```js
{
  dominant_regime: 'risk_on' | 'risk_off' | 'neutral',
  strongest_currency: 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CAD' | 'AUD' | 'NZD' | 'CHF' | null,
  weakest_currency: same enum,
  pair_recommendation: string | null, // 'USD/JPY' format
  direction: 'long' | 'short' | 'no_trade',
  confidence_1_to_5: 1-5,
  invalidation_condition: string,
  time_horizon_days: 1-30,
  catalyst_dependency: string | null,
  generated_at: ISO timestamp,
}
```

**Reliability layers:**

1. **Primary attempt:** JSON mode + structured prompt
2. **Validation:** schema check, retry once jika malformed
3. **Two-stage fallback:** jika JSON mode tidak available, generate analysis dulu, lalu extract JSON di second call
4. **Final fallback:** return null, frontend show "Tidak ada rekomendasi clear"

**Logic constraints:**
- `pair_recommendation` HANYA disuggest jika:
  - `strongest_currency` dan `weakest_currency` berbeda
  - CB bias kedua currency divergent ≥2 levels apart (e.g., Hawkish vs Dovish, bukan Hawkish vs Neutral)
  - Confidence ≥ 3
- Jika kondisi tidak terpenuhi → `pair_recommendation: null`, `direction: 'no_trade'`

**Storage:**
- Redis key `latest_thesis` dengan TTL 12 jam (hard)
- Field `generated_at` agar UI bisa show staleness

**Frontend** — card di atas tab RINGKASAN:

```
┌─────────────────────────────────────┐
│ THESIS HARI INI                     │
│ Generated 4 jam lalu — refresh?     │
├─────────────────────────────────────┤
│ Pair: USD/JPY                       │
│ Direction: LONG                     │
│ Confidence: ★★★☆☆ (3/5)             │
│                                     │
│ Invalidation:                       │
│ Jika Powell pivot dovish atau       │
│ JPY intervention dari MoF           │
│                                     │
│ Time horizon: 5-7 hari              │
│ Depends on: NFP Friday              │
│                                     │
│ [Gunakan untuk Jurnal]              │
└─────────────────────────────────────┘
```

Tombol "Gunakan untuk Jurnal" → prefill journal form dengan:
- Pair, direction
- Thesis text dari article + invalidation
- Time horizon

Jika `direction: 'no_trade'` atau confidence <3:
```
TIDAK ADA SETUP CLEAR HARI INI
[explanation text]
```

**Confidence calibration monitoring:**
- Track distribusi confidence values di Redis (`thesis_confidence_log`)
- Jika >50% recommendations punya confidence 5/5, AI overconfident → flag untuk prompt tuning

**Acceptance:**
- JSON output validates to schema 95%+ time
- Two-stage fallback works jika JSON mode unreliable
- Confidence below 3 hides recommendation, shows "no clear setup"
- Pair recommendation hanya muncul saat CB bias divergence ≥2 levels
- "Gunakan untuk Jurnal" prefill works correctly

---

## ✅ TASK 8 — Configurable Playbooks (SELESAI — commit 022dc40)
**Status: DEPLOYED — semua 4 playbook (smc_ict, macro_momentum, event_driven, mean_reversion) sekaligus**
**Prerequisite:** Task 7

**Kegunaan:**
Satu checklist hardcoded mengasumsikan ada satu cara trade — itu tidak realistis. Trade FOMC butuh checklist berbeda dari swing 2 minggu macro divergence. Foundation refactor ini siapkan struktur untuk multiple playbook tanpa break existing flow. Belum tambah playbook baru di task ini — tujuannya: memastikan migrasi state user existing (yang sudah pakai checklist Daun Merah lama) tidak hilang, dan UI selector siap untuk Task 8b/c/d.

**KOREKSI DARI PLANNING AWAL:**
- Task 8 monolith dipecah jadi 8a + 8b + 8c + 8d
- 8a hanya foundation refactor, tidak tambah playbook baru

**Apa yang dikerjakan:**

Refactor existing checklist:
```js
const PLAYBOOKS = {
  'smc-ict': {
    id: 'smc-ict',
    name: 'SMC / ICT',
    description: 'Smart Money Concepts — Daun Merah methodology asli',
    sections: CK_SECTIONS, // existing array
  },
  // 8b, 8c, 8d akan tambah ke sini
};

let activePlaybook = localStorage.getItem('active_playbook') || 'smc-ict';
```

UI changes:
- Playbook selector dropdown di top of CHECKLIST tab
- Hanya 1 pilihan available (smc-ict) di Task 8a
- Active playbook label visible
- Selection persisted in localStorage

**Migration path:**
- Existing user state di localStorage (`daunmerah_v2`) tetap valid
- State key di-namespace per playbook: `daunmerah_v2_smc-ict`, `daunmerah_v2_macro-momentum`, etc.
- Migration: existing `daunmerah_v2` → rename to `daunmerah_v2_smc-ict` saat first load

**Acceptance:**
- Existing checklist functionality unchanged
- Playbook selector visible (1 option)
- State migration works
- Foundation ready untuk Task 8b/c/d

---

## ✅ TASK 3 — Rate Path Expectations (SELESAI — commit 022dc40)
**Status: DEPLOYED**

> **CATATAN PENTING:** Implementasi final berbeda dari plan. CME FedWatch = SPA, tidak bisa di-scrape. Atlanta Fed juga tidak feasible. Final impl: FRED SOFR/EFFR + heuristic probability + hardcoded FOMC dates 2026. Response includes `data_note` field yang transparently explain ini approximation.
**Prerequisite:** Task 1 ✓

**Kegunaan:**
"Fed rate 4.50% Hold" hanya snapshot — yang menggerakkan FX adalah ekspektasi pasar tentang rate FUTURE. Jika market expect Fed cut 50bps dalam 6 bulan, USD melemah hari ini meski rate masih hold. Tanpa rate path, AI bias assessment hanya tone reading dari headline ("Powell sounded hawkish"); dengan rate path, Anda lihat market actually pricing apa. Saat AI bilang "Hawkish" tapi market price 75bps cuts → sinyal AI salah baca atau market overpricing dovish (entry opportunity). Kalibrasi expectation vs reality ini krusial untuk trading FOMC dan ECB events.

**KOREKSI DARI PLANNING AWAL:**
- ❌ Awalnya: scrape CME FedWatch — tidak feasible (SPA, JavaScript-rendered)
- ✅ Yang benar: Atlanta Fed Market Probability Tracker (primary), Polymarket API (fallback)

**Apa yang dikerjakan:**

**Backend** — `api/rate-path.js`:

Primary source: **Atlanta Fed Market Probability Tracker**
- URL: `https://www.atlantafed.org/cenfis/market-probability-tracker`
- Format: lebih scrape-friendly daripada CME, update mingguan
- Parse table probabilitas untuk 3 FOMC meeting berikutnya

Fallback source: **Polymarket API**
- Endpoint: prediction market untuk Fed decisions
- Format: JSON, public access
- Berguna untuk cross-validation atau jika Atlanta Fed down

Tertiary fallback: **Compute dari Fed Funds futures (ZQ)**
- Source: Stooq `zq.f` time series
- Math: `Implied rate at month X = 100 - ZQ_X price`
- Approximate probability dari distance ke target rate

Output:
```js
{
  USD: {
    next_meeting: {
      date: '2026-05-01',
      prob_hold: 78,
      prob_cut_25: 22,
      prob_cut_50: 0,
      prob_hike_25: 0,
    },
    cumulative_3m_bps: -25,
    cumulative_6m_bps: -50,
    source: 'atlanta_fed' | 'polymarket' | 'computed_zq',
    fetched_at: ISO,
  }
}
```

Cache: Redis `rate_path` TTL 4 jam

**Frontend** — extend USD CB card:
- Below "Bias": `Next: Hold 78% / Cut 22%`
- Below: `6M implied: -42bps`
- Source attribution dot (tooltip): "Source: Atlanta Fed"

**Architecture for future:**
- Add EUR (ECB OIS-implied), GBP (BoE OIS), JPY (BoJ OIS) di future iterations
- Function structure menerima currency parameter, default 'USD'

**Acceptance:**
- USD rate path visible
- Atlanta Fed parser robust (test multiple weeks data)
- Polymarket fallback works
- Source attribution visible
- Code architected untuk currency expansion

---

## ✅ TASK 9 — Cross-Asset Correlation Snapshot (SELESAI — commit 022dc40)
**Status: DEPLOYED**

> **CATATAN:** Diimplementasikan sebagai on-demand (tombol, bukan auto-fetch) karena 10 Stooq CSV terlalu lambat. 20d+60d windows (bukan 5d+20d seperti plan). Anomaly threshold `|r20-r60| > 0.4`.
**Prerequisite:** Task 1 ✓

**Kegunaan:**
Korelasi antar asset (DXY, gold, oil, SPX, VIX) biasanya stabil dalam regime tertentu — DXY dan EUR/USD ~−0.92, SPX dan VIX ~−0.80. Saat korelasi BREAK dari norma, itu sinyal regime shift atau event-driven dislocation. Contoh: jika DXY-Gold korelasi tiba-tiba dari -0.6 jadi +0.3, ada sesuatu yang aneh di market (mungkin kekhawatiran de-dollarization, atau central bank gold buying intensif). Trader yang aware regime break bisa adjust strategi atau exit posisi. 5-day fast window deteksi shift cepat (event-driven), 20-day slow window konfirmasi regime sustained. Ini bukan signal generator — ini early warning system untuk question your assumptions.

**KOREKSI DARI PLANNING AWAL:**
- Tambah 5-day fast correlation untuk event-driven shift detection
- Mobile UI redesign (matrix terlalu padat di 380px)

**Apa yang dikerjakan:**

**Backend** — `api/correlations.js`:

Symbols (Stooq mapping):
- DXY: `^dxy`
- EURUSD: `eurusd`
- GBPUSD: `gbpusd`
- USDJPY: `usdjpy`
- AUDUSD: `audusd`
- Gold: `xauusd`
- WTI: `cl.f`
- SPX: `^spx`
- VIX: `^vix`
- US10Y: `^tnx`

Computation:
- Fetch 60 hari daily closes per symbol
- **20-day rolling correlation** (slow signal)
- **5-day rolling correlation** (fast signal — event detection)
- 1-year average correlation per pair (baseline)
- Flag pairs di mana current 5-day correlation deviates >2 std dari 1-year average

Output:
```js
{
  matrix_20d: { 'DXY-EURUSD': -0.92, ... },
  matrix_5d: { 'DXY-EURUSD': -0.78, ... },
  baseline_1y: { 'DXY-EURUSD': -0.91, ... },
  anomalies: [
    {
      pair: 'DXY-EURUSD',
      current_5d: -0.78,
      baseline: -0.91,
      deviation_std: 2.3,
      severity: 'high',
    }
  ],
  fetched_at: ISO,
}
```

Cache: Redis `correlations` TTL 24 jam (regenerate daily after market close)

**Frontend:**

Desktop (>=768px): full heatmap 10x10
- Color: red (strong negative) → gray (neutral) → green (strong positive)
- Anomalies: border highlight + tooltip
- Toggle: 20-day vs 5-day vs deviation view

Mobile (<768px): simplified view
- DXY vs everything (1 column, 9 rows)
- ATAU: tappable list "Show: DXY / Pair Trades / Commodities / Risk"
- Anomalies di top sebagai card list
- Full matrix accessible via "Lihat tabel lengkap" button (modal)

Tooltip text per anomaly:
- "Korelasi 5-day saat ini menyimpang dari norma historis. Mungkin ada regime shift atau event-driven dislocation."

**Acceptance:**
- 5-day dan 20-day correlation tersedia
- Anomaly detection works (test dengan period historical regime change)
- Mobile UI usable di 380px viewport
- Source data documented

---

## ✅ TASK 8b — Macro Momentum Playbook (termasuk dalam commit 022dc40)
**Status: DEPLOYED — dikerjakan bersamaan dengan 8a/c/d**

**Kegunaan:**
Playbook untuk swing 1-4 minggu yang bersandar pada macro divergence (Fed hawkish vs ECB dovish, growth differential, real yield spread). Cocok untuk trader yang punya time horizon swing dan tidak ingin scalp daily news. Section akan fokus ke: konfirmasi divergence persistent (bukan satu data point), entry di pullback ke level structural mingguan, hold sampai macro thesis invalidated (bukan sampai stop hit).

Sections lengkap akan di-detail setelah 8a deployed.

---

## ✅ TASK 8c — Event-Driven Playbook (termasuk dalam commit 022dc40)
**Status: DEPLOYED**

**Kegunaan:**
Playbook untuk trade specific event: FOMC, CPI, NFP, central bank decisions. Ini event yang punya structure relatif konsisten (volatility spike, reaksi initial sering reverse, ada window 30-60 menit untuk fade). Berbeda dari macro momentum karena holding period pendek (jam sampai 1-2 hari). Section akan fokus ke: positioning sebelum event (flat atau hedged), pre-defined scenario A/B/C berdasarkan rilis, entry trigger setelah initial spike settle, exit di defined target atau time stop.

Sections lengkap akan di-detail setelah 8a deployed.

---

## ✅ TASK 8d — Mean Reversion Playbook (termasuk dalam commit 022dc40)
**Status: DEPLOYED**

**Kegunaan:**
Playbook untuk fade extreme moves di range conditions. **Catatan metodologis: mean reversion di retail FX di rezim trending punya failure rate tinggi** — mayoritas major pairs sebenarnya trending atau ranging dengan trend bias, bukan true mean-reverting. Playbook ini hanya cocok untuk: (a) cross pairs yang historically range-bound, (b) overbought/oversold extremes setelah news spike, (c) saat regime classifier confirm "low volatility ranging". Pertimbangkan apakah perlu separate playbook atau cukup tag di journal. Tidak rekomendasikan execute kecuali ada use case spesifik yang teruji.

---

## ✅ TASK 10a — Branding Consistency (SELESAI — commit 022dc40)
**Status: DEPLOYED**

**Kegunaan:**
Saat ini "FJFeed" muncul di README, package.json, push.js Telegram messages — tapi UI dan manifest sudah "Daun Merah". Inkonsistensi ini bingungkan saat: share screenshot (notifikasi bilang FJFeed tapi app bilang Daun Merah), review repo (README pakai nama lama), atau onboarding orang lain ke project. Pure cosmetic tapi 30 menit fix.

Update ke "Daun Merah" di:
- README.md
- package.json (`name` field)
- `api/push.js` (Telegram message templates)
- Notification titles
- manifest.json (sudah benar)

---

## ✅ TASK 10b — CFTC Parser Robustness (SELESAI — commit 022dc40)
**Status: DEPLOYED**

**Kegunaan:**
CFTC text format untuk COT report fragile — sewaktu-waktu CFTC bisa ubah whitespace, kolom, atau heading. Parser saat ini akan break diam-diam (return data partial atau kosong) tanpa user tahu. UI lalu show data lama yang user kira fresh. Robustness layer: jika parsed currencies <5 (artinya parse rusak), fallback ke stale cache + Telegram alert ke admin. User dapat indikator "Data lama" di UI, bukan data fake yang terlihat fresh. Lebih baik gagal jujur daripada gagal diam-diam.

- Jika parsed currencies <5 → return stale cache + log warning
- Jika fresh parse gagal DAN no stale cache → return error JSON dengan detail
- Tambah validation: total positions count harus reasonable (>10K per currency)
- Alert via Telegram jika parser gagal 2x berturut-turut

---

## ✅ TASK 10e — Prompt Externalization (SELESAI — commit 022dc40)
**Status: DEPLOYED**

> Admin endpoint: `GET/POST/DELETE /api/admin-prompts?key=prompt_digest|prompt_bias|prompt_thesis`  
> Header auth: `x-admin-secret: <CRON_SECRET>`

**Kegunaan:**
Prompt untuk Groq saat ini hardcoded di `market-digest.js`. Tiap kali Anda mau eksperimen ubah prompt (misalnya tambah instruction, ganti tone, tweak structured output), harus edit code → commit → push → wait Vercel deploy → test. Slow iteration cycle. Externalize prompt ke Redis = ubah prompt via admin endpoint, langsung effect di next request. Juga enable A/B testing: simpan multiple versions, switch via flag, observe mana yang menghasilkan output lebih bagus. Critical untuk Task 6 (structured thesis) yang akan butuh prompt tuning intensif.

- Pindah Groq prompts dari hardcoded di `market-digest.js` ke Redis keys:
  - `prompt_digest`
  - `prompt_bias`
  - `prompt_thesis` (Task 6)
- Admin endpoint `POST /api/admin/prompt` (auth via `ADMIN_SECRET` header)
- Fallback ke hardcoded jika Redis unavailable
- A/B testing capability: simpan multiple versions, switch via Redis flag

---

## ⬜ TASK 10f — Health Monitoring (NEW)
**Status: BELUM DIMULAI**

**Kegunaan:**
Saat ini Anda hanya tahu source down kalau buka app dan lihat data kosong/aneh. FRED bisa down sehari, ForexFactory bisa rate-limit Anda, Stooq bisa ganti format CSV — semua silent failure. Health endpoint + Telegram alert = tahu masalah dalam jam, bukan setelah miss trading session. Penting saat sistem makin banyak external dependencies (Task 1 udah 3 source, Task 2/3 tambah lagi, Task 9 lebih banyak). Tanpa monitoring, debugging "kenapa data ini kosong" jadi proses manual yang melelahkan.

**Apa yang dikerjakan:**
- Buat `api/health.js`
- Test semua external sources: FRED, Stooq, ForexFactory, FinancialJuice, CFTC, Atlanta Fed (jika Task 3 deployed)
- Return JSON: `{ source: 'OK' | 'DEGRADED' | 'DOWN', last_success: ISO, ... }`
- Setup cron-job.org untuk hit endpoint setiap 1 jam
- Telegram alert jika ada source DOWN >2 jam

**Acceptance:**
- Endpoint returns status untuk semua external dependencies
- Alert mechanism works (test dengan disable salah satu source)
- Cron schedule documented

---

## ⬜ TASK 10g — Redis Migration Safety (NEW)
**Status: BELUM DIMULAI**

**Kegunaan:**
Anda sudah punya pattern bermasalah: `cot_cache` (lama, deprecated) dan `cot_cache_v2` (baru) dua-duanya ada di Redis. Setelah Task 2-9 deployed, akan ada banyak keys baru, beberapa akan deprecate, beberapa akan rename. Tanpa registry, eventually Anda lupa key mana yang masih dipakai dan mana yang sampah — buang storage Redis (yang ada quota). Registry ini = single source of truth tentang Redis keys yang aktif, history migration, dan utility cleanup. Maintenance hygiene yang invisible saat dipakai tapi mahal saat tidak ada.

**Apa yang dikerjakan:**
- Buat `api/redis-keys.js` (admin only)
- List semua Redis keys yang dipakai sistem dengan:
  - Schema version
  - Migration history
  - Last access timestamp
  - Size/cardinality
- Cleanup utility untuk deprecated keys (e.g., `cot_cache` lama setelah `cot_cache_v2` stable)

---

## ⬜ TASK 10h — Rate Limiting (NEW)
**Status: BELUM DIMULAI**

**Kegunaan:**
Saat ini API endpoint Anda fully open. Kalau ada bot scrape atau accidentally hit dari script user yang stuck di loop, Vercel function execution time spike, biaya tak terkendali, dan mungkin di-rate-limit oleh upstream (FRED, Stooq) yang merugikan semua user lain. Rate limiter sederhana per IP = perlindungan dasar tanpa user experience hit (60 req/menit cukup longgar untuk normal usage). Whitelist cron-job.org agar background tasks tidak terblokir. Header `X-RateLimit-Remaining` agar developer tools transparent kalau ada masalah.

**Apa yang dikerjakan:**
- Simple rate limiter via Redis (per IP)
- Default: 60 requests/menit per IP per endpoint
- Whitelist untuk cron services (cron-job.org IPs)
- Header `X-RateLimit-Remaining` di response
- 429 status jika exceeded

---

## DEPENDENCY GRAPH

```
Task 1 ✓ ─────┬─→ Task 2 ─────┬─→ Task 7 ─→ Task 5 ─→ Task 6
              │               │
              ├─→ Task 3      │
              │               │
              ├─→ Task 9      │
              │               │
Task 4 ───────┘───────────────┘
              
Task 7 ─→ Task 8a ─→ Task 8b/c/d

Task 10c ─ independent (quick win)
Task 10d ─ independent (quick win)
Task 10a ─ anytime
Task 10b ─ anytime
Task 10e ─ anytime
Task 10f ─ after Task 3 (untuk monitor source baru)
Task 10g ─ anytime
Task 10h ─ anytime
```

---

## DEPLOYMENT ORDER (FINAL)

| Order | Task | Why |
|-------|------|-----|
| 1 | Task 10c | Quick win, reliability boost |
| 2 | Task 10d | Quick win, no risk |
| 3 | Task 2 | Foundational data, enables Task 7 item 5 |
| 4 | Task 4 | Independent, enables Task 5 |
| 5 | Task 7 | Connects Task 1 + 2 to checklist |
| 6 | Task 5 | Connects Task 4 + 7 to journal |
| 7 | Task 6 | Connects digest to journal |
| 8 | Task 8a | Refactor only, low risk |
| 9 | Task 3 | Data source uncertain, defer |
| 10 | Task 9 | Nice-to-have analytics |
| 11 | Task 8b/c/d | Methodology expansion |
| 12 | Task 10a/b/e/f/g/h | Polish + ops |

Total estimasi: 80-120 jam coding terdistribusi. Saran ritme: 1 task per 2-4 hari, deploy dan observe production sebelum lanjut ke task berikutnya.
