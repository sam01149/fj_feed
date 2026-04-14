const { schedule } = require('@netlify/functions');
const webpush = require('web-push');

const RSS_URL     = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fjfeed.app';

// ── Upstash Redis helper ──────────────────────────────────────────────────
async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  return data.result;
}

// ── RSS helpers ───────────────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => {
      const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);
      const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
      return (r1||r2)?.[1]?.trim()||'';
    };
    const title = get('title').replace(/^FinancialJuice:\s*/i,'').trim();
    const guid  = get('guid');
    const link  = b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid && title) items.push({ title, guid, link });
  }
  return items;
}

function detectCat(t) {
  t = t.toLowerCase();
  if (['market moving','breaking','blockade'].some(k=>t.includes(k))) return 'market-moving';
  if (['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','/usd','/jpy','dxy','loonie','aussie','cable'].some(k=>t.includes(k))) return 'forex';
  if (['oil','crude','brent','wti','natural gas','hormuz','iea'].some(k=>t.includes(k))) return 'energy';
  if (['fed ','fomc','powell','federal reserve','rate cut','ecb','boe','boj','pboc'].some(k=>t.includes(k))) return 'macro';
  if (['iran','israel','russia','ukraine','china','trump','nato','war','tariff'].some(k=>t.includes(k))) return 'geopolitical';
  if (['actual','forecast','previous','cpi','nfp','unemployment'].some(k=>t.includes(k))) return 'econ-data';
  return 'news';
}

const EMOJI = { 'market-moving':'🔴','forex':'💱','energy':'⚡','macro':'🏦','geopolitical':'🌐','econ-data':'📋','news':'📰' };

// ── Main ──────────────────────────────────────────────────────────────────
const handler = async function() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !REDIS_URL) {
    return { statusCode: 200, body: 'Not configured' };
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  // Load seen GUIDs
  let seenGuids = new Set();
  try {
    const raw = await redisCmd('GET', 'seen_guids');
    if (raw) seenGuids = new Set(JSON.parse(raw));
  } catch(e) {}

  // Fetch RSS — try cache first
  let xml = null;
  try {
    const cached = await redisCmd('GET', 'rss_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < 55000) xml = parsed.xml;
    }
  } catch(e) {}

  if (!xml) {
    try {
      const res = await fetch(RSS_URL, {
        headers: { 'User-Agent': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html)', 'Referer': 'https://www.financialjuice.com/' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        xml = await res.text();
        await redisCmd('SET', 'rss_cache', JSON.stringify({ xml, fetchedAt: Date.now() }), 'EX', 120);
      }
    } catch(e) {
      return { statusCode: 200, body: 'RSS unavailable' };
    }
  }

  if (!xml) return { statusCode: 200, body: 'No RSS' };

  const items = parseRSS(xml);
  const isFirst = seenGuids.size === 0;
  const newItems = isFirst ? [] : items.filter(i => !seenGuids.has(i.guid));

  items.forEach(i => seenGuids.add(i.guid));
  try {
    await redisCmd('SET', 'seen_guids', JSON.stringify([...seenGuids].slice(-500)), 'EX', 86400);
  } catch(e) {}

  if (newItems.length === 0) return { statusCode: 200, body: isFirst ? 'Initialized' : 'No new items' };

  // Get subscribers
  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs');
    if (raw && Array.isArray(raw)) {
      for (let i = 1; i < raw.length; i += 2) {
        try { subs.push(JSON.parse(raw[i])); } catch(e) {}
      }
    }
  } catch(e) {}

  if (subs.length === 0) return { statusCode: 200, body: 'No subscribers' };

  const cat = detectCat(newItems[0].title);
  const payload = JSON.stringify({
    title: newItems.length === 1 ? `${EMOJI[cat]||'📰'} FJFeed` : `📰 FJFeed — ${newItems.length} berita baru`,
    body:  newItems.length === 1 ? newItems[0].title : newItems.slice(0,2).map(i=>`• ${i.title}`).join('\n'),
    url:   newItems[0]?.link || '/',
    icon:  '/icon-192.png',
  });

  const staleKeys = [];
  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification(sub, payload);
    } catch(e) {
      console.warn('Push error:', e.statusCode, e.message);
      if (e.statusCode === 410 || e.statusCode === 404) {
        staleKeys.push(Buffer.from(sub.endpoint).toString('base64').slice(0,80));
      }
    }
  }));

  if (staleKeys.length > 0) {
    await redisCmd('HDEL', 'push_subs', ...staleKeys);
  }

  console.log(`Pushed ${newItems.length} items to ${subs.length} subs`);
  return { statusCode: 200, body: 'OK' };
};

exports.handler = schedule('* * * * *', handler);
