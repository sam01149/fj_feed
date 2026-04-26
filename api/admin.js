// api/admin.js — consolidated admin endpoint
// GET/POST    /api/admin?action=health[&source=...]        → health check all sources
// GET/POST    /api/admin?action=redis-keys[&key=...]       → Redis key registry
// GET/POST/DELETE /api/admin?action=admin-prompts&key=...  → manage Groq prompt templates
// GET         /api/admin?action=push                       → cron: send push notifications
//
// Auth: health/redis-keys/admin-prompts use x-admin-secret header
//       push uses x-cron-secret header
// Update cron-job.org URLs:
//   /api/health → /api/admin?action=health
//   /api/push   → /api/admin?action=push

const webpush = require('web-push');

module.exports = async function handler(req, res) {
  const action = req.query.action;
  if (action === 'health')        return healthHandler(req, res);
  if (action === 'redis-keys')    return redisKeysHandler(req, res);
  if (action === 'admin-prompts') return adminPromptsHandler(req, res);
  if (action === 'push')          return pushHandler(req, res);
  return res.status(400).json({ error: 'Missing ?action= — use health, redis-keys, admin-prompts, or push' });
};

// ── Shared Redis helper ────────────────────────────────────────────────────────

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await r.json()).result;
}

// ── Health handler (was api/health.js) ────────────────────────────────────────

const HEALTH_CORS            = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
const HEALTH_ALERT_THRESHOLD = 2 * 60 * 60 * 1000;
const HEALTH_REDIS_KEY       = 'health_last_ok';

async function sendHealthTelegram(text) {
  const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch(e) { console.warn('health: Telegram alert failed:', e.message); }
}

