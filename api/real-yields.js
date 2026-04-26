// api/real-yields.js
// Real (inflation-adjusted) yield per major currency.
// USD: FRED DGS10 (nominal 10Y) − FRED T10YIE (TIPS breakeven) = real yield.
// Others: FRED long-term bond yield − survey-based inflation expectation (hardcoded, refresh quarterly).
// Cached in Redis under 'real_yields' for 6 hours.

const CACHE_KEY = 'real_yields'
const CACHE_TTL = 6 * 60 * 60 // 6 hours in seconds

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

// Hardcoded inflation expectations with mandatory source + refresh date.
// Update each quarter. If as_of > 90 days old, UI shows stale indicator.
const INFLATION_EXPECTATIONS = {
  // Source: ECB Survey of Professional Forecasters Q1 2026 — refresh Jul 2026
  EUR: { value: 2.1,  source: 'ECB SPF Q1 2026',    as_of: '2026-01-15' },
  // Source: BoE Inflation Attitudes Survey Feb 2026 — refresh May 2026
  GBP: { value: 3.2,  source: 'BoE IAS Feb 2026',   as_of: '2026-02-12' },
  // Source: BoJ Tankan Short-term Economic Survey Mar 2026 — refresh Jun 2026
  JPY: { value: 2.6,  source: 'BoJ Tankan Mar 2026', as_of: '2026-03-01' },
  // Source: Bank of Canada MPR Jan 2026 — refresh Apr 2026
  CAD: { value: 2.3,  source: 'BoC MPR Jan 2026',   as_of: '2026-01-29' },
  // Source: RBA Statement on Monetary Policy Feb 2026 — refresh May 2026
  AUD: { value: 3.2,  source: 'RBA SoMP Feb 2026',  as_of: '2026-02-18' },
  // Source: RBNZ Monetary Policy Statement Feb 2026 — refresh May 2026
  NZD: { value: 2.2,  source: 'RBNZ MPS Feb 2026',  as_of: '2026-02-19' },
  // Source: SNB Inflation Forecast Dec 2025 — refresh Mar 2026
  CHF: { value: 0.4,  source: 'SNB Dec 2025',       as_of: '2025-12-12' },
}

// FRED series IDs for 10Y government bond nominal yields (monthly for non-USD)
const FRED_NOMINAL_SERIES = {
  EUR: 'IRLTLT01EZM156N', // Euro area 10Y
  GBP: 'IRLTLT01GBM156N', // UK 10Y Gilt
  JPY: 'IRLTLT01JPM156N', // Japan 10Y JGB
  CAD: 'IRLTLT01CAM156N', // Canada 10Y
  AUD: 'IRLTLT01AUM156N', // Australia 10Y
  NZD: 'IRLTLT01NZM156N', // New Zealand 10Y
  CHF: 'IRLTLT01CHM156N', // Switzerland 10Y
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-cache')

  if (req.method === 'OPTIONS') return res.status(204).end()

  // Serve Redis cache if fresh
  try {
    const cached = await redisCmd('GET', CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      const ageMs = Date.now() - new Date(parsed.computed_at).getTime()
      if (ageMs < CACHE_TTL * 1000) return res.status(200).json(parsed)
    }
  } catch(e) {
    console.warn('real-yields: Redis GET failed:', e.message)
  }

  const results = {}

  // USD: both nominal + breakeven from FRED (daily, TIPS-derived — most accurate)
  try {
    const [nomRes, beRes] = await Promise.all([
      fetchFred('DGS10'),
      fetchFred('T10YIE'),
    ])
    const nominal = nomRes.latest
    const inflation_exp = beRes.latest
    const real = +(nominal - inflation_exp).toFixed(2)
    results.USD = {
      nominal, inflation_exp, real,
      source_nominal: 'FRED DGS10',
      source_inflation: 'FRED T10YIE (TIPS breakeven)',
      as_of: nomRes.date,
      stale: false,
    }
  } catch(e) {
    console.warn('real-yields: USD fetch failed:', e.message)
  }

  // Other currencies: FRED monthly nominal + hardcoded inflation expectation
  const otherCurrencies = ['EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF']
  const nomFetches = otherCurrencies.map(cur =>
    fetchFred(FRED_NOMINAL_SERIES[cur])
      .then(d => ({ cur, data: d }))
      .catch(e => { console.warn(`real-yields: ${cur} nominal fetch failed:`, e.message); return { cur, data: null } })
  )

  const nomResults = await Promise.all(nomFetches)

  for (const { cur, data } of nomResults) {
    const inf = INFLATION_EXPECTATIONS[cur]
    if (!inf) continue

    const staleDays = (Date.now() - new Date(inf.as_of).getTime()) / 86400000
    const stale = staleDays > 90

    if (!data) {
      // Couldn't get nominal yield — return only inflation expectation metadata
      results[cur] = {
        nominal: null, inflation_exp: inf.value, real: null,
        source_nominal: FRED_NOMINAL_SERIES[cur],
        source_inflation: inf.source,
        as_of: null,
        stale,
        error: 'nominal_unavailable',
      }
      continue
    }

    const nominal = data.latest
    const real = +(nominal - inf.value).toFixed(2)
    results[cur] = {
      nominal, inflation_exp: inf.value, real,
      source_nominal: FRED_NOMINAL_SERIES[cur],
      source_inflation: inf.source,
      as_of: data.date,
      stale,
    }
  }

  if (Object.keys(results).length === 0) {
    // All failed — return stale cache
    try {
      const stale = await redisCmd('GET', CACHE_KEY)
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true })
    } catch(e) {}
    return res.status(502).json({ error: 'All real yield sources unavailable' })
  }

  const payload = { currencies: results, computed_at: new Date().toISOString() }

  redisCmd('SET', CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL)
    .catch(e => console.warn('real-yields: Redis SET failed:', e.message))

  return res.status(200).json(payload)
}

async function fetchFred(seriesId) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY not set')

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&limit=5&sort_order=desc&file_type=json`
  const r = await fetch(url, {
    headers: { 'User-Agent': 'DaunMerah/1.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`)

  const json = await r.json()
  const obs = (json.observations || []).filter(o => o.value !== '.')
  if (obs.length === 0) throw new Error(`FRED ${seriesId}: no valid observations`)

  return { latest: parseFloat(obs[0].value), date: obs[0].date }
}

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!REDIS_URL || !REDIS_TOKEN) return null
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  })
  return (await r.json()).result
}
