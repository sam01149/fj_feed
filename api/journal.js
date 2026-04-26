// api/journal.js
// Trade journal — POST (create), PATCH (close), GET (list), DELETE (soft-delete)
// Redis: journal:{device_id}:{id} (full entry), journal_index:{device_id} (sorted set by created_at ms)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(6000),
  });
  return (await r.json()).result;
}

async function readBody(req) {
  let body = '';
  await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
  return body;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const deviceId = req.query.device_id;
  if (!deviceId) return res.status(400).json({ error: 'device_id required' });

  const indexKey = `journal_index:${deviceId}`;

  // ── POST — create entry ───────────────────────────────
  if (req.method === 'POST') {
    let data;
    try { data = JSON.parse(await readBody(req)); }
    catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    const id = uid();
    const now = Date.now();
    const entry = {
      id, device_id: deviceId, created_at: new Date(now).toISOString(),
      // open fields
      pair:              data.pair             || '',
      direction:         data.direction        || '',
      regime_at_entry:   data.regime_at_entry  || null,
      thesis_text:       data.thesis_text      || '',
      driver_references: data.driver_references || [],
      cb_bias_snapshot:  data.cb_bias_snapshot  || null,
      cot_snapshot:      data.cot_snapshot      || null,
      entry_price:       data.entry_price       != null ? parseFloat(data.entry_price) : null,
      stop_price:        data.stop_price        != null ? parseFloat(data.stop_price)  : null,
      target_price:      data.target_price      != null ? parseFloat(data.target_price): null,
      size_lots:         data.size_lots         != null ? parseFloat(data.size_lots)   : null,
      rr_planned:        data.rr_planned        != null ? parseFloat(data.rr_planned)  : null,
      time_horizon:      data.time_horizon      || '',
      // closed fields (filled on PATCH)
      status:            'open',
      exit_price:        null,
      exit_reason:       null,
      r_actual:          null,
      attribution_notes: null,
      closed_at:         null,
    };

    try {
      const entryKey = `journal:${deviceId}:${id}`;
      await redisCmd('SET', entryKey, JSON.stringify(entry));
      await redisCmd('ZADD', indexKey, now, id);
      return res.status(200).json({ ok: true, id });
    } catch(e) {
      console.error('journal POST failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // ── PATCH — close/update entry ────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    let data;
    try { data = JSON.parse(await readBody(req)); }
    catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

    try {
      const entryKey = `journal:${deviceId}:${id}`;
      const raw = await redisCmd('GET', entryKey);
      if (!raw) return res.status(404).json({ error: 'Entry not found' });
      const entry = JSON.parse(raw);

      // Allow partial update of any close fields
      if (data.exit_price    != null) entry.exit_price    = parseFloat(data.exit_price);
      if (data.exit_reason               ) entry.exit_reason    = data.exit_reason;
      if (data.r_actual      != null) entry.r_actual      = parseFloat(data.r_actual);
      if (data.attribution_notes         ) entry.attribution_notes = data.attribution_notes;
      if (data.status                    ) entry.status          = data.status;

      // Auto-set closed_at when status becomes closed/archived
      if (data.status === 'closed' || data.status === 'archived') {
        entry.closed_at = entry.closed_at || new Date().toISOString();
      }

      await redisCmd('SET', entryKey, JSON.stringify(entry));
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('journal PATCH failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // ── GET — list entries ────────────────────────────────
  if (req.method === 'GET') {
    const statusFilter = req.query.status || 'all'; // all | open | closed | archived
    try {
      // Get all IDs from index sorted by score (created_at ms) newest first
      const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
      const entries = [];
      for (const id of ids) {
        const raw = await redisCmd('GET', `journal:${deviceId}:${id}`);
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw);
          if (statusFilter !== 'all' && entry.status !== statusFilter) continue;
          entries.push(entry);
        } catch(e) {
          console.warn('journal GET parse error for id', id, ':', e.message);
        }
      }
      return res.status(200).json({ entries });
    } catch(e) {
      console.error('journal GET failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // ── DELETE — soft delete (set status = archived) ──────
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    try {
      const entryKey = `journal:${deviceId}:${id}`;
      const raw = await redisCmd('GET', entryKey);
      if (!raw) return res.status(404).json({ error: 'Entry not found' });
      const entry = JSON.parse(raw);
      entry.status = 'archived';
      entry.closed_at = entry.closed_at || new Date().toISOString();
      await redisCmd('SET', entryKey, JSON.stringify(entry));
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('journal DELETE failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
