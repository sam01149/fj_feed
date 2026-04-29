# DAUN MERAH — PROGRESS & STATUS

> **Last updated:** 2026-04-29
> **Branch:** main

---

## FITUR UTAMA (SELESAI)

```
Task 1   ✅  Risk Regime Indicator          commit a3baa1e
Task 2   ✅  Real Yield Differential        commit bd16d06 + 80030ce
Task 3   ✅  Rate Path Expectations         commit 022dc40 (SOFR heuristic)
Task 4   ✅  Position Sizing Calculator     commit 9e5f7fa
Task 5   ✅  Trade Journal                  commit 022dc40
Task 6   ✅  Structured Trade Thesis AI     commit 022dc40
Task 7   ✅  Regime Gate di Checklist       commit 022dc40
Task 8   ✅  Configurable Playbooks (4)     commit 022dc40
Task 9   ✅  Cross-Asset Correlations       commit 022dc40
Task 10a ✅  Branding Consistency           commit 022dc40
Task 10b ✅  CFTC Parser Robustness         commit 022dc40
Task 10c ✅  RSS Cache to Redis             commit bd16d06
Task 10d ✅  Calendar Refetch 60min         commit bd16d06
Task 10e ✅  Prompt Externalization         commit 022dc40
Task 10f ✅  Health Monitoring              commit 658a1a6
Task 10g ✅  Redis Key Registry             commit 658a1a6
Task 10h ✅  Rate Limiting                  commit 658a1a6
```

```
[POST-TASK]
FIX      ✅  Vercel 12-function limit       commit 95db702
FIX      ✅  Mobile bottom nav + SVG icon   commit 108ffab
FIX      ✅  market-digest RSS URL broken   commit 6f48bcb
FEAT     ✅  Tab PETUNJUK (SOP)             commit b1729e9
FEAT     ✅  Prompt XAUUSD scalping         (dalam session konsolidasi)
```

---

## BUG FIX SESSION 2026-04-27 (Gap Analysis)

Gap analysis dari AI eksternal menemukan bug-bug berikut (semua P0 dikonfirmasi valid lewat review kode manual):

```
P0-1  ✅  sw.js FETCH_URL Netlify → /api/feeds?type=rss
P0-2  ✅  rc4: ev.impact !== 'high' (lowercase) → 'High' (match API)
P0-3  ✅  rc4: ev.datetime undefined → construct dari ev.date + ev.time_wib (WIB=UTC+7)
P0-4  ✅  convertToWIB: +7 (UTC asumsi salah) → +12/+11 (EST/EDT ke WIB, auto DST detect)
P0-5  ✅  rate-path UI: tambah label "(Est.)" + tooltip "Estimasi — bukan probabilitas pasar"
P1-1  ✅  _ratelimit.js: INCR+EXPIRE fire-and-forget → SET NX EX + INCR (atomic, no orphan keys)
P1-2  ✅  subscribe.js: base64 slice(0,80) → crypto.createHash('sha256') full hex (no collision)
P2-1  ✅  market-digest.js digest_history: GET/SET → LPUSH/LTRIM (atomic list, no race)
P2-2  ✅  feeds.js rssMemCache module-level var → removed, Redis-only (cold-start safe)
P3-1  ✅  _lastThesis: persist ke localStorage + load saat init (tombol jurnal tidak fail lagi)
```

---

## AI DIGEST QUALITY UPGRADE — 2026-04-29

Fokus: meningkatkan kualitas analisis AI untuk trader XAU/USD + fix UX persistence/cooldown.

