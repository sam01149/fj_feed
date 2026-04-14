const CACHE_NAME = 'fjfeed-v1';
const FETCH_URL = '/.netlify/functions/rss';

let seenGuids = new Set();

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });

self.addEventListener('periodicsync', e => {
  if (e.tag === 'fjfeed-sync') e.waitUntil(checkForNewItems());
});

self.addEventListener('message', e => {
  if (e.data.type === 'INIT_GUIDS') seenGuids = new Set(e.data.guids);
  if (e.data.type === 'CHECK_NOW') checkForNewItems();
  if (e.data.type === 'ADD_GUID') seenGuids.add(e.data.guid);
  if (e.data.type === 'SHOW_DIGEST_NOTIF') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      tag: 'digest-' + e.data.session,
      vibrate: [200, 100, 200],
      data: { url: '/' },
    });
  }
});

async function fetchRSS() {
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 12000);
    const r = await fetch(FETCH_URL, { signal: c.signal });
    if (r.ok) {
      const t = await r.text();
      if (t.includes('<rss')) return t;
    }
  } catch(e) {}
  return null;
}

function parseItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1] || '';
    const guid = (/<guid[^>]*>(.*?)<\/guid>/.exec(block))?.[1] || '';
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1] || '';
    const link = (/<link>(.*?)<\/link>/.exec(block))?.[1] || '';
    const desc = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) || /<description>([\s\S]*?)<\/description>/.exec(block))?.[1] || '';
    const clean = title.replace(/^FinancialJuice:\s*/i, '').trim();
    if (guid) items.push({ title: clean, guid, pubDate, link, desc });
  }
  return items;
}

function detectCat(title) {
  const t = title.toLowerCase();
  const CATS = {
    'market-moving': ['market moving', 'breaking', 'flash', 'urgent', 'alert'],
    'forex':    ['eur/', '/usd', 'gbp/', '/jpy', 'aud/', 'cad/', 'nzd/', '/chf', 'fx options', 'options expir', 'usd/cad', 'eur/usd', 'gbp/usd', 'dollar index', 'dxy'],
    'equities': ['s&p', 'nasdaq', 'dow', 'ftse', 'dax', 'nikkei', 'hang seng', 'stock', 'equity', 'shares', 'earnings', 'ipo', 'nyse', 'spx', 'nvda', 'apple', 'tesla', 'meta ', 'alphabet', 'microsoft'],
    'commodities': ['gold', 'silver', 'copper', 'wheat', 'corn', 'soybean', 'coffee', 'cocoa', 'cotton', 'lumber', 'palladium', 'platinum', 'xau', 'xag', 'commodity'],
    'energy':   ['oil', 'crude', 'brent', 'wti', 'opec', 'energy', 'gasoline', 'diesel', 'natural gas', 'barrel', 'petroleum', 'hormuz', 'strait', 'iea', 'blockade', 'tanker', 'refiner', 'pipeline', 'lng'],
    'bonds':    ['bond', 'yield', 'treasury', 'gilt', 'bund', 'note', '2-year', '10-year', '30-year', 'basis point', 'bps', 'fixed income', 'debt', 'sovereign'],
    'crypto':   ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'coinbase', 'binance', 'stablecoin', 'defi', 'nft', 'altcoin'],
    'indexes':  ['index', 'indices', 'pmi', 'purchasing manager', 'composite', 'manufacturing index', 'services index'],
    'macro':    ['fed', 'fomc', 'powell', 'goolsbee', 'waller', 'kashkari', 'warsh', 'federal reserve', 'rate cut', 'rate hike', 'interest rate', 'ecb', 'boe', 'rba', 'boj', 'pboc', 'central bank', 'monetary policy', 'inflation', 'gdp', 'recession', 'imf', 'world bank', 'g7', 'g20', 'lagarde', 'bailey', 'ueda'],
    'econ-data': ['actual', 'forecast', 'previous', 'cpi', 'nfp', 'unemployment', 'retail sales', 'trade balance', 'consumer confidence', 'business confidence', 'industrial production', 'housing', 'jobs', 'payroll', 'nab business', 'westpac', 'sentiment'],
    'geopolitical': ['iran', 'iranian', 'tehran', 'nuclear', 'ceasefire', 'hezbollah', 'israel', 'lebanon', 'russia', 'ukraine', 'china', 'chinese', 'xi jinping', 'pboc', 'yuan', 'beijing', 'taiwan', 'north korea', 'sanctions', 'tariff', 'trade war', 'trump', 'white house', 'nato', 'war', 'military'],
  };
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'macro';
}

async function checkForNewItems() {
  const xml = await fetchRSS();
  if (!xml) return;

  const items = parseItems(xml);
  const newItems = items.filter(i => !seenGuids.has(i.guid));

  if (newItems.length === 0) return;

  // Add to seen
  newItems.forEach(i => seenGuids.add(i.guid));

  // Send to open clients
  const allClients = await clients.matchAll({ type: 'window' });
  allClients.forEach(c => c.postMessage({ type: 'NEW_ITEMS', items: newItems }));

  // Show notifications
  for (const item of newItems.slice(0, 5)) {
    const cat = detectCat(item.title);
    const catLabel = cat.replace('-', ' ').toUpperCase();
    await self.registration.showNotification(`[${catLabel}] FJFeed`, {
      body: item.title,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: item.guid,
      data: { url: item.link },
      vibrate: [100, 50, 100],
      requireInteraction: false,
      silent: false
    });
  }

  // If more than 5 new at once, batch notify
  if (newItems.length > 5) {
    await self.registration.showNotification(`FJFeed — ${newItems.length} berita baru`, {
      body: newItems.slice(0, 3).map(i => i.title).join('\n'),
      tag: 'batch-' + Date.now(),
      vibrate: [100, 50, 100]
    });
  }
}

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch(err) { data = { title: 'FJFeed', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'FJFeed', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'fjfeed-push-' + Date.now(),
      data: { url: data.url || '/' },
      vibrate: [100, 50, 100],
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.openWindow(url));
});
