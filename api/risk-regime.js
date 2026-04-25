// api/risk-regime.js
// Classifies global risk regime: Risk-On / Neutral / Risk-Off
// Sources: FRED (VIX, HY OAS), Stooq (MOVE index)
// Cached in Redis under 'risk_regime' for 30 minutes (data is EOD, refreshing more often is wasteful)

const CACHE_KEY = 'risk_regime'
const CACHE_TTL = 30 * 60 // 30 minutes in seconds

// FRED series: VIXCLS = CBOE VIX, BAMLH0A0HYM2 = ICE BofA US HY OAS spread
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'
const STOOQ_MOVE = 'https://stooq.com/q/d/l/?s=%5emove&i=d&l=5'

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
]

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
      if (ageMs < CACHE_TTL * 1000) {
        return res.status(200).json(parsed)
      }
    }
  } catch (e) {
    console.warn('risk-regime: Redis GET failed:', e.message)
  }

  // Fetch all three sources in parallel; partial failures are tolerable
  const [vixResult, moveResult, hyResult] = await Promise.allSettled([
    fetchFredSeries('VIXCLS'),
    fetchMove(),
    fetchFredSeries('BAMLH0A0HYM2'),
  ])

  const vixData  = vixResult.status  === 'fulfilled' ? vixResult.value  : null
  const moveData = moveResult.status === 'fulfilled' ? moveResult.value : null
  const hyData   = hyResult.status   === 'fulfilled' ? hyResult.value   : null

  if (!vixData)  console.warn('risk-regime: VIX fetch failed')
  if (!moveData) console.warn('risk-regime: MOVE fetch failed — Stooq may have blocked')
  if (!hyData)   console.warn('risk-regime: HY spread fetch failed')

  // All three sources failed — return stale cache rather than empty error
  if (!vixData && !moveData && !hyData) {
    try {
      const stale = await redisCmd('GET', CACHE_KEY)
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true })
    } catch (e) {}
    return res.status(502).json({ error: 'All data sources unavailable' })
  }

  const vix      = vixData  ? vixData.latest  : null
  const move     = moveData ? moveData.latest  : null
  const hySpread = hyData   ? hyData.latest    : null
  // 2-day change in HY spread: positive = widening = risk-off pressure
  const hyChange = hyData && hyData.prev != null ? +(hyData.latest - hyData.prev).toFixed(4) : null

  const components = {
    vix_trigger:  vix  != null ? vix  > 25          : null,
    move_trigger: move != null ? move > 130          : null,
    hy_trigger:   hyChange != null ? hyChange > 0.15 : null,
  }

  const regime = classifyRegime(vix, move, hyChange, hySpread)

  // data_date: use the most recent date available from any source
  const dataDate = [vixData?.date, moveData?.date, hyData?.date].filter(Boolean).sort().pop() || null

  const payload = {
    regime,
    vix,
    move,
    hy_spread: hySpread,
    hy_change_2d: hyChange,
    components,
    computed_at: new Date().toISOString(),
    data_date: dataDate,
  }

  redisCmd('SET', CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_TTL).catch(e => {
    console.warn('risk-regime: Redis SET failed:', e.message)
  })

  return res.status(200).json(payload)
}

// ── Classifier ────────────────────────────────────────────────────────────────

function classifyRegime(vix, move, hyChange) {
  const triggers = {
    riskOff: [],
    riskOn:  [],
  }

  if (vix  != null && vix  > 25)          triggers.riskOff.push('vix')
  if (move != null && move > 130)          triggers.riskOff.push('move')
  if (hyChange != null && hyChange > 0.15) triggers.riskOff.push('hy_widening')

  // Risk-On requires ALL three available metrics to be benign
  const vixOk  = vix  == null || vix  < 15
  const moveOk = move == null || move < 90
  const hyOk   = hyChange == null || hyChange <= 0

  if (triggers.riskOff.length > 0)        return 'risk_off'
  if (vixOk && moveOk && hyOk)            return 'risk_on'
  return 'neutral'
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchFredSeries(seriesId) {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) throw new Error('FRED_API_KEY not set')

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&limit=5&sort_order=desc&file_type=json`
  const r = await fetch(url, {
    headers: { 'User-Agent': 'DaunMerah/1.0' },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`FRED ${seriesId} HTTP ${r.status}`)

  const json = await r.json()
  // observations are sorted desc; filter out missing values ('.')
  const obs = (json.observations || []).filter(o => o.value !== '.')
  if (obs.length === 0) throw new Error(`FRED ${seriesId}: no valid observations`)

  return {
    latest: parseFloat(obs[0].value),
    prev:   obs.length > 2 ? parseFloat(obs[2].value) : null, // ~2 trading days ago
    date:   obs[0].date,
  }
}

async function fetchMove() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
  const r = await fetch(STOOQ_MOVE, {
    headers: { 'User-Agent': ua },
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw new Error(`Stooq MOVE HTTP ${r.status}`)

  const csv = await r.text()
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('Date'))
  if (lines.length === 0) throw new Error('Stooq MOVE: empty CSV')

  // CSV columns: Date,Open,High,Low,Close,Volume — use Close
  const parse = line => {
    const cols = line.split(',')
    return { date: cols[0], close: parseFloat(cols[4]) }
  }

  const rows = lines.map(parse).filter(r => !isNaN(r.close))
  if (rows.length === 0) throw new Error('Stooq MOVE: no parseable rows')

  // Stooq returns newest-first
  return {
    latest: rows[0].close,
    prev:   rows.length > 2 ? rows[2].close : null,
    date:   rows[0].date,
  }
}

// ── Redis helper (matches cot.js pattern) ────────────────────────────────────

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!REDIS_URL || !REDIS_TOKEN) return null
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  })
  return (await res.json()).result
}
