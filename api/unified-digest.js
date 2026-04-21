// api/unified-digest.js
const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  const GROQ_KEY = process.env.GROQ_API_KEY;

  // 1. RSS — try multiple user agents, Vercel egress can be blocked by FJ
  let rssItems = [];
  const RSS_UAS = [
    'Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'NewsBlur Feed Fetcher - 1000000 subscribers',
  ];
  for (const ua of RSS_UAS) {
    try {
      const r = await fetch(RSS_URL, {
        headers: { 'User-Agent': ua, 'Referer': 'https://www.financialjuice.com/', 'Accept': 'application/rss+xml, application/xml, */*' },
        signal: AbortSignal.timeout(12000),
      });
      if (r.ok) {
        const xml = await r.text();
        if (xml.includes('<rss')) { rssItems = parseRSS(xml); break; }
      }
    } catch(e) { console.warn('RSS attempt failed:', e.message); }
  }

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
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

  // 4. Gemini
  let article = null, method = 'groq';
  if (GROQ_KEY && recentItems.length > 0) {
    const prompt = `Kamu adalah analis pasar keuangan senior yang menulis untuk trader forex Indonesia dengan gaya trading macro discretionary.

WAKTU SAAT INI: ${dateStr}, ${timeStr}

=== HEADLINE BERITA TERKINI (${recentItems.length} berita, 6 jam terakhir) ===
${headlinesBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

TUGAS:
Tulis analisis pasar dalam TIGA PARAGRAF terpisah dengan baris kosong di antara paragraf.

Paragraf 1 — KONDISI PASAR: Tema dominan dan berita paling signifikan dari headlines di atas. Apa yang sedang terjadi di pasar saat ini. Kalimat faktual, langsung.

Paragraf 2 — DAMPAK CURRENCY: Dampak terhadap pair utama yang terdampak (sebutkan pair spesifik seperti EUR/USD, USD/JPY, dll jika relevan). Jelaskan arah tekanan dan potensi pergerakan berdasarkan berita yang ada.

Paragraf 3 — KONTEKS KALENDER: Berdasarkan event high-impact yang akan datang, mana yang paling berpotensi menggerakkan pasar? Berikan konteks singkat apakah event tersebut mengkonfirmasi atau mengontradiksi kondisi pasar saat ini. Sertakan waktu WIB-nya.

FORMAT WAJIB:
- Tiga paragraf terpisah dengan baris kosong di antara
- Tidak ada bullet list, tidak ada heading, tidak ada emoji, tidak ada bold
- Kalimat aktif, langsung ke poin
- Maksimal 3 paragraf, tidak lebih
- Seluruh output hanya dalam Bahasa Indonesia

Balas hanya dengan tiga paragraf tersebut, tidak ada teks lain.`;

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
          max_tokens: 800,
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
      article = 'Tidak ada berita baru dalam 6 jam terakhir.';
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
        '',
        'Example format:',
        '{"USD":"Cautious Hawkish","EUR":"Dovish"}',
        '',
        'Only include currencies where you have enough evidence from the headlines. If insufficient evidence for a currency, omit it.',
      ].join('\n');

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

        if (biasRes.ok) {
          const biasData = await biasRes.json();
          const rawBias = biasData?.choices?.[0]?.message?.content?.trim() || '';

          // Parse JSON — strip any accidental markdown
          const clean = rawBias.replace(/```json|```/g, '').trim();
          console.log('Groq bias raw:', rawBias.substring(0, 300));
          const parsed = JSON.parse(clean);
          console.log('Groq bias parsed:', JSON.stringify(parsed));

          const VALID_BIASES = ['Hawkish','Cautious Hawkish','Neutral','Data Dependent','On Hold','Cautious Dovish','Dovish','Split'];
          const VALID_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
          const now = new Date().toISOString();

          // Load existing bias from Redis
          let existing = {};
          try {
            const raw = await redisCmd('GET', 'cb_bias');
            if (raw) existing = JSON.parse(raw);
          } catch(e) {}

          // Merge new bias — only 8 major currencies
          for (const [cur, bias] of Object.entries(parsed)) {
            if (VALID_CURRENCIES.has(cur) && VALID_BIASES.includes(bias)) {
              existing[cur] = { bias, updated_at: now };
              biasUpdated.push(cur);
            }
          }

          // Save back to Redis
          if (biasUpdated.length > 0) {
            try {
              const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
              const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
              console.log('Redis URL:', REDIS_URL ? REDIS_URL.substring(0,40) : 'NOT SET');
              const saveRes = await fetch(REDIS_URL, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify(['SET', 'cb_bias', JSON.stringify(existing)]),
                signal: AbortSignal.timeout(8000),
              });
              const saveData = await saveRes.json();
              console.log('CB bias Redis save result:', JSON.stringify(saveData));
              console.log('CB bias saved:', JSON.stringify(biasUpdated));
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

  return res.status(200).json({
    article, method,
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
  const isDST=(new Date().getUTCMonth()+1)>=3&&(new Date().getUTCMonth()+1)<=10;
  return `${String((hour+(isDST?11:12))%24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
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
