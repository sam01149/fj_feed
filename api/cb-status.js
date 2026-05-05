// api/cb-status.js
// Live CB rates scraped from official sources (6h Redis cache)
// Falls back per-currency to hardcoded data if scraping fails.
//
// Sources:
//   USD → FRED API (DFEDTARU – upper target)
//   EUR → ECB Data Portal API (Main Refinancing Rate)
//   GBP → Bank of England website
//   JPY → Bank of Japan website
//   CAD → Bank of Canada Valet API
//   AUD → Reserve Bank of Australia website
//   NZD → Reserve Bank of New Zealand website
//   CHF → Swiss National Bank website

// ── Fallback (meeting metadata + last known rate) ─────────────────────────────
// Updated manually after each meeting. Live scraping overrides the rate field.

const CB_FALLBACK = {
  USD: { bank:'Federal Reserve',             short:'Fed',  rate:3.75, last_meeting:'2026-04-29', last_decision:'hold', last_bps:0  },
  EUR: { bank:'European Central Bank',       short:'ECB',  rate:2.15, last_meeting:'2026-04-30', last_decision:'hold', last_bps:0  },
  GBP: { bank:'Bank of England',             short:'BOE',  rate:3.75, last_meeting:'2026-04-30', last_decision:'hold', last_bps:0  },
  JPY: { bank:'Bank of Japan',               short:'BOJ',  rate:0.75, last_meeting:'2026-04-28', last_decision:'hold', last_bps:0  },
  CAD: { bank:'Bank of Canada',              short:'BOC',  rate:2.25, last_meeting:'2026-04-29', last_decision:'hold', last_bps:0  },
  AUD: { bank:'Reserve Bank of Australia',   short:'RBA',  rate:4.35, last_meeting:'2026-05-06', last_decision:'hike', last_bps:25 },
  NZD: { bank:'Reserve Bank of New Zealand', short:'RBNZ', rate:2.25, last_meeting:'2026-04-09', last_decision:'hold', last_bps:0  },
  CHF: { bank:'Swiss National Bank',         short:'SNB',  rate:0.00, last_meeting:'2026-03-19', last_decision:'hold', last_bps:0  },
};

const RATES_CACHE_KEY = 'cb_rates_live_v2';
const RATES_TTL_MS    = 6 * 60 * 60 * 1000; // 6 hours

// ── Redis helper ──────────────────────────────────────────────────────────────

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

// ── Scraper helpers ───────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (compatible; CBRateBot/1.0; +https://daun-merah.vercel.app)';

