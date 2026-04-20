// api/rss.js
const cache = { xml: null, fetchedAt: 0 };
const CACHE_TTL = 50 * 1000;
const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
  'NewsBlur Feed Fetcher - 1000000 subscribers',
];

module.exports = async function handler(req, res) {
  const now = Date.now();
  const age = now - cache.fetchedAt;

  if (cache.xml && age < CACHE_TTL) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cache.xml);
  }

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
    if (cache.xml) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).send(cache.xml);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: 'Upstream fetch failed', detail: fetchError });
  }

  cache.xml = xml;
  cache.fetchedAt = now;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).send(xml);
};
