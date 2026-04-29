// api/cb-status.js
// Returns static CB data merged with latest bias from Redis

const CB_DATA = {
  USD: { currency:'USD', bank:'Federal Reserve',            short:'Fed',  rate:4.50, last_meeting:'2026-03-19', last_decision:'hold', last_bps:0   },
  EUR: { currency:'EUR', bank:'European Central Bank',      short:'ECB',  rate:2.15, last_meeting:'2026-03-19', last_decision:'hold', last_bps:0   },
  GBP: { currency:'GBP', bank:'Bank of England',            short:'BOE',  rate:4.50, last_meeting:'2026-02-06', last_decision:'cut',  last_bps:-25 },
  JPY: { currency:'JPY', bank:'Bank of Japan',              short:'BOJ',  rate:0.75, last_meeting:'2026-03-19', last_decision:'hold', last_bps:0   },
  CAD: { currency:'CAD', bank:'Bank of Canada',             short:'BOC',  rate:2.75, last_meeting:'2026-03-12', last_decision:'hold', last_bps:0   },
  AUD: { currency:'AUD', bank:'Reserve Bank of Australia',  short:'RBA',  rate:4.10, last_meeting:'2026-02-18', last_decision:'cut',  last_bps:-25 },
  NZD: { currency:'NZD', bank:'Reserve Bank of New Zealand',short:'RBNZ', rate:3.50, last_meeting:'2026-02-19', last_decision:'cut',  last_bps:-50 },
  CHF: { currency:'CHF', bank:'Swiss National Bank',        short:'SNB',  rate:0.25, last_meeting:'2026-03-20', last_decision:'cut',  last_bps:-25 },
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn('Redis env vars missing in cb-status');
    return null;
  }
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()).result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // Load bias from Redis
  let biasData = {};
  try {
    const raw = await redisCmd('GET', 'cb_bias');
    console.log('cb_bias raw from Redis:', raw ? raw.substring(0,200) : 'NULL');
    if (raw) biasData = JSON.parse(raw);
    console.log('cb_bias parsed keys:', Object.keys(biasData));
  } catch(e) {
    console.warn('Redis cb_bias fetch failed:', e.message);
  }

  // Merge static + bias
  const result = Object.values(CB_DATA).map(cb => ({
    ...cb,
    bias:         biasData[cb.currency]?.bias         || null,
    confidence:   biasData[cb.currency]?.confidence   || null,
    bias_updated: biasData[cb.currency]?.updated_at   || null,
  }));

  return res.status(200).json({
    banks: result,
    fetched_at: new Date().toISOString(),
  });
};
