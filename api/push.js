// api/push.js
// Dipanggil oleh cron-job.org setiap 2 menit
// Header wajib: x-cron-secret: <CRON_SECRET>

const webpush = require('web-push');

const RSS_URL       = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fjfeed.app';
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET   = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (CRON_SECRET && req.headers['x-cron-secret'] !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !REDIS_URL) {
    return res.status(200).json({ status: 'Not configured' });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  let seenGuids = new Set();
  try { const raw = await redisCmd('GET','seen_guids'); if(raw) seenGuids = new Set(JSON.parse(raw)); } catch(e) {}

  let xml = null;
  try {
    const cached = await redisCmd('GET','rss_cache');
    if (cached) { const p=JSON.parse(cached); if(Date.now()-p.fetchedAt<55000) xml=p.xml; }
  } catch(e) {}

  if (!xml) {
    try {
      const r = await fetch(RSS_URL, { headers: { 'User-Agent': 'Feedly/1.0 (+http://www.feedly.com/fetcher.html)', 'Referer': 'https://www.financialjuice.com/' }, signal: AbortSignal.timeout(12000) });
      if (r.ok) { xml = await r.text(); await redisCmd('SET','rss_cache',JSON.stringify({xml,fetchedAt:Date.now()}),'EX',120); }
    } catch(e) { return res.status(200).json({ status: 'RSS unavailable' }); }
  }

  if (!xml) return res.status(200).json({ status: 'No RSS' });

  const items = parseRSS(xml);
  const isFirst = seenGuids.size === 0;
  const newItems = isFirst ? [] : items.filter(i => !seenGuids.has(i.guid));

  items.forEach(i => seenGuids.add(i.guid));
  try { await redisCmd('SET','seen_guids',JSON.stringify([...seenGuids].slice(-500)),'EX',86400); } catch(e) {}

  if (newItems.length === 0) return res.status(200).json({ status: isFirst ? 'Initialized' : 'No new items' });

  await sendTelegram(newItems);

  let subs = [];
  try {
    const raw = await redisCmd('HGETALL','push_subs');
    if (raw && Array.isArray(raw)) { for (let i=1;i<raw.length;i+=2) { try { subs.push(JSON.parse(raw[i])); } catch(e) {} } }
  } catch(e) {}

  if (subs.length > 0) {
    const EMOJI = { 'market-moving':'🔴','forex':'💱','energy':'⚡','macro':'🏦','geopolitical':'🌐','econ-data':'📋','news':'📰' };
    const cat = detectCat(newItems[0].title);
    const payload = JSON.stringify({
      title: newItems.length===1 ? `${EMOJI[cat]||'📰'} FJFeed` : `📰 FJFeed — ${newItems.length} berita baru`,
      body:  newItems.length===1 ? newItems[0].title : newItems.slice(0,2).map(i=>`• ${i.title}`).join('\n'),
      url:   newItems[0]?.link || '/',
      icon:  '/icon-192.png',
    });
    const staleKeys = [];
    await Promise.allSettled(subs.map(async sub => {
      try { await webpush.sendNotification(sub, payload); }
      catch(e) { if(e.statusCode===410||e.statusCode===404) staleKeys.push(Buffer.from(sub.endpoint).toString('base64').slice(0,80)); }
    }));
    if (staleKeys.length > 0) await redisCmd('HDEL','push_subs',...staleKeys);
  }

  return res.status(200).json({ status: 'OK', new_items: newItems.length, subscribers: subs.length });
};

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, { method:'POST', headers:{'Authorization':`Bearer ${REDIS_TOKEN}`,'Content-Type':'application/json'}, body:JSON.stringify(args), signal:AbortSignal.timeout(8000) });
  return (await res.json()).result;
}

async function sendTelegram(newItems) {
  if (!TG_TOKEN||!TG_CHAT_ID) return;
  const EMOJI = { 'market-moving':'🔴','forex':'💱','energy':'⚡','macro':'🏦','geopolitical':'🌐','econ-data':'📋','news':'📰' };
  const lines = newItems.slice(0,10).map(i => `${EMOJI[detectCat(i.title)]||'📰'} ${i.link?`[${i.title}](${i.link})`:i.title}`);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ chat_id:TG_CHAT_ID, text:`*FJFeed — ${newItems.length} berita baru*\n\n${lines.join('\n')}`, parse_mode:'Markdown', disable_web_page_preview:true }),
      signal:AbortSignal.timeout(10000),
    });
  } catch(e) { console.warn('Telegram:', e.message); }
}

function parseRSS(xml) {
  const items=[], re=/<item>([\s\S]*?)<\/item>/g; let m;
  while((m=re.exec(xml))!==null){
    const b=m[1];
    const get=tag=>{const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b);const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);return(r1||r2)?.[1]?.trim()||'';};
    const title=get('title').replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), link=b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if(guid&&title)items.push({title,guid,link});
  }
  return items;
}

function detectCat(t) {
  t=t.toLowerCase();
  if(['market moving','breaking','blockade'].some(k=>t.includes(k)))return'market-moving';
  if(['eur/','gbp/','usd/','aud/','nzd/','cad/','chf/','jpy/','/usd','/jpy','dxy','loonie','aussie','cable'].some(k=>t.includes(k)))return'forex';
  if(['oil','crude','brent','wti','natural gas','hormuz','iea'].some(k=>t.includes(k)))return'energy';
  if(['fed ','fomc','powell','federal reserve','rate cut','ecb','boe','boj','pboc'].some(k=>t.includes(k)))return'macro';
  if(['iran','israel','russia','ukraine','china','trump','nato','war','tariff'].some(k=>t.includes(k)))return'geopolitical';
  if(['actual','forecast','previous','cpi','nfp','unemployment'].some(k=>t.includes(k)))return'econ-data';
  return'news';
}