async function probeFred() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return { status: 'UNCONFIGURED', note: 'FRED_API_KEY not set' };
  const r = await fetch(
    `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${apiKey}&limit=1&sort_order=desc&file_type=json`,
    { headers: { 'User-Agent': 'DaunMerah/1.0' }, signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  const obs = (json.observations || []).filter(o => o.value !== '.');
  if (obs.length === 0) throw new Error('No observations returned');
  return { latest_date: obs[0].date, series: 'VIXCLS' };
}

async function probeStooq() {
  const r = await fetch('https://stooq.com/q/d/l/?s=%5evix&i=d&l=3', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const csv = await r.text();
  const lines = csv.trim().split('\n').filter(l => l && !l.startsWith('Date'));
  if (lines.length === 0) throw new Error('Empty CSV response');
  return { rows: lines.length, symbol: '^vix' };
}

async function probeForexFactory() {
  const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.xml', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaunMerah/1.0)' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.includes('<eventInfo>') && !txt.includes('<event>')) throw new Error('Unexpected XML structure');
  return { size_bytes: txt.length };
}

async function probeFinancialJuice() {
  const r = await fetch('https://www.financialjuice.com/feed.ashx?xy=rss', {
    headers: {
      'User-Agent': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
      'Referer': 'https://www.financialjuice.com/',
      'Accept': 'application/rss+xml,*/*',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.includes('<rss')) throw new Error('Response is not valid RSS');
  return { size_bytes: txt.length };
}

async function probeCFTC() {
  const r = await fetch('https://www.cftc.gov/dea/options/financial_lof.htm', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DaunMerah/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.includes('EURO FX') && !txt.includes('JAPANESE YEN')) throw new Error('Currency data not found in page');
  return { size_bytes: txt.length };
}

async function probeRedis() {
  const result = await redisCmd('PING');
  if (result !== 'PONG') throw new Error(`Unexpected PING response: ${result}`);
  return {};
}

const PROBES = {
  fred:           { fn: probeFred,           label: 'FRED API' },
  stooq:          { fn: probeStooq,          label: 'Stooq CSV' },
  forexfactory:   { fn: probeForexFactory,   label: 'ForexFactory' },
  financialjuice: { fn: probeFinancialJuice, label: 'FinancialJuice RSS' },
  cftc:           { fn: probeCFTC,           label: 'CFTC COT' },
  redis:          { fn: probeRedis,          label: 'Upstash Redis' },
};

async function healthHandler(req, res) {
  Object.entries(HEALTH_CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  const singleSource = req.query.source;
  const targetProbes = singleSource
    ? (PROBES[singleSource] ? { [singleSource]: PROBES[singleSource] } : null)
    : PROBES;

  if (!targetProbes) {
    return res.status(400).json({ error: `Unknown source. Valid: ${Object.keys(PROBES).join(', ')}` });
  }

  const startTime = Date.now();

  let lastOkMap = {};
  try {
    const raw = await redisCmd('HGETALL', HEALTH_REDIS_KEY);
    if (raw && Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) lastOkMap[raw[i]] = raw[i + 1];
    }
  } catch(e) { console.warn('health: Redis HGETALL failed:', e.message); }

  const settled = await Promise.allSettled(
    Object.entries(targetProbes).map(async ([key, probe]) => {
      const t0 = Date.now();
      try {
        const detail = await probe.fn();
        return { key, label: probe.label, status: 'OK', latency_ms: Date.now() - t0, detail };
      } catch(e) {
        return { key, label: probe.label, status: 'DOWN', latency_ms: Date.now() - t0, error: e.message };
      }
    })
  );

  const now = new Date().toISOString();
  const report = {};
  const toAlert = [];

  for (const r of settled) {
    const { key, label, status, latency_ms, detail, error } = r.value;
    const lastOk   = lastOkMap[key] || null;
    const downMs   = status === 'DOWN' && lastOk ? Date.now() - new Date(lastOk).getTime() : null;
    const downMins = downMs ? Math.round(downMs / 60000) : null;

    report[key] = {
      label, status, latency_ms,
      last_ok: status === 'OK' ? now : lastOk,
      ...(detail || {}),
      ...(error ? { error } : {}),
      ...(downMins != null ? { down_since_mins: downMins } : {}),
    };

    if (status === 'OK') {
      redisCmd('HSET', HEALTH_REDIS_KEY, key, now).catch(() => {});
    } else if (!lastOk || downMs > HEALTH_ALERT_THRESHOLD) {
      toAlert.push({ label, error, lastOk });
    }
  }

  if (toAlert.length > 0) {
    const lines = toAlert.map(d =>
      `• *${d.label}*: ${d.error}${d.lastOk ? ` (OK terakhir: ${d.lastOk.substring(0, 16)} UTC)` : ' (belum pernah OK)'}`
    ).join('\n');
    sendHealthTelegram(`🔴 *Daun Merah — Source Alert*\n\n${lines}\n\n_Dicek: ${now.substring(0, 16)} UTC_`);
  }

  const statuses = Object.values(report).map(r => r.status);
  const overall  = statuses.every(s => s === 'OK' || s === 'UNCONFIGURED') ? 'OK'
    : statuses.some(s => s === 'OK') ? 'DEGRADED' : 'DOWN';

  return res.status(200).json({
    overall,
    checked_at: now,
    duration_ms: Date.now() - startTime,
    sources: report,
  });
}

// ── Redis keys handler (was api/redis-keys.js) ────────────────────────────────

const KEY_REGISTRY = [
  { key: 'cb_bias',            owner: 'api/market-digest.js',  ttl_expected: null,   note: 'CB bias per currency, updated on each digest run' },
  { key: 'digest_history',     owner: 'api/market-digest.js',  ttl_expected: null,   note: 'Max 7 AI digest entries (array)' },
  { key: 'cot_cache_v2',       owner: 'api/feeds.js',          ttl_expected: null,   note: 'CFTC COT payload — manual TTL ~6h' },
  { key: 'risk_regime',        owner: 'api/risk-regime.js',    ttl_expected: 1800,   note: 'VIX/MOVE/HY risk regime classifier' },
  { key: 'rss_cache',          owner: 'api/feeds.js',          ttl_expected: 60,     note: 'FinancialJuice RSS XML' },
  { key: 'real_yields',        owner: 'api/real-yields.js',    ttl_expected: 21600,  note: 'Real yield per currency (DGS10-T10YIE for USD)' },
  { key: 'rate_path',          owner: 'api/rate-path.js',      ttl_expected: 14400,  note: 'USD rate path heuristic (SOFR/EFFR)' },
  { key: 'latest_thesis',      owner: 'api/market-digest.js',  ttl_expected: 21600,  note: 'Structured trade thesis JSON from Groq Call 3' },
  { key: 'correlations',       owner: 'api/correlations.js',   ttl_expected: 86400,  note: '20d+60d cross-asset correlation matrix' },
  { key: 'prompt_digest',      owner: 'api/admin.js',          ttl_expected: null,   note: 'Groq prompt for market briefing (fallback: hardcoded)' },
  { key: 'prompt_bias',        owner: 'api/admin.js',          ttl_expected: null,   note: 'Groq prompt for CB bias assessment' },
  { key: 'prompt_thesis',      owner: 'api/admin.js',          ttl_expected: null,   note: 'Groq prompt for structured thesis JSON' },
  { key: 'health_last_ok',     owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET: source → last OK timestamp for alerting' },
  { key: 'push_subs',          owner: 'api/admin.js',          ttl_expected: null,   note: 'HSET push subscriptions endpoint → JSON' },
  { key: 'seen_guids',         owner: 'api/admin.js',          ttl_expected: 86400,  note: 'Set of seen RSS GUIDs for push dedup' },
  { key: 'sizing_history:*',   owner: 'api/sizing-history.js', ttl_expected: null,   note: 'Sorted set: sizing calculations per device (max 10 entries)' },
  { key: 'journal:*',          owner: 'api/journal.js',        ttl_expected: null,   note: 'Full journal entry JSON per device' },
  { key: 'journal_index:*',    owner: 'api/journal.js',        ttl_expected: null,   note: 'Sorted set: journal entry IDs by created_at timestamp' },
];

const DEPRECATED_KEYS = [
  { key: 'cot_cache',          replaced_by: 'cot_cache_v2',  note: 'Old COT format, superseded in Task 10b' },
  { key: 'fundamentals_cache', replaced_by: null,            note: 'Fundamentals tab removed from UI' },
];

async function getKeyInfo(key) {
  if (key.includes('*')) return { exists: 'wildcard_pattern', ttl_actual: null };
  const [exists, ttl] = await Promise.all([redisCmd('EXISTS', key), redisCmd('TTL', key)]);
  const ttl_actual = ttl === -1 ? 'no_ttl' : ttl === -2 ? 'not_set' : ttl;
  return { exists: exists === 1, ttl_actual };
}

async function redisKeysHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  if (req.method === 'POST' && req.query.cleanup === 'true') {
    const deletable = DEPRECATED_KEYS.filter(d => !d.key.includes('*'));
    const deleted = [];
    for (const dep of deletable) {
      try {
        const result = await redisCmd('DEL', dep.key);
        if (result === 1) deleted.push(dep.key);
      } catch(e) { console.warn('redis-keys: cleanup DEL failed for', dep.key, e.message); }
    }
    return res.status(200).json({
      ok: true,
      deleted,
      skipped: deletable.filter(d => !deleted.includes(d.key)).map(d => d.key),
      deprecated_list: DEPRECATED_KEYS,
    });
  }

  const singleKey = req.query.key;
  if (singleKey) {
    const entry = KEY_REGISTRY.find(k => k.key === singleKey);
    if (!entry) {
      return res.status(404).json({ error: 'Key not in registry', hint: 'GET /api/admin?action=redis-keys for full list' });
    }
    try {
      const liveInfo = await getKeyInfo(singleKey);
      return res.status(200).json({ ...entry, ...liveInfo, checked_at: new Date().toISOString() });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const [activeWithInfo, deprecatedWithInfo] = await Promise.all([
    Promise.all(KEY_REGISTRY.map(async entry => {
      try { return { ...entry, ...(await getKeyInfo(entry.key)) }; }
      catch(e) { return { ...entry, exists: 'error', error: e.message }; }
    })),
    Promise.all(DEPRECATED_KEYS.map(async entry => {
      try {
        const exists = entry.key.includes('*') ? 'wildcard_pattern'
          : (await redisCmd('EXISTS', entry.key)) === 1;
        return { ...entry, exists };
      } catch(e) { return { ...entry, exists: 'error' }; }
    })),
  ]);

  const deprecatedPresent = deprecatedWithInfo.filter(d => d.exists === true).map(d => d.key);

  return res.status(200).json({
    active_keys: activeWithInfo,
    deprecated_keys: deprecatedWithInfo,
    deprecated_present_count: deprecatedPresent.length,
    cleanup_hint: deprecatedPresent.length > 0
      ? `POST /api/admin?action=redis-keys&cleanup=true with x-admin-secret to delete: ${deprecatedPresent.join(', ')}`
      : 'No deprecated keys found in Redis',
    checked_at: new Date().toISOString(),
  });
}

// ── Admin prompts handler (was api/admin-prompts.js) ──────────────────────────

const ALLOWED_PROMPT_KEYS = new Set(['prompt_digest', 'prompt_bias', 'prompt_thesis']);

async function adminPromptsHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  const key = req.query.key;
  if (!key || !ALLOWED_PROMPT_KEYS.has(key)) {
    return res.status(400).json({ error: 'key must be one of: ' + [...ALLOWED_PROMPT_KEYS].join(', ') });
  }

  if (req.method === 'GET') {
    try {
      const val = await redisCmd('GET', key);
      return res.status(200).json({ key, value: val || null, source: val ? 'redis' : 'hardcoded_fallback' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    if (!body.trim()) return res.status(400).json({ error: 'Body cannot be empty' });
    try {
      await redisCmd('SET', key, body.trim());
      return res.status(200).json({ ok: true, key, length: body.trim().length });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await redisCmd('DEL', key);
      return res.status(200).json({ ok: true, key, message: 'Deleted — hardcoded default will be used' });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── Push handler (was api/push.js) ────────────────────────────────────────────

async function pushHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const CRON_SECRET   = process.env.CRON_SECRET;
  const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@daun-merah.app';
  const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
  const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

  if (CRON_SECRET && req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !REDIS_URL) {
    return res.status(200).json({ status: 'Not configured' });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  let seenGuids = new Set();
  try { const raw = await redisCmd('GET', 'seen_guids'); if (raw) seenGuids = new Set(JSON.parse(raw)); } catch(e) {}

  let xml = null;
  const RSS_UAS = [
    'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'NewsBlur Feed Fetcher - 1000000 subscribers',
  ];
  const PUSH_RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
  for (const ua of RSS_UAS) {
    try {
      const r = await fetch(PUSH_RSS_URL, {
        headers: { 'User-Agent': ua, 'Referer': 'https://www.financialjuice.com/', 'Accept': 'application/rss+xml, application/xml, */*', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const text = await r.text();
        if (text.includes('<rss')) { xml = text; break; }
      }
    } catch(e) { console.warn('RSS attempt failed:', ua.substring(0, 20), e.message); }
  }
  if (!xml) return res.status(200).json({ status: 'RSS unavailable' });

  const items = parsePushRSS(xml);
  const isFirst = seenGuids.size === 0;
  const newItems = isFirst ? [] : items.filter(i => !seenGuids.has(i.guid));

  items.forEach(i => seenGuids.add(i.guid));
  try { await redisCmd('SET', 'seen_guids', JSON.stringify([...seenGuids].slice(-500)), 'EX', 86400); } catch(e) {}

  if (newItems.length === 0) return res.status(200).json({ status: isFirst ? 'Initialized' : 'No new items' });

  await sendPushTelegram(newItems, TG_TOKEN, TG_CHAT_ID);

  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs');
    if (raw && Array.isArray(raw)) { for (let i = 1; i < raw.length; i += 2) { try { subs.push(JSON.parse(raw[i])); } catch(e) {} } }
  } catch(e) {}

  if (subs.length > 0) {
    const EMOJI = { 'market-moving': '🔴', 'forex': '💱', 'energy': '⚡', 'macro': '🏦', 'geopolitical': '🌐', 'econ-data': '📋', 'news': '📰' };
    const cat = detectPushCat(newItems[0].title);
    const payload = JSON.stringify({
      title: newItems.length === 1 ? `${EMOJI[cat] || '📰'} Daun Merah` : `📰 Daun Merah — ${newItems.length} berita baru`,
      body:  newItems.length === 1 ? newItems[0].title : newItems.slice(0, 2).map(i => `• ${i.title}`).join('\n'),
      url:   newItems[0]?.link || '/',
      icon:  '/icon-192.png',
    });
    const staleKeys = [];
    await Promise.allSettled(subs.map(async sub => {
      try { await webpush.sendNotification(sub, payload); }
      catch(e) { if (e.statusCode === 410 || e.statusCode === 404) staleKeys.push(Buffer.from(sub.endpoint).toString('base64').slice(0, 80)); }
    }));
    if (staleKeys.length > 0) await redisCmd('HDEL', 'push_subs', ...staleKeys);
  }

  return res.status(200).json({ status: 'OK', new_items: newItems.length, subscribers: subs.length });
}

async function sendPushTelegram(newItems, TG_TOKEN, TG_CHAT_ID) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const EMOJI = { 'market-moving': '🔴', 'forex': '💱', 'energy': '⚡', 'macro': '🏦', 'geopolitical': '🌐', 'econ-data': '📋', 'news': '📰' };
  const lines = newItems.slice(0, 10).map(i => `${EMOJI[detectPushCat(i.title)] || '📰'} ${i.link ? `[${i.title}](${i.link})` : i.title}`);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `*Daun Merah — ${newItems.length} berita baru*\n\n${lines.join('\n')}`, parse_mode: 'Markdown', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch(e) { console.warn('Telegram:', e.message); }
}

function parsePushRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1 || r2)?.[1]?.trim() || ''; };
    const title = get('title').replace(/^FinancialJuice:\s*/i, '').trim(), guid = get('guid'), link = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, link });
  }
  return items;
}

function detectPushCat(t) {
  t = t.toLowerCase();
  if (['market moving', 'breaking', 'blockade'].some(k => t.includes(k))) return 'market-moving';
  if (['eur/', 'gbp/', 'usd/', 'aud/', 'nzd/', 'cad/', 'chf/', 'jpy/', '/usd', '/jpy', 'dxy', 'loonie', 'aussie', 'cable'].some(k => t.includes(k))) return 'forex';
  if (['oil', 'crude', 'brent', 'wti', 'natural gas', 'hormuz', 'iea'].some(k => t.includes(k))) return 'energy';
  if (['fed ', 'fomc', 'powell', 'federal reserve', 'rate cut', 'ecb', 'boe', 'boj', 'pboc'].some(k => t.includes(k))) return 'macro';
  if (['iran', 'israel', 'russia', 'ukraine', 'china', 'trump', 'nato', 'war', 'tariff'].some(k => t.includes(k))) return 'geopolitical';
  if (['actual', 'forecast', 'previous', 'cpi', 'nfp', 'unemployment'].some(k => t.includes(k))) return 'econ-data';
  return 'news';
}
