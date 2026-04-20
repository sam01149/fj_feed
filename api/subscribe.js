// api/subscribe.js
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  return (await res.json()).result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(500).json({ error: 'Redis not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (req.method === 'DELETE') {
      const { endpoint } = body;
      if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
      await redisCmd('HDEL', 'push_subs', Buffer.from(endpoint).toString('base64').slice(0,80));
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST') {
      const { subscription } = body;
      if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
      await redisCmd('HSET', 'push_subs', Buffer.from(subscription.endpoint).toString('base64').slice(0,80), JSON.stringify(subscription));
      return res.status(201).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
