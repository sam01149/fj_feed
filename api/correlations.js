// api/correlations.js
// Fetches 60-day daily closes for key cross-asset instruments and computes
// rolling 20-day correlation matrix. Flags pairs deviating >1.5 std from mean.
// Redis cache: correlations, TTL 24 hours (86400s).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const CACHE_KEY = 'correlations';
const CACHE_TTL = 86400;

// Stooq symbols for free daily price data
const INSTRUMENTS = {
  DXY:   '^dxy',
  EURUSD:'eurusd',
  GBPUSD:'gbpusd',
  USDJPY:'usdjpy',
  AUDUSD:'audusd',
  Gold:  'xauusd',
  WTI:   'cl.f',
  SPX:   '^spx',
  VIX:   '^vix',
  US10Y: '^tnx',
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await r.json()).result;
}

async function fetchStooqCSV(symbol) {
  const end = new Date();
  const start = new Date(end.getTime() - 70 * 86400000); // 70 days for buffer
  const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const url = `https://stooq.com/q/d/l/?s=${symbol}&d1=${fmt(start)}&d2=${fmt(end)}&i=d`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaunMerah/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Stooq HTTP ${r.status} for ${symbol}`);
  const text = await r.text();
  if (!text.includes('Date')) throw new Error(`Stooq invalid response for ${symbol}`);
  const lines = text.trim().split('\n').slice(1); // skip header
  const prices = [];
  for (const line of lines) {
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const date  = cols[0].trim();
    const close = parseFloat(cols[4]); // Close column
    if (!isNaN(close) && close > 0) prices.push({ date, close });
  }
  return prices.reverse(); // oldest first
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i]; sy += y[i]; sxy += x[i]*y[i];
    sx2 += x[i]*x[i]; sy2 += y[i]*y[i];
  }
  const num = n*sxy - sx*sy;
  const den = Math.sqrt((n*sx2 - sx*sx) * (n*sy2 - sy*sy));
  return den === 0 ? null : Math.round((num / den) * 1000) / 1000;
}

function alignSeries(a, b) {
  // Align by date
  const bMap = {};
  b.forEach(p => { bMap[p.date] = p.close; });
  const xa = [], xb = [];
  for (const p of a) {
    if (bMap[p.date] != null) {
      xa.push(p.close);
      xb.push(bMap[p.date]);
    }
  }
  return [xa, xb];
}

function lastN(arr, n) {
  return arr.slice(Math.max(0, arr.length - n));
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Try Redis cache first
  try {
    const cached = await redisCmd('GET', CACHE_KEY);
    if (cached) {
      const d = JSON.parse(cached);
      const age = Date.now() - new Date(d.computed_at).getTime();
      if (age < CACHE_TTL * 1000) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json({ ...d, stale: false });
      }
    }
  } catch(e) {
    console.warn('correlations cache read failed:', e.message);
  }

  // Fetch all instruments in parallel
  const names = Object.keys(INSTRUMENTS);
  const fetches = names.map(name =>
    fetchStooqCSV(INSTRUMENTS[name])
      .then(prices => ({ name, prices, ok: true }))
      .catch(e => { console.warn(`correlations: ${name} fetch failed:`, e.message); return { name, prices: [], ok: false }; })
  );
  const results = await Promise.all(fetches);

  const series = {};
  results.forEach(({ name, prices }) => {
    if (prices.length >= 10) series[name] = prices;
  });

  if (Object.keys(series).length < 3) {
    // Try stale cache
    try {
      const cached = await redisCmd('GET', CACHE_KEY);
      if (cached) return res.status(200).json({ ...JSON.parse(cached), stale: true });
    } catch(e) {}
    return res.status(500).json({ error: 'Insufficient data for correlation computation' });
  }

  // Compute 20-day and 60-day correlations for all instrument pairs
  const pairNames = names.filter(n => series[n]);
  const matrix20 = {}, matrix60 = {};
  const anomalies = [];

  for (let i = 0; i < pairNames.length; i++) {
    for (let j = i + 1; j < pairNames.length; j++) {
      const a = pairNames[i], b = pairNames[j];
      const [xa, xb] = alignSeries(series[a], series[b]);
      const r20 = pearson(lastN(xa, 20), lastN(xb, 20));
      const r60 = pearson(xa, xb);
      const key = `${a}|${b}`;
      matrix20[key] = r20;
      matrix60[key] = r60;

      // Flag if 20d deviates >1.5 from 60d (sign flip or large magnitude shift)
      if (r20 !== null && r60 !== null && Math.abs(r20 - r60) > 0.4) {
        anomalies.push({
          pair: key,
          r20: r20,
          r60: r60,
          delta: Math.round((r20 - r60) * 1000) / 1000,
          label: `${a} vs ${b}`,
        });
      }
    }
  }

  anomalies.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const data = {
    instruments: pairNames,
    matrix_20d: matrix20,
    matrix_60d: matrix60,
    anomalies: anomalies.slice(0, 8),
    computed_at: new Date().toISOString(),
  };

  try {
    await redisCmd('SET', CACHE_KEY, JSON.stringify(data), 'EX', CACHE_TTL);
  } catch(e) {
    console.warn('correlations cache write failed:', e.message);
  }

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ ...data, stale: false });
};
