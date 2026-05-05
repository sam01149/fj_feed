// api/feeds.js — consolidated feeds endpoint
// GET /api/feeds?type=rss     → FinancialJuice RSS XML (50s cache)
// GET /api/feeds?type=nitter  → @DeItaone via Nitter RSS (60s cache)
// GET /api/feeds?type=cot     → CFTC COT JSON (6h cache)

module.exports = async function handler(req, res) {
  const type = req.query.type;
  if (type === 'rss')    return rssHandler(req, res);
  if (type === 'nitter') return nitterHandler(req, res);
  if (type === 'cot')    return cotHandler(req, res);
  return res.status(400).json({ error: 'Missing ?type= — use rss, nitter, or cot' });
};

// ── Shared Redis helper ────────────────────────────────────────────────────────

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

// ── RSS handler (was api/rss.js) ──────────────────────────────────────────────

// No module-level in-memory cache — cold-start safe, Redis is the only cache layer
const RSS_CACHE_TTL_MS = 50 * 1000;
const RSS_CACHE_KEY    = 'rss_cache';
const RSS_URL          = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const RSS_USER_AGENTS  = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  'NewsBlur Feed Fetcher - 1000000 subscribers',
];

async function rssHandler(req, res) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = Date.now();

  try {
    const cached = await redisCmd('GET', RSS_CACHE_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (now - obj.fetchedAt < RSS_CACHE_TTL_MS) {
        res.setHeader('X-Cache-Source', 'REDIS');
        return res.status(200).send(obj.xml);
      }
    }
  } catch(e) {
    console.warn('RSS Redis GET failed:', e.message);
  }

  const ua = RSS_USER_AGENTS[Math.floor(Math.random() * RSS_USER_AGENTS.length)];
  let xml = null, fetchError = null;

  try {
    const r = await fetch(RSS_URL, {
      headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml,*/*', 'Referer': 'https://www.financialjuice.com/', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) { const t = await r.text(); if (t.includes('<rss')) xml = t; else fetchError = 'NOT_RSS'; }
    else fetchError = 'HTTP_' + r.status;
  } catch(e) { fetchError = e.message; }

  if (!xml) {
    try {
      const stale = await redisCmd('GET', RSS_CACHE_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        res.setHeader('X-Cache-Source', 'STALE');
        return res.status(200).send(obj.xml);
      }
    } catch(e2) {}
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Upstream fetch failed', detail: fetchError });
  }

  const payload = JSON.stringify({ xml, fetchedAt: now });
  redisCmd('SET', RSS_CACHE_KEY, payload, 'EX', 60).catch(() => {});

  // Fire-and-forget: persist items to 36h rolling history for market-digest
  storeNewsHistory(xml, now).catch(() => {});

  res.setHeader('X-Cache-Source', 'UPSTREAM');
  return res.status(200).send(xml);
}

async function storeNewsHistory(xml, now) {
  // Throttle: max once per 5 minutes to keep Upstash command usage low
  const lock = await redisCmd('SET', 'news_history_lock', '1', 'EX', 300, 'NX');
  if (!lock) return;

  const items = parseRSSItems(xml);
  if (items.length === 0) return;
  const cutoff = now - 36 * 60 * 60 * 1000;
  const args = ['ZADD', 'news_history', 'NX'];
  for (const item of items) {
    const ts = new Date(item.pubDate).getTime();
    if (!isNaN(ts) && ts > cutoff) args.push(ts, JSON.stringify(item));
  }
  if (args.length > 3) await redisCmd(...args);
  await redisCmd('ZREMRANGEBYSCORE', 'news_history', '-inf', cutoff);
}

function parseRSSItems(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title = get('title').replace(/^FinancialJuice:\s*/i,'').trim();
    const guid = get('guid'), pubDate = get('pubDate');
    const link = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
}

// ── Nitter handler (@DeItaone) ────────────────────────────────────────────────

const NITTER_INSTANCES = [
  'https://nitter.net/DeItaone/rss',
  'https://nitter.privacydev.net/DeItaone/rss',
  'https://nitter.poast.org/DeItaone/rss',
];
const NITTER_CACHE_KEY    = 'nitter_deltaone_v1';
const NITTER_CACHE_TTL_MS = 60 * 1000;

async function nitterHandler(req, res) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = Date.now();

  try {
    const cached = await redisCmd('GET', NITTER_CACHE_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (now - obj.fetchedAt < NITTER_CACHE_TTL_MS) {
        res.setHeader('X-Cache-Source', 'REDIS');
        return res.status(200).send(obj.xml);
      }
    }
  } catch(e) { console.warn('Nitter Redis GET failed:', e.message); }

  let xml = null, lastError = null;

  for (const url of NITTER_INSTANCES) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FeedFetcher/1.0)',
          'Accept': 'application/rss+xml, application/xml, */*',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const t = await r.text();
        if (t.includes('<rss') || t.includes('<feed')) { xml = t; break; }
        lastError = 'NOT_RSS from ' + url;
      } else {
        lastError = 'HTTP_' + r.status + ' from ' + url;
      }
    } catch(e) { lastError = e.message + ' from ' + url; }
  }

  if (!xml) {
    try {
      const stale = await redisCmd('GET', NITTER_CACHE_KEY);
      if (stale) {
        res.setHeader('X-Cache-Source', 'STALE');
        return res.status(200).send(JSON.parse(stale).xml);
      }
    } catch(e2) {}
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Nitter unavailable', detail: lastError });
  }

  redisCmd('SET', NITTER_CACHE_KEY, JSON.stringify({ xml, fetchedAt: now }), 'EX', 120).catch(() => {});
  res.setHeader('X-Cache-Source', 'UPSTREAM');
  return res.status(200).send(xml);
}

