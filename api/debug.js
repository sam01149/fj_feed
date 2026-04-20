// api/debug.js — TEMPORARY, hapus setelah masalah resolved
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const results = {};

  // Test 1: env vars
  results.env = {
    GROQ_API_KEY:          process.env.GROQ_API_KEY          ? 'SET (len=' + process.env.GROQ_API_KEY.length + ')' : 'NOT SET',
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? 'SET' : 'NOT SET',
    TELEGRAM_BOT_TOKEN:    process.env.TELEGRAM_BOT_TOKEN    ? 'SET' : 'NOT SET',
  };

  // Test 2: RSS fetch
  try {
    const r = await fetch('https://www.financialjuice.com/feed.ashx?xy=rss', {
      headers: { 'User-Agent': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html)', 'Referer': 'https://www.financialjuice.com/' },
      signal: AbortSignal.timeout(10000),
    });
    const text = await r.text();
    results.rss = { status: r.status, ok: r.ok, is_rss: text.includes('<rss'), length: text.length };
  } catch(e) { results.rss = { error: e.message }; }

  // Test 3: Groq ping
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'Balas hanya dengan kata: OK' }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const gd = await r.json();
      results.groq = {
        status: r.status,
        ok: r.ok,
        response: gd?.choices?.[0]?.message?.content || JSON.stringify(gd).substring(0, 200),
      };
    } catch(e) { results.groq = { error: e.message }; }
  } else {
    results.groq = { error: 'GROQ_API_KEY not set' };
  }

  return res.status(200).json(results);
};
