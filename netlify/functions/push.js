// Scheduled function — runs every 1 minute
// Checks RSS for new items, sends Web Push to all subscribers

const { getStore } = require('@netlify/blobs');

const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fjfeed.app';

// ── VAPID / Web Push (manual implementation, no web-push library) ──────────
const { createSign, createECDH } = require('crypto');

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

async function buildVapidHeader(audience, subject, publicKey, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600;
  const header = base64urlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64urlEncode(Buffer.from(JSON.stringify({ aud: audience, exp, sub: subject })));
  const sigInput = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(sigInput);
  const privDer = base64urlDecode(privateKey);
  // PEM-wrap the raw private key for Node crypto
  const privPem = `-----BEGIN EC PRIVATE KEY-----\n${Buffer.concat([
    Buffer.from('3077020101042', 'hex').slice(0,1), // minimal EC key header
  ]).toString('base64')}\n-----END EC PRIVATE KEY-----`;
  // Use subtle crypto approach via jose-style manual sign
  const { subtle } = require('crypto').webcrypto || globalThis.crypto;
  const key = await subtle.importKey(
    'pkcs8',
    buildPKCS8(privDer),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(sigInput)
  );
  const token = `${sigInput}.${base64urlEncode(sig)}`;
  return `vapid t=${token},k=${publicKey}`;
}

function buildPKCS8(rawPrivKey) {
  // PKCS#8 wrapper for P-256 raw private key (32 bytes)
  const prefix = Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex');
  const suffix = Buffer.from('a144034200', 'hex');
  // We need the public key too — derive it
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(rawPrivKey);
  const pubKey = ecdh.getPublicKey();
  return Buffer.concat([prefix, rawPrivKey, suffix, pubKey]);
}

async function sendPushNotification(subscription, payload) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const authHeader = await buildVapidHeader(audience, VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const body = Buffer.from(JSON.stringify(payload));

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'TTL': '60',
    },
    body,
    signal: AbortSignal.timeout(10000),
  });

  return res.status;
}

// ── RSS helpers ──────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
];

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = (tag) => {
      const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);
      const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
      return (r1||r2)?.[1]?.trim()||'';
    };
    const title = get('title').replace(/^FinancialJuice:\s*/i,'').trim();
    const guid  = get('guid');
    const pubDate = get('pubDate');
    const link  = b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
}

function detectCat(title) {
  const t = title.toLowerCase();
  const CATS = {
    'market-moving': ['market moving','breaking','flash','urgent','blockade'],
    'forex':    ['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','cnh/','/usd','/eur','/gbp','/jpy','fx options','options expir','dxy','cable','loonie','aussie','kiwi'],
    'energy':   ['oil','crude','brent','wti','opec','natural gas','hormuz','iea','tanker'],
    'macro':    ['fed ','fomc','powell','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp'],
    'geopolitical':['iran','israel','russia','ukraine','china','trump','nato','military','war','sanction','tariff'],
    'econ-data':['actual','forecast','previous','cpi','nfp','unemployment','retail sales'],
  };
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'news';
}

const CAT_EMOJI = {
  'market-moving':'🔴','forex':'💱','energy':'⚡','macro':'🏦',
  'geopolitical':'🌐','econ-data':'📋','news':'📰',
};

// ── Main handler ─────────────────────────────────────────
exports.handler = async function(event) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log('VAPID keys not configured, skipping push');
    return { statusCode: 200, body: 'VAPID not configured' };
  }

  // 1. Get seen GUIDs from Blobs
  const rssStore  = getStore({ name: 'rss-cache', consistency: 'strong' });
  const subStore  = getStore({ name: 'push-subscriptions', consistency: 'strong' });

  let seenGuids = new Set();
  try {
    const entry = await rssStore.get('seen-guids');
    if (entry) seenGuids = new Set(JSON.parse(entry));
  } catch(e) {}

  // 2. Fetch RSS (reuse cached if available)
  let xml = null;
  try {
    const cached = await rssStore.getWithMetadata('latest');
    if (cached?.metadata) {
      const age = Date.now() - (cached.metadata.fetchedAt || 0);
      if (age < 55000) xml = cached.data;
    }
  } catch(e) {}

  if (!xml) {
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const res = await fetch(RSS_URL, {
        headers: { 'User-Agent': ua, 'Accept': 'application/rss+xml, */*', 'Referer': 'https://www.financialjuice.com/' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        xml = await res.text();
        await rssStore.set('latest', xml, { metadata: { fetchedAt: Date.now() } });
      }
    } catch(e) {
      console.warn('RSS fetch failed:', e.message);
      return { statusCode: 200, body: 'RSS unavailable' };
    }
  }

  if (!xml) return { statusCode: 200, body: 'No RSS data' };

  // 3. Find new items
  const items = parseRSS(xml);
  const isFirst = seenGuids.size === 0;
  const newItems = isFirst ? [] : items.filter(i => !seenGuids.has(i.guid));

  // Update seen GUIDs
  items.forEach(i => seenGuids.add(i.guid));
  try {
    await rssStore.set('seen-guids', JSON.stringify([...seenGuids].slice(-500)));
  } catch(e) {}

  if (newItems.length === 0) {
    return { statusCode: 200, body: isFirst ? 'Initialized GUIDs' : 'No new items' };
  }

  // 4. Get all subscribers
  let subscribers = [];
  try {
    const { blobs } = await subStore.list();
    subscribers = await Promise.all(
      blobs.map(async b => {
        try { return JSON.parse(await subStore.get(b.key)); } catch(e) { return null; }
      })
    );
    subscribers = subscribers.filter(Boolean);
  } catch(e) {
    console.warn('Failed to get subscribers:', e.message);
    return { statusCode: 200, body: 'No subscribers' };
  }

  if (subscribers.length === 0) return { statusCode: 200, body: 'No subscribers' };

  // 5. Build notification payload
  let title, body;
  if (newItems.length === 1) {
    const cat = detectCat(newItems[0].title);
    title = `${CAT_EMOJI[cat] || '📰'} FJFeed`;
    body  = newItems[0].title;
  } else {
    title = `📰 FJFeed — ${newItems.length} berita baru`;
    body  = newItems.slice(0, 2).map(i => `• ${i.title}`).join('\n');
  }

  const payload = {
    title,
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    url: newItems[0]?.link || '/',
    timestamp: Date.now(),
  };

  // 6. Send to all subscribers
  const staleKeys = [];
  await Promise.allSettled(
    subscribers.map(async sub => {
      try {
        const status = await sendPushNotification(sub, payload);
        if (status === 410 || status === 404) {
          const key = Buffer.from(sub.endpoint).toString('base64').slice(0, 100);
          staleKeys.push(key);
        }
      } catch(e) {
        console.warn('Push failed for subscriber:', e.message);
      }
    })
  );

  // Clean up stale subscriptions
  await Promise.allSettled(staleKeys.map(k => subStore.delete(k)));

  console.log(`Sent push to ${subscribers.length} subscribers, ${newItems.length} new items, ${staleKeys.length} stale cleaned`);
  return { statusCode: 200, body: `Pushed ${newItems.length} items to ${subscribers.length} subscribers` };
};
