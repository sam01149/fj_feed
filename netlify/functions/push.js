const { getStore } = require('@netlify/blobs');
const { schedule } = require('@netlify/functions');
const { createECDH, createHmac, createCipheriv, randomBytes } = require('crypto');

const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fjfeed.app';

// ── VAPID JWT (pure Node.js crypto, no external lib) ──────────────────────

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64uDec(str) {
  return Buffer.from(str, 'base64url');
}

async function makeVapidJWT(audience) {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT }));
  const input   = `${header}.${payload}`;

  const { subtle } = require('crypto').webcrypto;
  const privRaw = b64uDec(VAPID_PRIVATE);

  // Build PKCS8 for P-256
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privRaw);
  const pubRaw = ecdh.getPublicKey();

  // PKCS8 DER: sequence { version, AlgorithmIdentifier(ecPublicKey, P-256), privateKey }
  const privSeq = Buffer.concat([
    Buffer.from('3077020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex'),
    privRaw,
    Buffer.from('a144034200', 'hex'),
    pubRaw,
  ]);

  const key = await subtle.importKey(
    'pkcs8', privSeq,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(input)
  );

  return `${input}.${b64u(sig)}`;
}

async function sendPush(sub, payload) {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJWT(audience);
  const authHeader = `vapid t=${jwt},k=${VAPID_PUBLIC}`;

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'TTL': '300',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

// ── RSS helpers ────────────────────────────────────────────────────────────

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
    const pubDate = get('pubDate');
    const link  = b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
}

function detectCat(t) {
  t = t.toLowerCase();
  if (['market moving','breaking','blockade'].some(k=>t.includes(k))) return 'market-moving';
  if (['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','cnh/','/usd','/jpy','dxy','loonie','aussie','cable'].some(k=>t.includes(k))) return 'forex';
  if (['oil','crude','brent','wti','natural gas','hormuz','iea'].some(k=>t.includes(k))) return 'energy';
  if (['fed ','fomc','powell','federal reserve','rate cut','ecb','boe','boj','pboc','central bank'].some(k=>t.includes(k))) return 'macro';
  if (['iran','israel','russia','ukraine','china','trump','nato','war','tariff'].some(k=>t.includes(k))) return 'geopolitical';
  if (['actual','forecast','previous','cpi','nfp','unemployment'].some(k=>t.includes(k))) return 'econ-data';
  return 'news';
}

const EMOJI = { 'market-moving':'🔴','forex':'💱','energy':'⚡','macro':'🏦','geopolitical':'🌐','econ-data':'📋','news':'📰' };

// ── Main ───────────────────────────────────────────────────────────────────

const handler = async function() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log('VAPID keys not set');
    return { statusCode: 200, body: 'No VAPID' };
  }

  const rssStore = getStore({ name: 'rss-cache',          consistency: 'strong' });
  const subStore = getStore({ name: 'push-subscriptions', consistency: 'strong' });

  // Load seen GUIDs
  let seenGuids = new Set();
  try {
    const raw = await rssStore.get('seen-guids');
    if (raw) seenGuids = new Set(JSON.parse(raw));
  } catch(e) {}

  // Fetch RSS (use cached if fresh)
  let xml = null;
  try {
    const cached = await rssStore.getWithMetadata('latest');
    if (cached?.metadata && (Date.now() - (cached.metadata.fetchedAt||0)) < 55000) {
      xml = cached.data;
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
        await rssStore.set('latest', xml, { metadata: { fetchedAt: Date.now() } });
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
  try { await rssStore.set('seen-guids', JSON.stringify([...seenGuids].slice(-500))); } catch(e) {}

  if (newItems.length === 0) {
    return { statusCode: 200, body: isFirst ? 'GUIDs initialized' : 'No new items' };
  }

  // Get subscribers
  let subs = [];
  try {
    const { blobs } = await subStore.list();
    subs = (await Promise.all(blobs.map(async b => {
      try { return JSON.parse(await subStore.get(b.key)); } catch(e) { return null; }
    }))).filter(Boolean);
  } catch(e) {}

  if (subs.length === 0) return { statusCode: 200, body: 'No subscribers' };

  // Build payload
  const cat = detectCat(newItems[0].title);
  const payload = {
    title: newItems.length === 1 ? `${EMOJI[cat]||'📰'} FJFeed` : `📰 FJFeed — ${newItems.length} berita baru`,
    body:  newItems.length === 1 ? newItems[0].title : newItems.slice(0,2).map(i=>`• ${i.title}`).join('\n'),
    url:   newItems[0]?.link || '/',
    icon:  '/icon-192.png',
  };

  // Send + cleanup stale
  const stale = [];
  await Promise.allSettled(subs.map(async sub => {
    try {
      const status = await sendPush(sub, payload);
      if (status === 410 || status === 404) {
        stale.push(Buffer.from(sub.endpoint).toString('base64').slice(0,100));
      }
    } catch(e) {}
  }));
  await Promise.allSettled(stale.map(k => subStore.delete(k)));

  console.log(`Pushed ${newItems.length} items to ${subs.length} subs, ${stale.length} stale removed`);
  return { statusCode: 200, body: `OK` };
};

// Export with schedule decorator — this is how Netlify detects scheduled functions
exports.handler = schedule('* * * * *', handler);
