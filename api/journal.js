// api/journal.js
// Trade journal — POST (create), PATCH (close), GET (list), DELETE (soft-delete)
// GET ?action=analyze — AI analysis of closed trades (Groq, cached 1h per device)
// Redis: journal:{device_id}:{id} (full entry), journal_index:{device_id} (sorted set by created_at ms)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const ANALYSIS_CACHE_TTL = 60 * 60; // 1 hour

async function aiCall(messages, maxTokens = 1000) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: maxTokens, temperature: 0.4 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${r.status}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

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

  // ── GET ?action=analyze — AI performance analysis ────
  if (req.method === 'GET' && req.query.action === 'analyze') {
    const cacheKey = `journal_analysis:${deviceId}`;
    const force    = req.query.force === '1';

    if (!force) {
      try {
        const cached = await redisCmd('GET', cacheKey);
        if (cached) return res.status(200).json({ ...JSON.parse(cached), from_cache: true });
      } catch(e) { console.warn('journal analyze: Redis GET failed:', e.message); }
    }

    // Load all closed entries
    let entries = [];
    try {
      const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
      for (const id of ids) {
        const raw = await redisCmd('GET', `journal:${deviceId}:${id}`);
        if (!raw) continue;
        try { const e = JSON.parse(raw); if (e.status === 'closed') entries.push(e); } catch(_) {}
      }
    } catch(e) {
      console.error('journal analyze: Redis fetch failed:', e.message);
      return res.status(500).json({ error: 'Gagal membaca data jurnal' });
    }

    if (entries.length < 3) {
      return res.status(200).json({
        analysis: null, insufficient_data: true, closed_count: entries.length,
        message: `Butuh minimal 3 trade closed untuk analisis. Saat ini baru ada ${entries.length}.`,
      });
    }

    const withR   = entries.filter(e => e.r_actual != null);
    const wins    = withR.filter(e => e.r_actual > 0).length;
    const totalR  = withR.reduce((s, e) => s + e.r_actual, 0);
    const avgR    = withR.length > 0 ? (totalR / withR.length).toFixed(2) : 'N/A';
    const winRate = withR.length > 0 ? Math.round(wins / withR.length * 100) : 'N/A';

    const tradeSummaries = entries.map((e, i) => {
      const result = e.r_actual != null ? (e.r_actual >= 0 ? `WIN +${e.r_actual}R` : `LOSS ${e.r_actual}R`) : 'RESULT UNKNOWN';
      const cotInfo = e.cot_snapshot ? Object.entries(e.cot_snapshot).map(([c, v]) => `${c} COT net=${v.lev_net}`).join(', ') : 'no COT';
      return [
        `Trade ${i + 1}: ${e.pair} ${(e.direction || '').toUpperCase()} | ${result}`,
        `  RR planned: ${e.rr_planned || 'N/A'} | Horizon: ${e.time_horizon || 'N/A'}`,
        `  Regime: ${e.regime_at_entry || 'N/A'} | ${cotInfo}`,
        `  Thesis: ${(e.thesis_text || '').slice(0, 200)}`,
        e.attribution_notes ? `  Post-trade note: ${e.attribution_notes.slice(0, 150)}` : '',
        `  Exit reason: ${e.exit_reason || 'N/A'}`,
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    let analysis = '';
    try {
      analysis = await aiCall([
        { role: 'system', content: 'Kamu adalah coach trading forex profesional yang menganalisis jurnal trading seorang trader retail. Berikan analisis jujur, spesifik, dan actionable dalam bahasa Indonesia. Format: heading dengan **bold**, poin-poin ringkas. Jangan bertele-tele. Fokus pada pola nyata dari data.' },
        { role: 'user', content: `Analisis ${entries.length} trade closed berikut:\n\nStatistik: Win rate ${winRate}% | Total R ${typeof totalR === 'number' ? totalR.toFixed(2) : totalR} | Avg R/trade ${avgR}\n\n${tradeSummaries}\n\nAnalisis:\n1. **Pola Kemenangan & Kekalahan** — apa yang membedakan trade menang vs kalah?\n2. **Kualitas Thesis** — apakah thesis terbukti relevan dengan hasil?\n3. **Kelemahan Utama** — 2-3 kelemahan paling jelas\n4. **Kekuatan yang Bisa Dipertahankan**\n5. **Rekomendasi Konkret** — 2-3 hal spesifik untuk diperbaiki\n\nMaksimal 500 kata.` },
      ], 1000);
    } catch(e) {
      console.error('journal analyze: AI call failed:', e.message);
      return res.status(502).json({ error: 'AI tidak tersedia: ' + e.message });
    }

    const payload = {
      analysis, closed_count: entries.length,
      win_rate: winRate,
      total_r:  withR.length > 0 ? parseFloat(totalR.toFixed(2)) : null,
      avg_r:    avgR !== 'N/A' ? parseFloat(avgR) : null,
      generated_at: new Date().toISOString(),
    };
    redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', ANALYSIS_CACHE_TTL).catch(() => {});
    return res.status(200).json(payload);
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