async function getText(url, timeout = 8000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml,*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function getJson(url, timeout = 8000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json,*/*' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── Per-currency scrapers ─────────────────────────────────────────────────────

// USD: FRED API – Federal Funds Target Rate Upper Limit (no API key needed)
async function scrapeUSD() {
  const csv = await getText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFEDTARU&sort_order=desc&limit=2');
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('DATE'));
  const [date, val] = lines[0].split(',');
  const rate = parseFloat(val);
  if (isNaN(rate)) throw new Error('USD: NaN');
  return { rate, date };
}

// EUR: ECB Data Portal API – Main Refinancing Rate (free, no key)
async function scrapeEUR() {
  const json = await getJson(
    'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.MRR_FR.LEV?format=jsondata&lastNObservations=1&detail=dataonly'
  );
  const series  = json.dataSets?.[0]?.series;
  if (!series) throw new Error('EUR: no series');
  const firstSeries = Object.values(series)[0];
  const obs = firstSeries?.observations;
  if (!obs) throw new Error('EUR: no obs');
  const lastObs = obs[Object.keys(obs).sort((a, b) => +a - +b).pop()];
  const rate = parseFloat(lastObs?.[0]);
  if (isNaN(rate)) throw new Error('EUR: NaN');
  return { rate, date: null };
}

// GBP: Bank of England – current Bank Rate page
async function scrapeGBP() {
  const html = await getText('https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate');
  // Page contains text like "Bank Rate is X.XX per cent"
  const m = html.match(/Bank Rate is ([\d.]+) per cent/i)
         || html.match(/([\d.]+)\s*per cent[^<]{0,60}Bank Rate/i)
         || html.match(/current Bank Rate[^<]{0,80}([\d.]+)\s*(?:per cent|%)/i);
  if (!m) throw new Error('GBP: pattern not found');
  const rate = parseFloat(m[1]);
  if (isNaN(rate)) throw new Error('GBP: NaN');
  return { rate, date: null };
}

// JPY: Bank of Japan – monetary policy decisions page
async function scrapeJPY() {
  const html = await getText('https://www.boj.or.jp/en/mopo/mpmdeci/index.htm');
  // Page typically shows "around X% per annum" or "X percent"
  const m = html.match(/short-term policy[^<]{0,120}([\d.]+)\s*(?:percent|%)/i)
         || html.match(/policy interest rate[^<]{0,80}([\d.]+)\s*(?:percent|%)/i)
         || html.match(/uncollateralized overnight call rate[^<]{0,120}([\d.]+)\s*(?:percent|%)/i);
  if (!m) throw new Error('JPY: pattern not found');
  const rate = parseFloat(m[1]);
  if (isNaN(rate)) throw new Error('JPY: NaN');
  return { rate, date: null };
}

// CAD: Bank of Canada Valet API – Overnight Rate (free, no key)
async function scrapeCAD() {
  const json = await getJson('https://www.bankofcanada.ca/valet/observations/V80691311/json?recent=1');
  const obs  = json.observations?.[0];
  const rate = parseFloat(obs?.V80691311?.v);
  if (isNaN(rate)) throw new Error('CAD: NaN');
  return { rate, date: obs?.d || null };
}

// AUD: Reserve Bank of Australia – cash rate page
async function scrapeAUD() {
  const html = await getText('https://www.rba.gov.au/statistics/cash-rate/');
  // Page contains "Cash Rate Target" followed by the rate
  const m = html.match(/Cash Rate Target[^<]{0,200}([\d.]+)\s*%/is)
         || html.match(/([\d.]+)\s*%[^<]{0,60}(?:cash rate|target)/i);
  if (!m) throw new Error('AUD: pattern not found');
  const rate = parseFloat(m[1]);
  if (isNaN(rate)) throw new Error('AUD: NaN');
  return { rate, date: null };
}

// NZD: Reserve Bank of New Zealand – OCR page
async function scrapeNZD() {
  const html = await getText('https://www.rbnz.govt.nz/monetary-policy/about-monetary-policy/the-official-cash-rate');
  const m = html.match(/OCR[^<]{0,60}([\d.]+)\s*(?:per cent|%)/i)
         || html.match(/official cash rate[^<]{0,80}([\d.]+)\s*(?:per cent|%)/i)
         || html.match(/([\d.]+)\s*per cent[^<]{0,80}OCR/i);
  if (!m) throw new Error('NZD: pattern not found');
  const rate = parseFloat(m[1]);
  if (isNaN(rate)) throw new Error('NZD: NaN');
  return { rate, date: null };
}

// CHF: Swiss National Bank – current interest rates page
async function scrapeCHF() {
  const html = await getText('https://www.snb.ch/en/the-snb/mandates-goals/statistics/statistics-pub/current_interest_exchange_rates');
  // SNB policy rate can be 0 or negative, pattern: "SNB policy rate" then number
  const m = html.match(/SNB policy rate[^<]{0,120}(-?[\d.]+)\s*%/i)
         || html.match(/(-?[\d.]+)\s*%[^<]{0,80}policy rate/i);
  if (!m) throw new Error('CHF: pattern not found');
  const rate = parseFloat(m[1]);
  if (isNaN(rate)) throw new Error('CHF: NaN');
  return { rate, date: null };
}

// ── Run all scrapers in parallel ──────────────────────────────────────────────

const SCRAPERS = { USD: scrapeUSD, EUR: scrapeEUR, GBP: scrapeGBP, JPY: scrapeJPY,
                   CAD: scrapeCAD, AUD: scrapeAUD, NZD: scrapeNZD, CHF: scrapeCHF };

async function scrapeAllRates() {
  const entries = await Promise.allSettled(
    Object.entries(SCRAPERS).map(async ([cur, fn]) => [cur, await fn()])
  );
  const rates = {};
  for (const r of entries) {
    if (r.status === 'fulfilled') {
      const [cur, data] = r.value;
      rates[cur] = data;
      console.log(`[cb-scrape] ${cur}: ${data.rate}%`);
    } else {
      console.warn('[cb-scrape] failed:', r.reason?.message);
    }
  }
  return rates;
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  const now = Date.now();
  let biasData  = {};
  let liveRates = {};
  let rateSource = 'fallback';

  // Load bias + cached live rates in parallel
  try {
    const [biasRaw, ratesRaw] = await Promise.all([
      redisCmd('GET', 'cb_bias'),
      redisCmd('GET', RATES_CACHE_KEY),
    ]);
    if (biasRaw) biasData = JSON.parse(biasRaw);
    if (ratesRaw) {
      const obj = JSON.parse(ratesRaw);
      if (now - obj.fetchedAt < RATES_TTL_MS) {
        liveRates  = obj.rates;
        rateSource = 'live_cached';
      }
    }
  } catch(e) { console.warn('Redis load failed:', e.message); }

  // Scrape if cache stale or empty
  if (Object.keys(liveRates).length === 0) {
    liveRates = await scrapeAllRates();
    if (Object.keys(liveRates).length > 0) {
      rateSource = 'live_fresh';
      redisCmd('SET', RATES_CACHE_KEY,
        JSON.stringify({ rates: liveRates, fetchedAt: now }),
        'EX', 7 * 3600
      ).catch(() => {});
    }
  }

  // Merge: live rate overrides fallback rate; meeting metadata from fallback
  const result = Object.entries(CB_FALLBACK).map(([cur, fb]) => {
    const live = liveRates[cur];
    const rate = live?.rate ?? fb.rate;

    // Detect undocumented rate change (live differs from fallback by ≥5bps)
    const diff = live?.rate != null ? Math.round((live.rate - fb.rate) * 100) : 0;
    const rateChanged = Math.abs(diff) >= 5;

    return {
      currency:     cur,
      bank:         fb.bank,
      short:        fb.short,
      rate,
      last_meeting: fb.last_meeting,
      last_decision: rateChanged ? (diff > 0 ? 'hike' : 'cut') : fb.last_decision,
      last_bps:      rateChanged ? diff                          : fb.last_bps,
      rate_source:   live ? rateSource : 'fallback',
      rate_stale:    rateChanged,   // true = live rate diverged from fallback
      bias:          biasData[cur]?.bias       || null,
      confidence:    biasData[cur]?.confidence || null,
      bias_updated:  biasData[cur]?.updated_at || null,
    };
  });

  return res.status(200).json({
    banks: result,
    fetched_at: new Date().toISOString(),
    rate_source: rateSource,
  });
};
