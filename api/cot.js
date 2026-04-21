// api/cot.js
// Fetches CFTC COT report (TFF - Traders in Financial Futures)
// Tracks Leveraged Funds (hedge fund) net positions for 7 major currencies
// Released every Friday 3:30 PM ET — cached in Redis 6 hours

const CFTC_URL    = 'https://www.cftc.gov/dea/options/financial_lof.htm';
const CACHE_TTL   = 6 * 60 * 60 * 1000;

const MARKET_MARKERS = {
  EUR: ['euro fx'],
  GBP: ['british pound'],
  JPY: ['japanese yen'],
  CAD: ['canadian dollar'],
  AUD: ['australian dollar'],
  NZD: ['new zealand dollar', 'nz dollar'],
  CHF: ['swiss franc'],
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // Serve Redis cache if fresh
  try {
    const cached = await redisCmd('GET', 'cot_cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - new Date(parsed.fetched_at).getTime() < CACHE_TTL) {
        return res.status(200).json(parsed);
      }
    }
  } catch(e) {}

  // Fetch CFTC page
  let preText = '';
  try {
    const r = await fetch(CFTC_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!preMatch) throw new Error('No <pre> block in CFTC response');
    preText = preMatch[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  } catch(e) {
    console.error('CFTC fetch failed:', e.message);
    // Return stale cache rather than error
    try {
      const stale = await redisCmd('GET', 'cot_cache');
      if (stale) return res.status(200).json({ ...JSON.parse(stale), stale: true });
    } catch(e2) {}
    return res.status(502).json({ error: 'CFTC unavailable: ' + e.message });
  }

  // Report date from header line
  const dateMatch = preText.match(/Positions as of\s+([A-Za-z]+ \d+,?\s*\d{4})/i);
  const reportDate = dateMatch ? dateMatch[1].trim() : null;

  const positions = {};
  const textLower = preText.toLowerCase();

  for (const [currency, markers] of Object.entries(MARKET_MARKERS)) {
    // Find start of this contract block
    let blockStart = -1;
    for (const marker of markers) {
      const idx = textLower.indexOf(marker);
      if (idx !== -1) { blockStart = idx; break; }
    }
    if (blockStart === -1) continue;

    // Block ends just before the NEXT contract's "CFTC Code #"
    const firstCode = textLower.indexOf('cftc code #', blockStart);
    if (firstCode === -1) continue;
    const nextCode  = textLower.indexOf('cftc code #', firstCode + 50);
    const block = preText.slice(blockStart, nextCode !== -1 ? nextCode - 50 : blockStart + 3000);
    const lines = block.split('\n');

    // Find "Positions" label → data is on next line with numbers
    let posIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*Positions\s*$/i.test(lines[i])) { posIdx = i; break; }
    }

    let dataLine = '';
    if (posIdx !== -1) {
      for (let i = posIdx + 1; i < Math.min(posIdx + 4, lines.length); i++) {
        if (/[\d,]{3,}/.test(lines[i])) { dataLine = lines[i]; break; }
      }
    }
    // Fallback: first line with 10+ numbers
    if (!dataLine) {
      for (const line of lines) {
        const n = line.trim().split(/\s+/).filter(s => /^-?[\d,]+$/.test(s));
        if (n.length >= 10) { dataLine = line; break; }
      }
    }
    if (!dataLine) continue;

    const nums = dataLine.trim().split(/\s+/)
      .map(s => parseInt(s.replace(/,/g, '')))
      .filter(n => !isNaN(n));
    if (nums.length < 8) continue;

    // TFF column layout (0-indexed):
    // 0: Dealer Long  1: Dealer Short  2: Dealer Spread
    // 3: AM Long      4: AM Short      5: AM Spread
    // 6: Lev Long     7: Lev Short     8: Lev Spread
    // 9: Other Long  10: Other Short  11: Other Spread
    // 12: NR Long    13: NR Short
    const levLong  = nums[6];
    const levShort = nums[7];
    const net = levLong - levShort;

    // Find "Changes from:" → data on next line
    let changeNet = null;
    for (let i = 0; i < lines.length; i++) {
      if (/Changes from/i.test(lines[i])) {
        let changeLine = '';
        if (i + 1 < lines.length && /[\d,]/.test(lines[i + 1])) {
          changeLine = lines[i + 1];
        }
        if (changeLine) {
          const cn = changeLine.trim().split(/\s+/)
            .map(s => parseInt(s.replace(/,/g, '')))
            .filter(n => !isNaN(n));
          if (cn.length >= 8) changeNet = cn[6] - cn[7];
        }
        break;
      }
    }

    positions[currency] = { lev_long: levLong, lev_short: levShort, net, change_net: changeNet };
  }

  const payload = {
    positions,
    report_date: reportDate,
    category: 'Leveraged Funds',
    fetched_at: new Date().toISOString(),
  };

  redisCmd('SET', 'cot_cache', JSON.stringify(payload)).catch(() => {});
  return res.status(200).json(payload);
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()).result;
}
