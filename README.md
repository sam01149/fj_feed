# Daun Merah — Financial Feed App
Agregator berita finansial real-time dengan AI digest, CB bias tracker, dan trade thesis untuk trader forex/XAU Indonesia.

## Fitur Utama
- **Live RSS Feed** — Berita real-time dari FinancialJuice, cache 50 detik via Redis.
- **AI Market Digest** — Briefing pre-session Bahasa Indonesia: analisis FX macro + XAUUSD fundamental, dihasilkan oleh Groq (llama-3.3-70b-versatile). Termasuk continuity tracking antar sesi.
- **XAU/USD Analysis** — Dedicated gold headline filter (real yield, safe haven, ETF flow, geopolitik), analisis 3 channel (USD/real yields, safe haven, risk sentiment), trigger 24 jam ke depan.
- **CB Bias Tracker** — Stance kebijakan moneter 8 major currencies (Hawkish → Dovish), diupdate otomatis setiap digest.
- **Structured Trade Thesis** — JSON thesis: dominant regime, strongest/weakest currency, pair recommendation, + XAU bias terstruktur (xau_bias, xau_dominant_driver, xau_driver_evidence, xau_key_trigger).
- **Digest Persistence** — Digest terakhir disimpan di Redis (TTL 6 jam), auto-load saat refresh tanpa generate ulang.
- **Cooldown Timer** — Countdown 90 detik setelah generate, persists across refresh via localStorage.
- **Economic Calendar** — Event high-impact 3 hari ke depan dari Forex Factory, timezone WIB.
- **CB Rates & Real Yields** — Rate kebijakan 8 CB + real yield differential USD vs EUR/GBP/JPY.
- **COT Report** — CFTC positioning data untuk major pairs.
- **Risk Regime Indicator** — Risk-on/off/neutral dari multi-asset signals.
- **Position Sizing Calculator** — Risk % → lot size dengan pip value per pair.
- **Trade Journal** — Log trade dengan Redis persistence.
- **PWA** — Installable, Service Worker, push notification untuk Market Moving news.

## Stack Teknologi
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Vercel Serverless Functions (Node.js)
- **AI**: Groq API — llama-3.3-70b-versatile (3 calls per digest: briefing, CB bias, trade thesis)
- **Cache/DB**: Upstash Redis (RSS cache, digest history, CB bias, trade thesis, XAU history)
- **Deployment**: Vercel
- **Data Sources**: FinancialJuice RSS, Forex Factory XML Calendar, CFTC COT, Yahoo Finance

## Struktur Direktori
```
├── index.html              # UI utama + semua frontend logic
├── sw.js                   # Service Worker (push notification, background sync)
├── manifest.json           # PWA config
└── api/
    ├── market-digest.js    # AI digest: Groq 3-call pipeline (briefing + CB bias + thesis)
    ├── feeds.js            # RSS proxy + Redis cache
    ├── calendar.js         # Forex Factory calendar + CB status
    ├── cb-status.js        # CB rates static data
    ├── real-yields.js      # Real yield differential
    ├── rate-path.js        # SOFR rate path expectations
    ├── correlations.js     # Cross-asset correlations (Yahoo Finance)
    ├── risk-regime.js      # Risk regime indicator
    ├── sizing-history.js   # Position sizing history
    ├── journal.js          # Trade journal
    ├── subscribe.js        # Push notification subscription
    ├── admin.js            # Admin utilities
    └── _ratelimit.js       # Rate limiter (Upstash Redis)
```

## Environment Variables
```
GROQ_API_KEY                # Groq API key (free tier: 6,000 TPM)
UPSTASH_REDIS_REST_URL      # Upstash Redis REST URL
UPSTASH_REDIS_REST_TOKEN    # Upstash Redis REST token
VAPID_PUBLIC_KEY            # Push notification public key
VAPID_PRIVATE_KEY           # Push notification private key
```

## AI Digest — Token Budget (Groq Free Tier)
| Call | Fungsi | ~Token |
|---|---|---|
| Call 1 | Market briefing + XAUUSD analysis | ~5,800 |
| Call 2 | CB bias assessment (8 currencies) | ~900 |
| Call 3 | FX + XAU trade thesis (JSON) | ~1,200 |
| **Total/press** | | **~7,900** |

Free tier limit: 6,000 TPM. Aman untuk penggunaan personal (3–5x/hari). Cooldown 90 detik antar generate.

## Redis Keys
| Key | Isi | TTL |
|---|---|---|
| `rss_cache` | RSS XML dari FinancialJuice | 50s |
| `digest_history` | 7 FX digest summaries (LPUSH list) | - |
| `xau_history` | 4 XAUUSD paragraph summaries (LPUSH list) | - |
| `latest_article` | Full payload digest terakhir | 6 jam |
| `cb_bias` | CB stance 8 currencies + confidence | - |
| `latest_thesis` | Trade thesis terakhir | 6 jam |
| `prompt_digest` | Override prompt digest (opsional) | - |
