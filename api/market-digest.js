// api/unified-digest.js
const rateLimit = require('./_ratelimit');
const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
const GOLD_KEYWORDS = [
  // Direct gold references
  'gold','xau','bullion','spot gold','precious metal','gold price','gold demand','gold rally','gold drop',
  // Real yield / USD channel (gold's #1 driver)
  'real yield','tips yield','breakeven','inflation expect','10y yield','10-year yield','treasury yield','us yield','yield curve',
  'dxy','dollar index',
  // Fed / FOMC — USD fundamentals that directly drive XAU via rate/real yield channel
  'powell','fomc','federal reserve','fed rate','fed minutes','fed pivot','rate cut','rate hike',
  'us cpi','us inflation','nonfarm','nfp','us gdp','us jobs','us unemployment',
  // ETF / flow
  'gld','gold etf','etf flow','bullion etf','central bank buy','central bank gold','gold reserve',
  // Safe haven — gold-specific phrasing only
  'safe haven','haven demand','flight to safety','flight to gold',
  // Geopolitical — only phrasing explicitly tied to haven/gold impact
  'middle east tension','iran nuclear','russia ukraine','ukraine war','gold safe',
  // Risk sentiment — equities as risk-off/on proxy for haven demand
  'risk aversion','risk-off','risk off','risk-on','risk on',
  'vix spike','vix surge','equity sell-off','stock market crash','market rout','flight to bonds',
  // Geopolitical — broader triggers with clear haven implication
  'trade war','us china tariff','sanction escalat','nuclear threat','conflict escalat',
  // Dollar moves (non-DXY phrasing)
  'dollar rally','dollar drop','dollar strengthen','dollar weaken','usd rally','usd drop',
  // Precious metals family — comex is gold's primary venue
  'comex','silver price','silver rally','silver drop',
];


