// api/unified-digest.js
const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

module.exports = async function handler(req, res) {
  console.log('market-digest v2 START', new Date().toISOString());
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('x-vercel-cache', 'BYPASS');
  const GROQ_KEY = process.env.GROQ_API_KEY;

  // 1. RSS — fetch from internal /api/rss (cached) to avoid direct FJ blocking
  let rssItems = [];
  try {
    const host = req.headers.host || 'financial-feed-app.vercel.app';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const r = await fetch(`${proto}://${host}/api/rss`, {
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const xml = await r.text();
      if (xml.includes('<rss')) rssItems = parseRSS(xml);
    }
  } catch(e) {
    console.warn('Internal RSS fetch failed:', e.message);
  }

  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const recentItems = rssItems.filter(i => new Date(i.pubDate).getTime() > cutoff).slice(0, 80);

  // 2. Calendar
  let calEvents = [];
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
      fetch(FF_NEXT_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
    ]);
    let allEvents = [];
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        const xml = await result.value.text();
        if (xml.includes('<event>')) allEvents = allEvents.concat(parseFFXML(xml));
      }
    }
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 3; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    const seen = new Set();
    calEvents = allEvents
      .filter(e => dateRange.has(e.date) && e.impact === 'High' && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => { const k=`${e.date}|${e.time_wib}|${e.currency}|${e.event}`; if(seen.has(k))return false; seen.add(k); return true; })
      .sort((a,b) => (a.date+a.time_wib).localeCompare(b.date+b.time_wib));
  } catch(e) { console.warn('Cal:', e.message); }

  // 3. Context
  const wibNow  = new Date(Date.now() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;
  const headlinesBlock = recentItems.length > 0 ? recentItems.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n') : '(Tidak ada headline)';
  const calBlock = calEvents.length > 0 ? calEvents.map(e=>`- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}`).join('\n') : '(Tidak ada event high-impact)';

  // 3b. Load digest history
  let digestHistory = [];
  try {
    const rawHist = await redisCmd('GET', 'digest_history');
    if (rawHist) digestHistory = JSON.parse(rawHist);
  } catch(e) {}
  const historyBlock = digestHistory.length > 0
    ? digestHistory.map(h => `[${h.wib}] ${h.summary}`).join('\n')
    : '(Belum ada riwayat — ini sesi pertama)';

  // 3c. Load externalized prompts from Redis (Task 10e) — fall back to hardcoded if missing
  let promptDigestInstr = null;
  try {
    promptDigestInstr = await redisCmd('GET', 'prompt_digest');
  } catch(e) {
    console.warn('prompt_digest Redis load failed:', e.message);
  }

  // 4. Groq Call 1: market briefing
  let article = null, method = 'groq';
  if (GROQ_KEY && recentItems.length > 0) {
    // Instruction part (can be overridden via Redis prompt_digest key)
    const DIGEST_INSTR_DEFAULT = `Kamu adalah analis pasar keuangan senior. Pembacamu adalah trader forex Indonesia yang sudah berpengalaman dengan gaya macro discretionary. Mereka sudah tahu cara baca chart dan sudah punya bias — yang mereka butuhkan dari kamu adalah konteks yang tidak bisa mereka lihat sendiri dari harga.

CARA MENULIS:

Tulis seperti seorang analis yang sedang briefing rekan sesama trader sebelum sesi dimulai. Langsung ke poin. Tidak ada basa-basi pembuka.

Untuk setiap tema yang kamu tulis, ikuti pola ini:
— Apa yang terjadi (fakta spesifik dari headlines, sebut angka kalau ada)
— Apa artinya untuk pair atau currency yang terdampak (arah tekanan, bukan sekadar "berpengaruh")
— Kalau ada sinyal yang saling bertentangan dalam tema yang sama, sebut kedua sisi dan nyatakan mana yang lebih dominan menurut kamu

Untuk event kalender:
— Sebut event paling krusial, waktu WIB-nya, dan konteksnya: apakah data ini akan konfirmasi atau tantang narrative yang sedang berjalan?

Untuk statement pejabat central bank yang ada di headlines:
— Kalau mereka bicara soal rate path atau inflation — analisa implikasinya
— Kalau mereka tidak bicara soal itu (misalnya bicara soal teknologi, regulasi, dll) — nyatakan bahwa tidak ada sinyal kebijakan dari mereka hari ini, itu sendiri informasi

Akhiri dengan satu kalimat tegas: apakah kondisi hari ini secara keseluruhan mengkonfirmasi atau mengontradiksi bias macro yang dominan di pasar saat ini?

LARANGAN ABSOLUT — kalau kamu menulis salah satu dari ini, analisismu gagal:
— "trader harus berhati-hati"
— "pasar masih volatile"
— "pergerakan tergantung data selanjutnya"
— "sentimen pasar masih mixed"
— Kalimat apapun yang bisa ditulis tanpa membaca headlines sama sekali

Seluruh output dalam Bahasa Indonesia. Tidak ada bullet list, tidak ada heading, tidak ada emoji, tidak ada bold.`;

    const digestInstr = promptDigestInstr || DIGEST_INSTR_DEFAULT;
    const prompt = `${digestInstr}

WAKTU SAAT INI: ${dateStr}, ${timeStr}

=== HEADLINE BERITA TERKINI (${recentItems.length} berita, 12 jam terakhir) ===
${headlinesBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

=== RINGKASAN SESI SEBELUMNYA ===
${historyBlock}`;

    try {
      const groqRes = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (groqRes.ok) {
        const gd = await groqRes.json();
        const raw = gd?.choices?.[0]?.message?.content || '';
        if (raw.trim()) article = raw.trim();
      } else {
        const errData = await groqRes.json().catch(()=>({}));
        console.warn('Groq HTTP error:', groqRes.status, errData?.error?.message || '');
        method = groqRes.status === 429 ? 'fallback_quota' : 'fallback';
      }
    } catch(e) { console.warn('Groq failed:', e.message); method = 'fallback'; }
  } else { method = 'fallback'; }

  // 5. Fallback
  if (!article) {
    method = 'fallback';
    if (recentItems.length === 0) {
      article = 'Tidak ada berita baru dalam 12 jam terakhir.';
    } else {
      const catGroups = {};
      recentItems.forEach(i => { const c=detectCat(i.title); if(!catGroups[c])catGroups[c]=[]; catGroups[c].push(i.title); });
      const priority = ['market-moving','macro','energy','geopolitical','forex','econ-data','equities','commodities','bonds'];
      const CAT_ID = { 'market-moving':'Penggerak utama pasar','macro':'Dari sisi kebijakan moneter','energy':'Di sektor energi','geopolitical':'Dari sisi geopolitik','forex':'Pada pasar valuta asing','econ-data':'Data ekonomi menunjukkan','equities':'Pasar saham mencatat','commodities':'Di pasar komoditas','bonds':'Pasar obligasi' };
      const parts = [];
      for (const cat of priority) { if (catGroups[cat]?.length > 0 && parts.length < 3) parts.push(`${CAT_ID[cat]||cat}: ${catGroups[cat][0].toLowerCase()}.`); }
      const calPart = calEvents.length > 0 ? `Event high-impact terdekat adalah ${calEvents[0].event} (${calEvents[0].currency}) pada ${calEvents[0].time_wib}, ${calEvents[0].date}.` : 'Tidak ada event high-impact terjadwal.';
      article = parts.join(' ') + '\n\n' + calPart;
    }
  }

  // ── 5b. Save current digest to history (max 7 entries) ──
  if (article && method === 'groq') {
    try {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const wibStr = `${String(wibNow.getUTCDate()).padStart(2,'0')} ${MONTHS[wibNow.getUTCMonth()]} ${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;
      const summary = article.replace(/\n/g, ' ').slice(0, 200);
      digestHistory.push({ at: new Date().toISOString(), wib: wibStr, summary });
      if (digestHistory.length > 7) digestHistory.splice(0, digestHistory.length - 7);
      await redisCmd('SET', 'digest_history', JSON.stringify(digestHistory));
      console.log('Digest history saved, entries:', digestHistory.length);
    } catch(e) { console.warn('Digest history save failed:', e.message); }
  }

  // ── 6. Groq Call 2: CB Bias Assessment ──────────────────
  let biasUpdated = [];
  if (GROQ_KEY && recentItems.length > 0) {
    const CB_KEYWORDS = {
      USD: ['fed ','fomc','powell','goolsbee','waller','kashkari','warsh','federal reserve','us inflation','us gdp','us jobs','nfp','us cpi'],
      EUR: ['ecb','lagarde','lane','schnabel','euro zone','eurozone','euro area','eu inflation','eu gdp'],
      GBP: ['boe','bank of england','bailey','pill','gbp','sterling','uk inflation','uk gdp','uk jobs','claimant'],
      JPY: ['boj','bank of japan','ueda','japan inflation','japan gdp','yen','japanese'],
      CAD: ['boc','bank of canada','macklem','canada inflation','canada gdp','canadian'],
      AUD: ['rba','reserve bank of australia','bullock','australia inflation','australia gdp','aussie'],
      NZD: ['rbnz','reserve bank of new zealand','orr','new zealand inflation','new zealand gdp','kiwi'],
      CHF: ['snb','swiss national bank','schlegel','switzerland','swiss franc','franc'],
    };

    // Find which currencies have relevant headlines
    const relevantCurrencies = [];
    const headlinesLower = recentItems.map(i => i.title.toLowerCase());
    for (const [cur, kws] of Object.entries(CB_KEYWORDS)) {
      if (kws.some(kw => headlinesLower.some(h => h.includes(kw)))) {
        relevantCurrencies.push(cur);
      }
    }

    console.log('relevantCurrencies:', JSON.stringify(relevantCurrencies));
    console.log('recentItems sample:', recentItems.slice(0,3).map(i=>i.title));
    if (relevantCurrencies.length > 0) {
      const biasHeadlines = recentItems.map((i,idx) => (idx+1) + '. ' + i.title).join('\n');
      const biasCurrencies = relevantCurrencies.join(', ');
      const biasPrompt = [
        'You are a central bank policy analyst. Based ONLY on the following recent financial news headlines, assess the current monetary policy stance for each central bank mentioned.',
        '',
        'Headlines:',
        biasHeadlines,
        '',
        'For each of these currencies that have relevant headlines: ' + biasCurrencies,
        '',
        'Return ONLY a valid JSON object. No explanation, no markdown, no code block. Just the raw JSON.',
        'Use ONLY these exact bias values: "Hawkish", "Cautious Hawkish", "Neutral", "Data Dependent", "On Hold", "Cautious Dovish", "Dovish", "Split"',
        'For confidence, use ONLY: "High", "Medium", "Low"',
        '  High = multiple clear, direct signals from officials or data',
        '  Medium = some signals but mixed or indirect',
        '  Low = minimal or ambiguous evidence',
        '',
        'Example format:',
        '{"USD":{"bias":"Cautious Hawkish","confidence":"High"},"EUR":{"bias":"Dovish","confidence":"Medium"}}',
        '',
        'Only include currencies where you have enough evidence from the headlines. If insufficient evidence for a currency, omit it.',
      ].join('\n');

      console.log('Starting Groq Call 2 for currencies:', relevantCurrencies);
      try {
        const biasRes = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [{ role: 'user', content: biasPrompt }],
            temperature: 0.1,
            max_tokens: 200,
          }),
          signal: AbortSignal.timeout(15000),
        });

        console.log('Groq Call 2 status:', biasRes.status);
        if (biasRes.ok) {
          const biasData = await biasRes.json();
          const rawBias = biasData?.choices?.[0]?.message?.content?.trim() || '';

          // Parse JSON — strip any accidental markdown
          const clean = rawBias.replace(/```json|```/g, '').trim();
          console.log('Groq bias raw:', rawBias.substring(0, 300));
          const parsed = JSON.parse(clean);
          console.log('Groq bias parsed:', JSON.stringify(parsed));

          const VALID_BIASES = ['Hawkish','Cautious Hawkish','Neutral','Data Dependent','On Hold','Cautious Dovish','Dovish','Split'];
          const VALID_CONFIDENCES = ['High','Medium','Low'];
          const VALID_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
          const now = new Date().toISOString();

          // Load existing bias from Redis
          let existing = {};
          try {
            const raw = await redisCmd('GET', 'cb_bias');
            if (raw) existing = JSON.parse(raw);
          } catch(e) {}

          // Merge new bias — only 8 major currencies
          console.log('Bias parsed entries:', JSON.stringify(Object.entries(parsed)));
          for (const [cur, entry] of Object.entries(parsed)) {
            const curOk = VALID_CURRENCIES.has(cur);
            // Support both new {bias, confidence} format and legacy string format
            const bias = (typeof entry === 'object' && entry !== null) ? entry.bias : entry;
            const confidence = (typeof entry === 'object' && entry !== null) ? entry.confidence : null;
            const biasOk = VALID_BIASES.includes(bias);
            const confidenceOk = VALID_CONFIDENCES.includes(confidence);
            console.log('Check', cur, bias, confidence, '→ cur:', curOk, 'bias:', biasOk, 'conf:', confidenceOk);
            if (curOk && biasOk) {
              existing[cur] = { bias, confidence: confidenceOk ? confidence : 'Low', updated_at: now };
              biasUpdated.push(cur);
            }
          }

          // Save back to Redis
          if (biasUpdated.length > 0) {
            try {
              console.log('Redis URL:', process.env.UPSTASH_REDIS_REST_URL ? process.env.UPSTASH_REDIS_REST_URL.substring(0,50) : 'NOT SET');
              console.log('Redis TOKEN:', process.env.UPSTASH_REDIS_REST_TOKEN ? 'SET (len=' + process.env.UPSTASH_REDIS_REST_TOKEN.length + ')' : 'NOT SET');
              const saveResult = await redisCmd('SET', 'cb_bias', JSON.stringify(existing));
              console.log('CB bias Redis SET result:', saveResult);
              if (saveResult === 'OK') {
                console.log('CB bias saved OK:', JSON.stringify(biasUpdated));
              } else {
                console.error('CB bias Redis SET unexpected result:', JSON.stringify(saveResult));
              }
            } catch(saveErr) {
              console.error('CB bias Redis save FAILED:', saveErr.message);
            }
          }
        }
      } catch(e) {
        console.warn('Bias assessment failed:', e.message);
      }
    }
  }

  // ── 7. Groq Call 3: Structured Trade Thesis ─────────────
  let thesis = null;
  if (GROQ_KEY && recentItems.length > 0 && article) {
    const cbSummary = biasUpdated.length > 0
      ? `CB biases just updated for: ${biasUpdated.join(', ')}`
      : 'CB biases unchanged this cycle';
    const thesisPrompt = [
      'You are a macro FX strategist. Based on the market context below, output a structured JSON trade thesis.',
      '',
      `Market briefing (current session): ${article.slice(0, 800)}`,
      '',
      cbSummary,
      '',
      'Return ONLY valid JSON with this exact schema (no markdown, no explanation):',
      '{',
      '  "dominant_regime": "risk_on" | "risk_off" | "neutral",',
      '  "strongest_currency": "USD",',
      '  "weakest_currency": "JPY",',
      '  "pair_recommendation": "USD/JPY",',
      '  "direction": "long" | "short" | "no_trade",',
      '  "confidence_1_to_5": 3,',
      '  "invalidation_condition": "string",',
      '  "time_horizon_days": 5,',
      '  "catalyst_dependency": "string"',
      '}',
      '',
      'Use only 8 major currencies: USD EUR GBP JPY CAD AUD NZD CHF.',
      'Set direction to "no_trade" and confidence to 1-2 if conviction is low.',
      'Only recommend a pair if CB bias divergence between the two currencies is at least 2 levels apart (e.g. Hawkish vs Dovish).',
    ].join('\n');

    let thesisRaw = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const thesisRes = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [{ role: 'user', content: thesisPrompt }],
            temperature: 0.1,
            max_tokens: 300,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (thesisRes.ok) {
          const td = await thesisRes.json();
          const raw = td?.choices?.[0]?.message?.content?.trim() || '';
          const clean = raw.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(clean);
          // Validate required fields
          const VALID_DIR = ['long', 'short', 'no_trade'];
          const VALID_REG = ['risk_on', 'risk_off', 'neutral'];
          const VALID_CURR = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
          if (
            VALID_REG.includes(parsed.dominant_regime) &&
            VALID_CURR.has(parsed.strongest_currency) &&
            VALID_CURR.has(parsed.weakest_currency) &&
            VALID_DIR.includes(parsed.direction) &&
            typeof parsed.confidence_1_to_5 === 'number'
          ) {
            thesisRaw = parsed;
            break;
          } else {
            console.warn('Thesis schema invalid on attempt', attempt + 1, JSON.stringify(parsed).slice(0, 200));
          }
        }
      } catch(e) {
        console.warn('Thesis Groq call attempt', attempt + 1, 'failed:', e.message);
      }
    }

    if (thesisRaw) {
      thesis = thesisRaw;
      try {
        await redisCmd('SET', 'latest_thesis', JSON.stringify(thesis), 'EX', 21600);
        console.log('Thesis saved to Redis');
      } catch(e) {
        console.warn('Thesis Redis save failed:', e.message);
      }
    } else {
      console.warn('Thesis generation failed after 2 attempts — null returned');
    }
  }

  return res.status(200).json({
    article, method, thesis,
    news_count:   recentItems.length,
    cal_count:    calEvents.length,
    bias_updated: biasUpdated,
    generated_at: new Date().toISOString(),
  });
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

function toDateStr(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

function parseRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title=get('title').replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), pubDate=get('pubDate'), link=b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid&&title) items.push({title,guid,pubDate,link});
  }
  return items;
}

function parseFFXML(xml) {
  const events = [], re = /<event>([\s\S]*?)<\/event>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r=new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block); if(!r)return''; return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim(); };
    const title=get('title'), country=get('country').toUpperCase(), date=get('date'), time=get('time'), impact=get('impact');
    if (!title||!country) continue;
    const dp=date.match(/(\d{2})-(\d{2})-(\d{4})/); if(!dp) continue;
    events.push({ date:`${dp[3]}-${dp[1]}-${dp[2]}`, time_wib:convertToWIB(time), currency:country, event:title, impact });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr||timeStr==='All Day'||timeStr==='Tentative') return 'Tentative';
  const m=timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i); if(!m) return timeStr;
  let hour=parseInt(m[1]); const min=parseInt(m[2]), ampm=m[3].toLowerCase();
  if(ampm==='pm'&&hour!==12)hour+=12; if(ampm==='am'&&hour===12)hour=0;
  return `${String((hour+7)%24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}

function detectCat(title) {
  const t=title.toLowerCase();
  const CATS = {
    'market-moving':['market moving','breaking','flash','urgent','alert','war','blockade'],
    'forex':['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','/usd','/eur','/gbp','/jpy','/cad','/chf','/aud','/nzd','fx options','dollar index','dxy','cable','loonie','aussie','kiwi','fiber'],
    'equities':['s&p','nasdaq','dow','ftse','dax','nikkei','hang seng','stock','equity','shares','earnings','nyse','spx'],
    'commodities':['gold','silver','copper','wheat','corn','xau','xag','commodity','zinc','nickel'],
    'energy':['oil','crude','brent','wti','opec','gasoline','diesel','natural gas','barrel','hormuz','iea','tanker','lng'],
    'bonds':['bond','yield','treasury','gilt','bund','10-year','2-year','30-year','bps','fixed income'],
    'crypto':['bitcoin','btc','ethereum','eth','crypto','blockchain','binance','stablecoin'],
    'indexes':['pmi','purchasing manager','composite index','manufacturing index'],
    'macro':['fed ','fomc','powell','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp','recession','imf'],
    'econ-data':['actual','forecast','previous','cpi','nfp','unemployment','retail sales','trade balance','payroll'],
    'geopolitical':['iran','iranian','nuclear','ceasefire','israel','russia','ukraine','china','chinese','taiwan','sanction','tariff','trump','nato','military'],
  };
  for (const [cat,kws] of Object.entries(CATS)) { if(kws.some(k=>t.includes(k)))return cat; }
  return 'macro';
}
