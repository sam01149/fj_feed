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

  // 3b. Load digest history
  let digestHistory = [];
  try {
    const rawHist = await redisCmd('GET', 'digest_history');
    if (rawHist) digestHistory = JSON.parse(rawHist);
  } catch(e) {}
  const historyBlock = digestHistory.length > 0
    ? digestHistory.map(h => `[${h.wib}] ${h.summary}`).join('\n')
    : '(Belum ada riwayat — ini sesi pertama)';

  // 4. Groq Call 1: market briefing
  let article = null, method = 'groq';
  if (GROQ_KEY && recentItems.length > 0) {
    const prompt = `Kamu adalah analis pasar keuangan senior yang menulis market briefing harian untuk trader forex Indonesia dengan gaya macro discretionary.

WAKTU SAAT INI: ${dateStr}, ${timeStr}

=== RIWAYAT BRIEFING SEBELUMNYA (konteks narasi, max 7 sesi) ===
${historyBlock}

=== HEADLINE BERITA TERKINI (${recentItems.length} berita, 6 jam terakhir) ===
${headlinesBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

TUGAS:
Tulis market briefing komprehensif untuk trader profesional. Tidak ada batasan jumlah paragraf — tulis sepanjang yang diperlukan agar semua informasi relevan tersampaikan. Bisa lebih atau kurang dari 3 paragraf tergantung kompleksitas situasi pasar saat ini.

Cakup semua tema berikut yang relevan berdasarkan data di atas (lewati jika tidak ada data yang relevan):

Kondisi pasar dan narrative macro dominan — apa yang sedang terjadi, mengapa penting, dan bagaimana korelasinya antar aset. Jika ada pergeseran tema atau sentimen dibanding riwayat sebelumnya, sebutkan secara eksplisit.

Dampak per currency dan pair — untuk setiap currency atau pair yang terdampak oleh headline, jelaskan arah tekanan, sentimen pasar terhadap CB terkait, dan potensi pergerakan. Sebutkan pair spesifik (EUR/USD, USD/JPY, GBP/USD, dll) kalau relevan.

Konteks kalender — event high-impact paling krusial dalam 3 hari ke depan beserta waktu WIB-nya. Apakah event tersebut mengkonfirmasi atau mengontradiksi kondisi pasar saat ini, dan implikasinya untuk timing entry/exit.

Risiko dan divergensi — jika ada geopolitical risk, divergensi kebijakan antar CB, atau kondisi pasar yang memerlukan kehati-hatian ekstra sebelum mengambil posisi.

FORMAT:
- Paragraf naratif mengalir tanpa bullet list, tanpa heading, tanpa label section, tanpa emoji, tanpa bold/italic
- Kalimat aktif dan langsung ke poin
- Seluruh output dalam Bahasa Indonesia
- Tidak ada kalimat pembuka seperti "Berikut adalah..." atau penutup seperti "Demikian briefing..."

Balas hanya dengan briefing tersebut.`;

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
        '',
        'Example format:',
        '{"USD":"Cautious Hawkish","EUR":"Dovish"}',
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
          for (const [cur, bias] of Object.entries(parsed)) {
            const curOk = VALID_CURRENCIES.has(cur);
            const biasOk = VALID_BIASES.includes(bias);
            console.log('Check', cur, bias, '→ cur:', curOk, 'bias:', biasOk);
            if (curOk && biasOk) {
              existing[cur] = { bias, updated_at: now };
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