module.exports = async function handler(req, res) {
  console.log('market-digest v2 START', new Date().toISOString());
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Cached mode — serve last saved digest from Redis, no Groq calls
  if (req.query?.mode === 'cached') {
    try {
      const raw = await redisCmd('GET', 'latest_article');
      if (raw) return res.status(200).json({ ...JSON.parse(raw), from_cache: true });
    } catch(e) { console.warn('cached mode Redis read failed:', e.message); }
    return res.status(200).json({ from_cache: true, article: null });
  }

  // 3 Groq calls per request — rate limit to 4 req/min per IP
  if (await rateLimit(req, res, { limit: 4, windowSecs: 60, endpoint: 'market-digest' })) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('x-vercel-cache', 'BYPASS');
  const GROQ_KEY = process.env.GROQ_API_KEY;

  // 1. RSS — current feed + 36h Redis history in parallel
  let rssItems = [];
  try {
    const host = req.headers.host || 'financial-feed-app.vercel.app';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const cutoff36h = Date.now() - 36 * 60 * 60 * 1000;
    const histTimeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    const [rssRes, histRaw] = await Promise.allSettled([
      fetch(`${proto}://${host}/api/feeds?type=rss`, { signal: AbortSignal.timeout(12000) }),
      Promise.race([redisCmd('ZRANGEBYSCORE', 'news_history', cutoff36h, '+inf'), histTimeout]),
    ]);

    let currentItems = [];
    if (rssRes.status === 'fulfilled' && rssRes.value.ok) {
      const xml = await rssRes.value.text();
      if (xml.includes('<rss')) currentItems = parseRSS(xml);
    }

    let historyItems = [];
    if (histRaw.status === 'fulfilled' && Array.isArray(histRaw.value)) {
      historyItems = histRaw.value.map(s => { try { return JSON.parse(s); } catch(_) { return null; } }).filter(Boolean);
    }

    // Merge: current RSS takes priority, dedup by guid
    const seen = new Set(currentItems.map(i => i.guid));
    const merged = [...currentItems, ...historyItems.filter(i => i.guid && !seen.has(i.guid))];
    rssItems = merged
      .filter(i => new Date(i.pubDate).getTime() > cutoff36h)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    console.log(`RSS items: ${currentItems.length} current + ${historyItems.length} history → ${rssItems.length} merged`);
  } catch(e) {
    console.warn('RSS/history fetch failed:', e.message);
  }

  const recentItems = rssItems.slice(0, 150);

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
  const DAYS_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const dayStr  = DAYS_ID[wibNow.getUTCDay()];
  const isMonEarly = wibNow.getUTCDay() === 1 && wibNow.getUTCHours() < 15;
  const weekendNote = isMonEarly ? '\nCATATAN KONTEKS: Ini Senin pagi — bagian "12-36 jam lalu" mencakup weekend, volume berita tipis, tidak market-moving.' : '';
  const headlinesForBriefing = recentItems.slice(0, 80);
  const headlinesBlock = headlinesForBriefing.length > 0 ? headlinesForBriefing.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n') : '(Tidak ada headline)';
  const calBlock = calEvents.length > 0 ? calEvents.map(e=>`- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}`).join('\n') : '(Tidak ada event high-impact)';

  // Gold-specific headline filter — split recent vs historical so Groq weights correctly
  const cutoff12h = Date.now() - 12 * 60 * 60 * 1000;
  const isGold = i => GOLD_KEYWORDS.some(kw => i.title.toLowerCase().includes(kw));
  const goldRecent = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() > cutoff12h).slice(0, 20);
  const goldOlder  = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() <= cutoff12h).slice(0, 15);
  const goldItems  = [...goldRecent, ...goldOlder];
  const goldBlock  = [
    goldRecent.length > 0
      ? `[12 JAM TERAKHIR — ${goldRecent.length} berita]\n${goldRecent.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '[12 JAM TERAKHIR] (tidak ada)',
    goldOlder.length > 0
      ? `\n[KONTEKS HISTORIS 12-36 JAM LALU — ${goldOlder.length} berita]\n${goldOlder.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '\n[KONTEKS HISTORIS 12-36 JAM LALU] (tidak ada)',
  ].join('');

  // 3b. Load digest history + xau history in parallel
  let digestHistory = [], xauHistory = [];
  try {
    const [rawHist, rawXauHist] = await Promise.all([
      redisCmd('LRANGE', 'digest_history', 0, 6),
      redisCmd('LRANGE', 'xau_history', 0, 3),
    ]);
    if (Array.isArray(rawHist)) digestHistory = rawHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (Array.isArray(rawXauHist)) xauHistory = rawXauHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
  } catch(e) {}
  const historyBlock = digestHistory.length > 0
    ? digestHistory.map(h => `[${h.wib}] ${h.summary}`).join('\n')
    : '(Belum ada riwayat — ini sesi pertama)';
  const xauHistoryBlock = xauHistory.length > 0
    ? xauHistory.map(h => `[${h.wib}] ${h.xau_summary}`).join('\n')
    : '(Belum ada riwayat XAU — ini sesi pertama)';

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
    const DIGEST_INSTR_DEFAULT = `Kamu analis macro FX senior. Pembaca: trader Indonesia, macro discretionary, sudah bisa baca chart, sudah tahu definisi dasar (DXY, real yield, carry, risk-on/off, basis point). Jangan jelaskan istilah. Jangan kontekstualisasi level beginner.

TUGAS: Briefing pre-session dari headlines + kalender. Output Bahasa Indonesia, prosa mengalir, tanpa heading/bullet/bold/emoji, kecuali satu marker "XAUUSD:" yang dijelaskan di bawah.

METODE — untuk setiap tema yang dibahas:
1. Klaim spesifik: angka, nama pejabat, atau pair yang disebut di headline. Jika tidak ada angka/nama spesifik di headline, JANGAN tulis tema itu — skip.
2. Mekanisme: jalur transmisi konkret ke FX (rate differential, real yield gap, risk channel, flow). Bukan "berdampak ke pair X" — sebutkan VIA APA.
3. Arah dan magnitude: bias atas atau bawah, dan apakah signal kuat atau marginal. Marginal harus disebut marginal.
4. Konflik: kalau dalam tema yang sama ada signal berlawanan, sebut keduanya, lalu putuskan mana yang lebih berat dan kenapa.

KALENDER:
Hanya event yang reaksinya bisa diantisipasi (consensus jelas, atau setup binary). Sebut waktu WIB. Untuk masing-masing: skenario beat vs miss dan pair mana yang paling sensitif. Skip event tanpa edge antisipatif. Jika tidak ada event dengan edge antisipatif dalam 3 hari ke depan, nyatakan begitu.

PEJABAT CENTRAL BANK:
Hanya analisa kalau statement-nya menyentuh rate path, balance sheet, atau inflation framework. Statement non-policy (regulasi, teknologi, soal politik) — sebut sekali sebagai "tidak ada sinyal kebijakan dari [nama] hari ini" lalu lanjut, jangan dibahas panjang.

CONTINUITY DENGAN SESI SEBELUMNYA:
Ringkasan sesi sebelumnya disediakan di bawah. WAJIB sebut: apa yang BERUBAH (data baru, statement baru, headline baru) dan apa yang TETAP (narrative belum bergeser). Kalau tidak ada perubahan material, nyatakan begitu — itu informasi. Kalau ini sesi pertama (tidak ada histori), lewati bagian ini.

PENUTUP:
Satu kalimat: dari semua yang di atas, currency mana yang paling terkonfirmasi kuat dan mana paling terkonfirmasi lemah untuk sesi ini. Bukan "pasar volatile" — nama currency.

XAUUSD (ANALISIS FUNDAMENTAL — TANPA DATA HARGA LIVE):
Setelah penutup, tambahkan paragraf terpisah diawali tepat dengan "XAUUSD:" (tanpa spasi sebelum titik dua). Paragraf ini dibaca berdiri sendiri oleh trader gold.

PENTING: Kamu tidak memiliki data harga live XAU/USD, level chart, atau posisi pasar saat ini. Semua arah yang kamu sebut adalah tekanan fundamental dari berita — bukan prediksi harga. Jangan sebut angka harga XAU kecuali ada di headline.

Gunakan HANYA headline dari blok "HEADLINE RELEVAN XAUUSD" yang disediakan terpisah di bawah. Jika blok itu berisi kurang dari 3 headline substantif, nyatakan "sinyal gold tipis hari ini" di kalimat pertama, lalu persingkat — jangan paksa analisis dari data yang tidak ada.

CONTINUITY XAUUSD: Gunakan blok "RIWAYAT XAUUSD SESI SEBELUMNYA" untuk menyebut apa yang BERUBAH pada driver gold (driver baru, pergeseran channel dominan) dan apa yang TETAP. Jika driver hari ini sama persis dengan sesi sebelumnya, nyatakan "driver tidak berubah dari sesi sebelumnya" — itu informasi valid, bukan kelemahan.

Struktur analisis (prosa mengalir, tanpa bullet, tanpa heading):
1. DRIVER DOMINAN: Dari tiga channel — (a) USD/real yields, (b) safe haven/geopolitik, (c) risk sentiment ekuitas — tentukan SATU yang paling banyak didukung headline hari ini. Wajib sebut angka atau nama event konkret dari headline sebagai bukti. Jika dua channel saling berlawanan (contoh: DXY menguat TAPI geopolitik memanas), sebut konflik ini secara eksplisit, putuskan mana yang lebih dominan, dan jelaskan alasannya dalam satu kalimat.
2. TEKANAN FUNDAMENTAL: Berdasarkan driver di atas, arah tekanan XAU/USD dalam beberapa jam ke depan — bullish pressure, bearish pressure, atau conflicting. "Conflicting" boleh dipakai HANYA jika dua channel berlawanan dan tidak ada yang jelas lebih berat.
3. TRIGGER TERDEKAT: Satu event dari kalender atau headline dalam 24 jam ke depan yang paling berpotensi menggerakkan XAU secara signifikan. Sebut waktu WIB, nama event, dan skenario spesifik yang akan memicu pergerakan (bukan sekadar nama event-nya).

ATURAN HIGIENIS:
- Dilarang: kalimat yang masih benar kalau headlines diganti dengan headlines hari lain. Tes: apakah kalimat ini bisa ditulis tanpa membaca block headlines? Kalau ya, hapus.
- Dilarang: hedging tanpa angka ("perlu dicermati", "patut diwaspadai", "tergantung data", "masih akan volatile", "menjadi fokus", "trader harus berhati-hati", "sentimen mixed").
- Dilarang: rekomendasi entry/SL/TP. Ini briefing konteks, bukan signal.
- Kalau headlines miskin (kurang dari 5 yang substantif), nyatakan langsung di kalimat pembuka bahwa flow berita tipis dan briefing dipersingkat. Jangan paksa panjang.`;

    const digestInstr = promptDigestInstr || DIGEST_INSTR_DEFAULT;
    const prompt = `${digestInstr}

WAKTU SAAT INI: ${dayStr}, ${dateStr}, ${timeStr}${weekendNote}

=== HEADLINE BERITA TERKINI (${headlinesForBriefing.length} dari ${recentItems.length} berita, 36 jam terakhir) ===
${headlinesBlock}

=== HEADLINE RELEVAN XAUUSD (${goldItems.length} dari ${recentItems.length} berita, 36 jam, difilter) ===
${goldBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
${calBlock}

=== RINGKASAN SESI SEBELUMNYA (FX) ===
${historyBlock}

=== RIWAYAT XAUUSD SESI SEBELUMNYA (4 sesi terakhir) ===
${xauHistoryBlock}`;

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
      article = 'Tidak ada berita baru dalam 36 jam terakhir.';
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

  // ── 5b. Save digest + xau history (parallel) ──
  if (article && method === 'groq') {
    try {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const wibStr = `${String(wibNow.getUTCDate()).padStart(2,'0')} ${MONTHS[wibNow.getUTCMonth()]} ${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

      // FX digest history — first 700 chars (FX section)
      const xauIdx = article.indexOf('XAUUSD:');
      const fxSummary = (xauIdx > 0 ? article.slice(0, xauIdx) : article).replace(/\n/g, ' ').slice(0, 700);
      const fxEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, summary: fxSummary });

      // XAU-specific history — extract XAUUSD paragraph only
      const xauParagraph = xauIdx !== -1 ? article.slice(xauIdx, xauIdx + 600).replace(/\n/g, ' ') : null;
      const saves = [
        redisCmd('LPUSH', 'digest_history', fxEntry).then(() => redisCmd('LTRIM', 'digest_history', 0, 6)),
      ];
      if (xauParagraph) {
        const xauEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, xau_summary: xauParagraph });
        saves.push(redisCmd('LPUSH', 'xau_history', xauEntry).then(() => redisCmd('LTRIM', 'xau_history', 0, 3)));
      }
      await Promise.all(saves);
      console.log('Digest + XAU history saved');
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
      const relevantHeadlines = recentItems.filter(i => {
        const lower = i.title.toLowerCase();
        return relevantCurrencies.some(cur => CB_KEYWORDS[cur].some(kw => lower.includes(kw)));
      });
      const biasHeadlines = relevantHeadlines.slice(0, 50).map((i,idx) => (idx+1) + '. ' + i.title).join('\n');
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
            max_tokens: 400,
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
    // Extract XAUUSD section from article to ensure thesis AI sees it (it's near the end)
    const xauSectionMatch = article.indexOf('XAUUSD:');
    const xauSection = xauSectionMatch !== -1 ? article.slice(xauSectionMatch, xauSectionMatch + 700) : '';
    const briefingForThesis = article.slice(0, 900) + (xauSection && xauSectionMatch > 900 ? '\n\n' + xauSection : '');
    const goldHeadlinesForThesis = goldItems.slice(0, 15).map((i, idx) => `${idx + 1}. ${i.title}`).join('\n') || '(none)';

    const thesisPrompt = [
      'You are a macro FX and gold strategist. Based on the market context below, output a structured JSON with both an FX trade thesis and an XAU/USD fundamental thesis.',
      '',
      `Market briefing (current session): ${briefingForThesis}`,
      '',
      cbSummary,
      '',
      `Upcoming high-impact calendar events (next 3 days, WIB): ${calBlock}`,
      '',
      `Gold-relevant headlines: ${goldHeadlinesForThesis}`,
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
      '  "catalyst_dependency": "string",',
      '  "xau_bias": "bullish" | "bearish" | "neutral" | "conflicting",',
      '  "xau_dominant_driver": "real_yield" | "safe_haven" | "risk_sentiment" | "usd_strength" | "insufficient_data",',
      '  "xau_driver_evidence": "string — specific data point or event from headlines",',
      '  "xau_key_trigger": "string — event name + WIB time + specific spike scenario, or \'No clear trigger in 24h\' if none",',
      '  "xau_confidence": 3',
      '}',
      '',
      'FX rules:',
      'Use only 8 major currencies: USD EUR GBP JPY CAD AUD NZD CHF.',
      'Set direction to "no_trade" and confidence to 1-2 if conviction is low.',
      'Only recommend a pair if CB bias divergence between the two currencies is at least 2 levels apart (e.g. Hawkish vs Dovish).',
      'Use the calendar events to inform invalidation_condition — if a high-impact event for one of the pair currencies is scheduled within time_horizon_days, name it as the primary invalidation trigger.',
      '',
      'XAU rules:',
      'xau_bias must be based on fundamental pressure from headlines, NOT price prediction.',
      'xau_driver_evidence must cite a specific number, official name, or event from the gold headlines — not a generic statement.',
      'If gold headlines are sparse (fewer than 3 substantive), set xau_dominant_driver to "insufficient_data" and xau_confidence to 1.',
      'xau_key_trigger must include WIB time if available from calendar, otherwise note "time TBD".',
      'xau_confidence: 1-5 where 5 = multiple converging headlines with clear direction.',
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
            max_tokens: 500,
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
          const VALID_XAU_BIAS = ['bullish', 'bearish', 'neutral', 'conflicting'];
          const VALID_XAU_DRIVER = ['real_yield', 'safe_haven', 'risk_sentiment', 'usd_strength', 'insufficient_data'];
          if (
            VALID_REG.includes(parsed.dominant_regime) &&
            VALID_CURR.has(parsed.strongest_currency) &&
            VALID_CURR.has(parsed.weakest_currency) &&
            VALID_DIR.includes(parsed.direction) &&
            typeof parsed.confidence_1_to_5 === 'number' &&
            parsed.confidence_1_to_5 >= 1 && parsed.confidence_1_to_5 <= 5 &&
            VALID_XAU_BIAS.includes(parsed.xau_bias) &&
            VALID_XAU_DRIVER.includes(parsed.xau_dominant_driver)
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

  const payload = {
    article, method, thesis,
    news_count:   recentItems.length,
    gold_count:   goldItems.length,
    cal_count:    calEvents.length,
    bias_updated: biasUpdated,
    generated_at: new Date().toISOString(),
  };

  // Persist full payload to Redis so cached mode and page refreshes work
  if (article && method === 'groq') {
    redisCmd('SET', 'latest_article', JSON.stringify(payload), 'EX', 21600).catch(() => {});
  }

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
