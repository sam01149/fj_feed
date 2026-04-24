// api/economic-data.js
// Fetches macroeconomic data from FRED API for 8 major currencies
// Cached in Redis 6 hours — data updates daily/monthly at most

const CACHE_TTL = 6 * 60 * 60 * 1000;
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

// [seriesId, currency, metric, unit, limit]
// limit=3 for NFP to compute monthly change (need 3 levels)
const SERIES = [
  ['CPIAUCSL',           'USD', 'cpi',          'Index', 2],
  ['A191RL1Q225SBEA',    'USD', 'gdp_growth',   '%',     2],
  ['UNRATE',             'USD', 'unemployment', '%',     2],
  ['PAYEMS',             'USD', 'nfp',          'K',     3],
  ['CP0000EZ19M086NEST', 'EUR', 'cpi',          'Index', 2],
  ['EURGDPNQDSMEI',      'EUR', 'gdp_growth',   'Index', 2],
  ['LRHUTTTTEZM156S',    'EUR', 'unemployment', '%',     2],
  ['GBRCPIALLMINMEI',    'GBP', 'cpi',          'Index', 2],
  ['CLVMNACSCAB1GQUK',   'GBP', 'gdp_growth',   'Index', 2],
  ['LRHUTTTTGBM156S',    'GBP', 'unemployment', '%',     2],
  ['JPNCPIALLMINMEI',    'JPY', 'cpi',          'Index', 2],
  ['JPNRGDPEXP',         'JPY', 'gdp_growth',   '%',     2],
  ['LRHUTTTTJPM156S',    'JPY', 'unemployment', '%',     2],
  ['CANCPIALLMINMEI',    'CAD', 'cpi',          'Index', 2],
  ['CANGDPNQDSMEI',      'CAD', 'gdp_growth',   'Index', 2],
  ['LRHUTTTTCAM156S',    'CAD', 'unemployment', '%',     2],
  ['AUSCPIALLQINMEI',    'AUD', 'cpi',          'Index', 2],
  ['AUSGDPNQDSMEI',      'AUD', 'gdp_growth',   'Index', 2],
  ['LRHUTTTTAUM156S',    'AUD', 'unemployment', '%',     2],
  ['NZLCPIALLQINMEI',    'NZD', 'cpi',          'Index', 2],
  ['NZLGDPNQDSMEI',      'NZD', 'gdp_growth',   'Index', 2],
  ['LRHUTTTTNZM156S',    'NZD', 'unemployment', '%',     2],
  ['CHECPIALLMINMEI',    'CHF', 'cpi',          'Index', 2],
  ['CHEGDPNQDSMEI',      'CHF', 'gdp_growth',   'Index', 2],
  ['LRHUTTTTCHM156S',    'CHF', 'unemployment', '%',     2],
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const FRED_KEY = process.env.FRED_API_KEY;
  const force = req.query?.force === '1';

  // Serve Redis cache if fresh and not force-refreshing
  if (!force) {
    try {
      const cached = await redisCmd('GET', 'economic_data');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - new Date(parsed.fetched_at).getTime() < CACHE_TTL) {
          return res.status(200).json(parsed);
        }
      }
    } catch(e) {}
  }

  if (!FRED_KEY) {
    try {
      const stale = await redisCmd('GET', 'economic_data');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
    } catch(e) {}
    return res.status(200).json({ error: 'FRED_API_KEY not configured', data: {}, fetched_at: null });
  }

  // Fetch all series in parallel
  const results = await Promise.allSettled(
    SERIES.map(([seriesId, , , , limit]) =>
      fetch(`${FRED_BASE}?series_id=${seriesId}&api_key=${FRED_KEY}&limit=${limit}&sort_order=desc&file_type=json`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      }).then(r => r.json())
    )
  );

  const data = {};

  results.forEach((result, i) => {
    const [seriesId, currency, metric, unit] = SERIES[i];
    if (result.status !== 'fulfilled') {
      console.warn('FRED fetch failed:', seriesId, result.reason?.message);
      return;
    }
    const json = result.value;
    if (json.error_code || !Array.isArray(json.observations)) {
      console.warn('FRED error for', seriesId, json.error_message || json.error_code);
      return;
    }

    // Filter out missing values ('.' or 'NA')
    const obs = json.observations.filter(o => o.value && o.value !== '.' && o.value !== 'NA');

    if (!data[currency]) data[currency] = {};

    if (metric === 'nfp') {
      if (obs.length < 3) return;
      const curr  = parseFloat(obs[0].value);
      const prev  = parseFloat(obs[1].value);
      const prev2 = parseFloat(obs[2].value);
      if (isNaN(curr) || isNaN(prev) || isNaN(prev2)) return;
      data[currency][metric] = {
        value:    Math.round(curr - prev),
        previous: Math.round(prev - prev2),
        date:     obs[0].date,
        unit,
      };
    } else {
      if (obs.length < 2) return;
      const curr = parseFloat(obs[0].value);
      const prev = parseFloat(obs[1].value);
      if (isNaN(curr) || isNaN(prev)) return;
      data[currency][metric] = {
        value:    Math.round(curr * 100) / 100,
        previous: Math.round(prev * 100) / 100,
        date:     obs[0].date,
        unit,
      };
    }
  });

  const payload = { data, fetched_at: new Date().toISOString() };
  redisCmd('SET', 'economic_data', JSON.stringify(payload)).catch(() => {});
  return res.status(200).json(payload);
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()).result;
}