```
PROMPT   ✅  History summary 200→700 chars (FX continuity)
PROMPT   ✅  CB bias: filtered headlines only (bukan all 80), max_tokens 200→400
PROMPT   ✅  Trade thesis: calBlock injected, calendar-aware invalidation_condition
PROMPT   ✅  XAUUSD prompt rewrite total — 3-part structured analysis:
              (1) driver dominan + bukti konkret, (2) tekanan fundamental, (3) trigger 24h
              Explicit: no live price, conflict resolution required, "conflicting" hanya jika setara
PROMPT   ✅  XAUUSD continuity — xauHistoryBlock injected sebagai blok terpisah dari FX history
DATA     ✅  GOLD_KEYWORDS filter (3 tier: direct/real yield/safe haven) — capped 25 items
DATA     ✅  goldBlock injected ke Call 1 sebagai blok terpisah "HEADLINE RELEVAN XAUUSD"
DATA     ✅  FX history disimpan pre-XAUUSD slice (bukan potong 700 chars sembarang)
DATA     ✅  xau_history Redis key — hanya XAUUSD paragraph (600 chars), 4 sesi, load parallel
THESIS   ✅  Call 3 extended: 5 field XAU baru + validasi enum (xau_bias, xau_dominant_driver,
              xau_driver_evidence, xau_key_trigger, xau_confidence)
THESIS   ✅  briefingForThesis: 900 chars FX + extracted XAUUSD section, overlap guard >900
THESIS   ✅  max_tokens 300→500, xau_confidence example 1→3, xau_key_trigger fallback option
PERSIST  ✅  latest_article disimpan ke Redis (EX 21600) setelah setiap generate sukses
PERSIST  ✅  ?mode=cached endpoint — serve dari Redis tanpa Groq calls (no token cost)
UX       ✅  loadCachedRingkasan() — auto-fetch cache saat buka tab jika tidak ada in-memory data
UX       ✅  startCooldown() / tickCooldown() — countdown 90s, persists via localStorage
UX       ✅  Generate button: "Tunggu Xs" live countdown, re-enables otomatis
UX       ✅  Meta bar: gold_count display, from_cache indicator, method label "Groq AI"
```

commit: `28efb84`

---

## ISSUES YANG MASIH TERBUKA (P1-P3)

### P1 — Akurasi/Modal
- [ ] Pip value cross-pair approximation — error 10-30% untuk pair tanpa USD direct (EUR/JPY, GBP/JPY dll). Risk sizing 2% limit bisa bocor.
- [ ] CB rates stale — ECB/BOE/RBA/RBNZ di `api/cb-status.js` kemungkinan perlu update manual. Cek meeting April-May 2026.
- [ ] Real yields stale — EUR `as_of` 2026-01-15 sudah >90 hari. Update `api/real-yields.js` setelah ECB SPF Q2 release.

### P2 — Robustness
- [ ] cb_bias race condition — merge logic di `market-digest.js` masih read-modify-write. Low frequency tapi ada.
- [ ] Groq error isolation — 3 Groq calls sequential; Call 1 timeout → seluruh endpoint gagal. Partial response handling tidak ada.
- [ ] Service Worker update flow — tidak ada skipWaiting notification, cache versioning tidak berfungsi.
- [ ] COT column validation — parser assume kolom 4-9 tanpa sanity check. Silent wrong data jika CFTC reformat.

### P3 — Polish
- [ ] Checklist state per-pair — `ckState` shared; manual items carry over saat ganti pair.
- [ ] Journal N+1 query — 51 Redis roundtrips untuk 50 entries. Gunakan MGET.
- [ ] SOP/Petunjuk stale — masih sebut 2 playbook, sekarang ada 4. XAUUSD analysis section belum ada.
- [ ] Push dedup `seen_guids` max 500 — edge case republish FinancialJuice.
- [ ] `correlations.js` Yahoo Finance fragile — tidak ada User-Agent rotation, tidak ada fallback source.
- [ ] Manifest icons SVG only — iOS Safari butuh PNG fallback.
- [ ] Self-maintaining memory — digest_history masih FIFO (LTRIM). Belum ada semantic compression / dedup.

---

## CATATAN PENTING UNTUK SESSION BERIKUTNYA

1. **CB rates perlu update manual** — cek ECB April 2026 meeting, BOE update, update `api/cb-status.js` object `CB_DATA`.
2. **Real yields perlu update manual** — ECB SPF Q2 biasanya release April. Update `api/real-yields.js` jika sudah ada data baru.
3. **FOMC dates 2027** — `api/rate-path.js` masih punya 2027-04-29 yang spekulatif. Verifikasi ketika Fed publish kalender resmi.
4. **Pip value calculator** — fix yang proper butuh fetch USD/quote spot untuk cross-pair conversion. Atau batasi calculator ke pairs dengan USD direct dan tampilkan disclaimer untuk yang lain.
5. **Self-maintaining memory** — sistem saat ini FIFO. Rencana: semantic compression (Groq lightweight call) ketika history penuh, dedup jika narrative sama.
6. **Groq free tier** — ~7,900 token per digest request. Aman 3–5x/hari. Jika upgrade paid tier, Call 4 terpisah untuk XAU bisa diaktifkan.
