// api/_ratelimit.js
// Shared rate limiter using Redis sliding-window counter (per IP per endpoint).
// Underscore prefix = Vercel does NOT expose this as a public route.
//
// Usage:
//   const rateLimit = require('./_ratelimit')
//   const limited = await rateLimit(req, res, { limit: 10, windowSecs: 60 })
//   if (limited) return  // response already sent (429)
//
// Default: 60 req / 60s per IP. Heavy endpoints (market-digest, correlations) use lower limits.
// Cron-job.org and Vercel internal traffic are whitelisted automatically.

// IPs that are always allowed (cron services, internal Vercel, localhost)
const WHITELIST_PREFIXES = [
  '127.', '::1', '::ffff:127.',
  '10.',                          // private network (Vercel internal)
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
];

// cron-job.org IPv4 ranges (documented at cron-job.org)
const CRON_JOB_ORG_IPS = new Set([
  '195.201.26.157', '195.201.2.17', '159.69.210.141',
  '49.12.216.245',  '49.12.216.246',
]);

function isWhitelisted(ip) {
  if (!ip) return false;
  if (CRON_JOB_ORG_IPS.has(ip)) return true;
  return WHITELIST_PREFIXES.some(prefix => ip.startsWith(prefix));
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

async function redisCmd(url, token, ...args) {
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(3000),
    });
    return (await r.json()).result;
  } catch(e) { return null; }
}

/**
 * @param {object} req   - Vercel/Node request
 * @param {object} res   - Vercel/Node response
 * @param {object} opts
 * @param {number}  opts.limit       - Max requests per window (default 60)
 * @param {number}  opts.windowSecs  - Window size in seconds (default 60)
 * @param {string}  opts.endpoint    - Label for the Redis key (default: req.url path)
 * @returns {boolean} true if request was rate-limited and 429 was sent
 */
module.exports = async function rateLimit(req, res, opts = {}) {
  const { limit = 60, windowSecs = 60, endpoint } = opts;

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Redis is unavailable, fail open (don't block legitimate traffic)
  if (!REDIS_URL || !REDIS_TOKEN) return false;

  const ip = getClientIp(req);
  if (isWhitelisted(ip)) return false;

  const label  = endpoint || (req.url || 'unknown').split('?')[0].replace(/\//g, '_').slice(0, 40);
  const window = Math.floor(Date.now() / (windowSecs * 1000)); // current window index
  const key    = `rl:${label}:${ip}:${window}`;

  let count = null;
  try {
    // Atomic increment + set TTL only on first write
    count = await redisCmd(REDIS_URL, REDIS_TOKEN, 'INCR', key);
    if (count === 1) {
      // New key — set expiry to twice the window for safety
      redisCmd(REDIS_URL, REDIS_TOKEN, 'EXPIRE', key, windowSecs * 2).catch(() => {});
    }
  } catch(e) {
    console.warn('ratelimit: Redis error — failing open:', e.message);
    return false;
  }

  const remaining = Math.max(0, limit - (count || 0));
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String((window + 1) * windowSecs));

  if (count > limit) {
    res.setHeader('Retry-After', String(windowSecs));
    res.status(429).json({
      error: 'Too many requests',
      retry_after_secs: windowSecs,
    });
    return true; // caller must return after this
  }

  return false;
};