// ── COT handler (was api/cot.js) ──────────────────────────────────────────────

const CFTC_URL      = 'https://www.cftc.gov/dea/options/financial_lof.htm';
const COT_CACHE_TTL = 6 * 60 * 60 * 1000;

const MARKET_MARKERS = {
  EUR: ['euro fx'],
  GBP: ['british pound'],
  JPY: ['japanese yen'],
  CAD: ['canadian dollar'],
  AUD: ['australian dollar'],
  NZD: ['new zealand dollar', 'nz dollar'],
  CHF: ['swiss franc'],
};

async function cotHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const cached = await redisCmd('GET', 'cot_cache_v2');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - new Date(parsed.fetched_at).getTime() < COT_CACHE_TTL) {
        return res.status(200).json(parsed);
      }
    }
  } catch(e) {}

  let preText = '';
  try {
    const r = await fetch(CFTC_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!preMatch) throw new Error('No <pre> block in CFTC response');
    preText = preMatch[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  } catch(e) {
    console.error('CFTC fetch failed:', e.message);
    try {
      const stale = await redisCmd('GET', 'cot_cache_v2');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
    } catch(e2) {}
    return res.status(502).json({ error: 'CFTC unavailable: ' + e.message });
  }

  const dateMatch = preText.match(/Positions as of\s+([A-Za-z]+ \d+,?\s*\d{4})/i);
  const reportDate = dateMatch ? dateMatch[1].trim() : null;

  const positions = {};
  const textLower = preText.toLowerCase();

  for (const [currency, markers] of Object.entries(MARKET_MARKERS)) {
    let blockStart = -1;
    for (const marker of markers) {
      const idx = textLower.indexOf(marker);
      if (idx !== -1) { blockStart = idx; break; }
    }
    if (blockStart === -1) continue;

    const firstCode = textLower.indexOf('cftc code #', blockStart);
    if (firstCode === -1) continue;
    const nextCode  = textLower.indexOf('cftc code #', firstCode + 50);
    const block = preText.slice(blockStart, nextCode !== -1 ? nextCode - 50 : blockStart + 3000);
    const lines = block.split('\n');

    let posIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*Positions\s*$/i.test(lines[i])) { posIdx = i; break; }
    }

    let dataLine = '';
    if (posIdx !== -1) {
      for (let i = posIdx + 1; i < Math.min(posIdx + 4, lines.length); i++) {
        if (/[\d,]{3,}/.test(lines[i])) { dataLine = lines[i]; break; }
      }
    }
    if (!dataLine) {
      for (const line of lines) {
        const n = line.trim().split(/\s+/).filter(s => /^-?[\d,]+$/.test(s));
        if (n.length >= 10) { dataLine = line; break; }
      }
    }
    if (!dataLine) continue;

    const nums = dataLine.trim().split(/\s+/)
      .map(s => parseInt(s.replace(/,/g, '')))
      .filter(n => !isNaN(n));
    if (nums.length < 8) continue;

    const amLong   = nums[3];
    const amShort  = nums[4];
    const amNet    = amLong - amShort;
    const levLong  = nums[6];
    const levShort = nums[7];
    const levNet   = levLong - levShort;

    let levChangeNet = null;
    let amChangeNet  = null;
    for (let i = 0; i < lines.length; i++) {
      if (/Changes from/i.test(lines[i])) {
        let changeLine = '';
        if (i + 1 < lines.length && /[\d,]/.test(lines[i + 1])) changeLine = lines[i + 1];
        if (changeLine) {
          const cn = changeLine.trim().split(/\s+/)
            .map(s => parseInt(s.replace(/,/g, '')))
            .filter(n => !isNaN(n));
          if (cn.length >= 8) { amChangeNet = cn[3] - cn[4]; levChangeNet = cn[6] - cn[7]; }
        }
        break;
      }
    }

    positions[currency] = {
      am_long: amLong, am_short: amShort, am_net: amNet, am_change_net: amChangeNet,
      lev_long: levLong, lev_short: levShort, lev_net: levNet, lev_change_net: levChangeNet,
    };
  }

  let releaseDate = null;
  if (reportDate) {
    const d = new Date(reportDate);
    if (!isNaN(d)) {
      const fri = new Date(d.getTime() + 3 * 24 * 3600 * 1000);
      releaseDate = fri.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
  }

  const parsedCount = Object.keys(positions).length;

  if (parsedCount < 5) {
    console.warn(`COT parser: only ${parsedCount} currencies parsed — expected 7. Possible format change. Falling back to stale cache.`);
    try {
      const stale = await redisCmd('GET', 'cot_cache_v2');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true, parse_warning: `Only ${parsedCount}/7 currencies parsed from fresh fetch` });
    } catch(e2) {}
    return res.status(500).json({ error: `COT parser degraded: only ${parsedCount}/7 currencies parsed`, positions });
  }

  const payload = {
    positions,
    report_date: reportDate,
    release_date: releaseDate,
    fetched_at: new Date().toISOString(),
  };

  redisCmd('SET', 'cot_cache_v2', JSON.stringify(payload)).catch(() => {});
  return res.status(200).json(payload);
}
