// api/redis-keys.js
// Admin endpoint: canonical registry of all Redis keys used by Daun Merah.
// Lists active keys with live TTL info. Lists deprecated keys.
// Protected by x-admin-secret header (= CRON_SECRET env var).
//
// GET  /api/redis-keys                  → full registry (active + deprecated)
// GET  /api/redis-keys?key=risk_regime  → single key detail
// POST /api/redis-keys?action=cleanup   → delete all deprecated keys from Redis

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

// ── Active key registry ────────────────────────────────────────────────────────
// Wildcard entries (key contains '*') describe patterns — not probed individually.
const KEY_REGISTRY = [
  // App data
  { key: 'cb_bias',            owner: 'api/market-digest.js',  ttl_expected: null,   note: 'CB bias per currency, updated on each digest run' },
  { key: 'digest_history',     owner: 'api/market-digest.js',  ttl_expected: null,   note: 'Max 7 AI digest entries (array)' },
  { key: 'cot_cache_v2',       owner: 'api/cot.js',            ttl_expected: null,   note: 'CFTC COT payload — manual TTL ~6h' },
  { key: 'risk_regime',        owner: 'api/risk-regime.js',    ttl_expected: 1800,   note: 'VIX/MOVE/HY risk regime classifier' },
  { key: 'rss_cache',          owner: 'api/rss.js',            ttl_expected: 60,     note: 'FinancialJuice RSS XML' },
  { key: 'real_yields',        owner: 'api/real-yields.js',    ttl_expected: 21600,  note: 'Real yield per currency (DGS10-T10YIE for USD)' },
  { key: 'rate_path',          owner: 'api/rate-path.js',      ttl_expected: 14400,  note: 'USD rate path heuristic (SOFR/EFFR)' },
  { key: 'latest_thesis',      owner: 'api/market-digest.js',  ttl_expected: 21600,  note: 'Structured trade thesis JSON from Groq Call 3' },
  { key: 'correlations',       owner: 'api/correlations.js',   ttl_expected: 86400,  note: '20d+60d cross-asset correlation matrix' },
  // Prompt templates
  { key: 'prompt_digest',      owner: 'api/admin-prompts.js',  ttl_expected: null,   note: 'Groq prompt for market briefing (fallback: hardcoded)' },
  { key: 'prompt_bias',        owner: 'api/admin-prompts.js',  ttl_expected: null,   note: 'Groq prompt for CB bias assessment' },
  { key: 'prompt_thesis',      owner: 'api/admin-prompts.js',  ttl_expected: null,   note: 'Groq prompt for structured thesis JSON' },
  // Health monitoring
  { key: 'health_last_ok',     owner: 'api/health.js',         ttl_expected: null,   note: 'HSET: source → last OK timestamp for alerting' },
  // Push notifications
  { key: 'push_subs',          owner: 'api/push.js',           ttl_expected: null,   note: 'HSET push subscriptions endpoint → JSON' },
  { key: 'seen_guids',         owner: 'api/push.js',           ttl_expected: 86400,  note: 'Set of seen RSS GUIDs for push dedup' },
  // Per-device patterns (not probed — enumerate with SCAN if needed)
  { key: 'sizing_history:*',   owner: 'api/sizing-history.js', ttl_expected: null,   note: 'Sorted set: sizing calculations per device (max 10 entries)' },
  { key: 'journal:*',          owner: 'api/journal.js',        ttl_expected: null,   note: 'Full journal entry JSON per device' },
  { key: 'journal_index:*',    owner: 'api/journal.js',        ttl_expected: null,   note: 'Sorted set: journal entry IDs by created_at timestamp' },
];

// Keys that existed in an older version and are safe to delete
const DEPRECATED_KEYS = [
  { key: 'cot_cache',          replaced_by: 'cot_cache_v2',  note: 'Old COT format, superseded in Task 10b' },
  { key: 'fundamentals_cache', replaced_by: null,            note: 'Fundamentals tab removed from UI' },
];

// ── Redis helper ───────────────────────────────────────────────────────────────

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

async function getKeyInfo(key) {
  if (key.includes('*')) return { exists: 'wildcard_pattern', ttl_actual: null };
  const [exists, ttl] = await Promise.all([redisCmd('EXISTS', key), redisCmd('TTL', key)]);
  const ttl_actual = ttl === -1 ? 'no_ttl' : ttl === -2 ? 'not_set' : ttl;
  return { exists: exists === 1, ttl_actual };
}

// ── Handler ────────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET && req.headers['x-admin-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — set x-admin-secret header' });
  }

  // POST ?action=cleanup → delete all deprecated keys present in Redis
  if (req.method === 'POST' && req.query.action === 'cleanup') {
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

  // GET ?key=... → single key detail
  const singleKey = req.query.key;
  if (singleKey) {
    const entry = KEY_REGISTRY.find(k => k.key === singleKey);
    if (!entry) {
      return res.status(404).json({ error: 'Key not in registry', hint: 'GET /api/redis-keys for full list' });
    }
    try {
      const liveInfo = await getKeyInfo(singleKey);
      return res.status(200).json({ ...entry, ...liveInfo, checked_at: new Date().toISOString() });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET → full registry with live info
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
      ? `POST /api/redis-keys?action=cleanup with x-admin-secret to delete: ${deprecatedPresent.join(', ')}`
      : 'No deprecated keys found in Redis',
    checked_at: new Date().toISOString(),
  });
};
