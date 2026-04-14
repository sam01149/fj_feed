const RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const GEMINI_MODEL = 'gemini-2.0-flash';

const SESSION_LABELS = {
  morning:   { id: 'Sesi Asia',      en: 'Asia Session'      },
  afternoon: { id: 'Sesi London',    en: 'London Session'    },
  evening:   { id: 'Sesi New York',  en: 'New York Session'  },
};

exports.handler = async function(event, context) {
  const params = event.queryStringParameters || {};
  const session = params.session || 'morning';
  const label = SESSION_LABELS[session] || SESSION_LABELS.morning;

  let xml = null;
  try {
    const res = await fetch(RSS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) xml = await res.text();
  } catch(e) {}

  if (!xml) {
    return { statusCode: 503, body: JSON.stringify({ error: 'RSS fetch failed' }) };
  }

  const items = parseRSS(xml);
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  const recent = items.filter(i => new Date(i.pubDate).getTime() > cutoff).slice(0, 80);

  if (recent.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        session, label, method: 'empty',
        summary_id: 'Tidak ada berita baru dalam 6 jam terakhir.',
        summary_en: 'No new headlines in the past 6 hours.',
        items: [], generated_at: new Date().toISOString(),
      }),
    };
  }

  const headlines = recent.map((i, idx) => `${idx + 1}. ${i.title}`).join('\n');
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  let summary_id = null;
  let summary_en = null;
  let method = 'gemini';

  if (GEMINI_KEY) {
    try {
      const prompt = `Kamu adalah analis pasar keuangan senior yang menulis untuk trader forex dan komoditas Indonesia.

Berikut ${recent.length} headline berita keuangan terbaru menjelang ${label.id}:

${headlines}

TUGAS:
Tulis SATU PARAGRAF ringkasan dalam Bahasa Indonesia yang baik dan benar (3-4 kalimat padat). Fokus pada: tema dominan pasar, berita paling berpengaruh terhadap pergerakan harga, dan implikasi singkat bagi trader. Gunakan kalimat aktif, langsung ke poin, tanpa bullet list, tanpa heading, tanpa emoji.

WAJIB: Seluruh output hanya dalam Bahasa Indonesia. Tidak boleh ada kata atau frasa bahasa Inggris.

Balas hanya dengan paragraf tersebut, tidak ada teks lain.`;

      const gemRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
          }),
          signal: AbortSignal.timeout(20000),
        }
      );

      if (gemRes.ok) {
        const gemData = await gemRes.json();
        const raw = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        summary_id = raw.trim();
        // English version — second call
        const promptEn = `You are a senior financial market analyst writing for forex and commodity traders.

Here are ${recent.length} recent financial headlines ahead of the ${label.en}:

${headlines}

TASK:
Write ONE paragraph summary in English (3-4 concise sentences). Focus on: dominant market themes, most price-moving news, brief implication for traders. Use active voice, direct to the point, no bullet points, no headings, no emoji.

Reply with only the paragraph, nothing else.`;

        const gemRes2 = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptEn }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
            }),
            signal: AbortSignal.timeout(20000),
          }
        );
        if (gemRes2.ok) {
          const gemData2 = await gemRes2.json();
          summary_en = gemData2?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
        }
      }
    } catch(e) {
      console.warn('Gemini failed:', e.message);
      method = 'fallback';
    }
  } else {
    method = 'fallback';
  }

  // Fallback: auto-digest as paragraph
  if (!summary_id || !summary_en) {
    method = 'fallback';
    const catGroups = {};
    recent.forEach(i => {
      const cat = detectCat(i.title);
      if (!catGroups[cat]) catGroups[cat] = [];
      catGroups[cat].push(i.title);
    });

    const priority = ['market-moving','macro','energy','geopolitical','forex','econ-data','equities','commodities','bonds'];
    const parts_id = [];
    const parts_en = [];

    const CAT_ID = {
      'market-moving':'Penggerak utama pasar','macro':'Dari sisi kebijakan moneter',
      'energy':'Di sektor energi','geopolitical':'Dari sisi geopolitik',
      'forex':'Pada pasar valuta asing','econ-data':'Data ekonomi menunjukkan',
      'equities':'Pasar saham','commodities':'Komoditas','bonds':'Obligasi',
    };
    const CAT_EN = {
      'market-moving':'Key market mover','macro':'On monetary policy',
      'energy':'In energy markets','geopolitical':'On the geopolitical front',
      'forex':'In FX markets','econ-data':'Economic data shows',
      'equities':'Equity markets','commodities':'Commodities','bonds':'Bonds',
    };

    for (const cat of priority) {
      if (catGroups[cat]?.length > 0 && parts_id.length < 3) {
        const top = catGroups[cat][0];
        parts_id.push(`${CAT_ID[cat] || cat}, ${top.toLowerCase()}.`);
        parts_en.push(`${CAT_EN[cat] || cat}: ${top}.`);
      }
    }

    summary_id = `Ringkasan ${label.id}: ` + parts_id.join(' ');
    summary_en = `${label.en} Digest: ` + parts_en.join(' ');
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({
      session, label, method,
      summary_id, summary_en,
      count: recent.length,
      items: recent.slice(0, 10),
      generated_at: new Date().toISOString(),
    }),
  };
};

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = (tag) => {
      const r1 = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);
      const r2 = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
      return (r1 || r2)?.[1]?.trim() || '';
    };
    const title = get('title').replace(/^FinancialJuice:\s*/i, '').trim();
    const guid  = get('guid');
    const pubDate = get('pubDate');
    const link  = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
    if (guid && title) items.push({ title, guid, pubDate, link });
  }
  return items;
}

function detectCat(title) {
  const t = title.toLowerCase();
  const CATS = {
    'market-moving': ['market moving','breaking','flash','urgent','alert','war','blockade'],
    'forex':    ['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','cnh/','/usd','/eur','/gbp','/jpy','/cad','/chf','/aud','/nzd','fx options','options expir','dollar index','dxy','cable','loonie','aussie','kiwi','swissy','fiber'],
    'equities': ['s&p','nasdaq','dow','ftse','dax','nikkei','hang seng','stock','equity','shares','earnings','nyse','spx','nvda','apple','tesla'],
    'commodities':['gold','silver','copper','wheat','corn','xau','xag','commodity','zinc','nickel','alumin'],
    'energy':   ['oil','crude','brent','wti','opec','gasoline','diesel','natural gas','barrel','petroleum','hormuz','iea','tanker','lng'],
    'bonds':    ['bond','yield','treasury','gilt','bund','10-year','2-year','30-year','bps','fixed income'],
    'crypto':   ['bitcoin','btc','ethereum','eth','crypto','blockchain','binance','stablecoin'],
    'indexes':  ['pmi','purchasing manager','composite index','manufacturing index','services index'],
    'macro':    ['fed ','fomc','powell','goolsbee','waller','federal reserve','rate cut','rate hike','ecb','boe','boj','pboc','central bank','gdp','recession','imf'],
    'econ-data':['actual','forecast','previous','cpi','nfp','unemployment','retail sales','trade balance','consumer confidence','payroll','westpac','sentiment'],
    'geopolitical':['iran','iranian','tehran','nuclear','ceasefire','hezbollah','israel','russia','ukraine','china','chinese','xi jinping','taiwan','north korea','sanction','tariff','trump','nato','military'],
  };
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'macro';
}
