// api/sizing-history.js
// Saves/retrieves last 10 position sizing calculations per device.
// Redis: sorted set 'sizing_history:{device_id}', score = timestamp, member = JSON string.

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const deviceId = req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });

  const key = `sizing_history:${deviceId}`;

  if (req.method === 'POST') {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    let entry;
    try { entry = JSON.parse(body); } catch(e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    entry.timestamp = Date.now();
    try {
      await redisCmd('ZADD', key, entry.timestamp, JSON.stringify(entry));
      await redisCmd('ZREMRANGEBYRANK', key, 0, -11); // keep last 10
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('sizing-history POST failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const items = await redisCmd('ZRANGE', key, 0, -1, 'WITHSCORES') || [];
      const entries = [];
      for (let i = 0; i < items.length; i += 2) {
        try { entries.push(JSON.parse(items[i])); } catch(e) {}
      }
      return res.status(200).json({ entries: entries.reverse() }); // newest first
    } catch(e) {
      console.error('sizing-history GET failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
