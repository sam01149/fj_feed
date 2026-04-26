// api/rss.js
// Module-level cache kept as in-memory fallback only; real persistence is Redis
const memCache = { xml: null, fetchedAt: 0 };
const CACHE_TTL_MS = 50 * 1000; // 50s
const REDIS_KEY    = 'rss_cache';
const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const USER_AGENTS  = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  'NewsBlur Feed Fetcher - 1000000 subscribers',
];

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(4000),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = Date.now();

  // 1. In-memory cache (warm within same invocation or recent cold start)
  if (memCache.xml && now - memCache.fetchedAt < CACHE_TTL_MS) {
    res.setHeader('X-Cache-Source', 'MEMORY');
    return res.status(200).send(memCache.xml);
  }

  // 2. Redis cache — survives cold starts
  try {
    const cached = await redisCmd('GET', REDIS_KEY);
    if (cached) {
      const obj = JSON.parse(cached);
      if (now - obj.fetchedAt < CACHE_TTL_MS) {
        memCache.xml = obj.xml;
        memCache.fetchedAt = obj.fetchedAt;
        res.setHeader('X-Cache-Source', 'REDIS');
        return res.status(200).send(obj.xml);
      }
    }
  } catch(e) {
    console.warn('RSS Redis GET failed:', e.message);
  }

  // 3. Fetch upstream
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
    // Fallback: stale Redis
    try {
      const stale = await redisCmd('GET', REDIS_KEY);
      if (stale) {
        const obj = JSON.parse(stale);
        res.setHeader('X-Cache-Source', 'STALE');
        return res.status(200).send(obj.xml);
      }
    } catch(e2) {}
    // Fallback: stale in-memory
    if (memCache.xml) {
      res.setHeader('X-Cache-Source', 'STALE');
      return res.status(200).send(memCache.xml);
    }
    res.setHeader('Content-Type', 'application/json');
    return res.status(502).json({ error: 'Upstream fetch failed', detail: fetchError });
  }

  // Write-through to Redis (TTL 60s — extra 10s buffer) and in-memory
  const payload = JSON.stringify({ xml, fetchedAt: now });
  redisCmd('SET', REDIS_KEY, payload, 'EX', 60).catch(() => {});
  memCache.xml = xml;
  memCache.fetchedAt = now;

  res.setHeader('X-Cache-Source', 'UPSTREAM');
  return res.status(200).send(xml);
};
