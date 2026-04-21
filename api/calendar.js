// api/calendar.js
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';
const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(12000) }),
      fetch(FF_NEXT_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(12000) }),
    ]);

    let allEvents = [];
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        const xml = await result.value.text();
        if (xml.includes('<event>')) allEvents = allEvents.concat(parseFFXML(xml));
      }
    }
    if (allEvents.length === 0) throw new Error('No events parsed');

    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 4; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));

    const seen = new Set();
    const deduped = allEvents
      .filter(e => dateRange.has(e.date) && (e.impact === 'High' || e.impact === 'Medium') && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => {
        const k = `${e.date}|${e.time_wib}|${e.currency}|${e.event}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => {
        const ka = a.date + (a.time_wib === 'Tentative' ? '99:99' : a.time_wib || '99:99');
        const kb = b.date + (b.time_wib === 'Tentative' ? '99:99' : b.time_wib || '99:99');
        return ka.localeCompare(kb);
      });

    res.setHeader('Cache-Control', 'max-age=300');
    return res.status(200).json({ events: deduped, count: deduped.length, fetched_at: new Date().toISOString() });
  } catch(e) {
    console.error('Calendar error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

function toDateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function parseFFXML(xml) {
  const events = [];
  const re = /<event>([\s\S]*?)<\/event>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      if (!r) return '';
      return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim();
    };
    const title    = get('title');
    const country  = get('country').toUpperCase();
    const date     = get('date');
    const time     = get('time');
    const impact   = get('impact');
    const forecast = get('forecast');
    const previous = get('previous');
    const actual   = get('actual');
    if (!title || !country) continue;
    const dp = date.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dp) continue;
    events.push({
      date:     `${dp[3]}-${dp[1]}-${dp[2]}`,
      time_wib: convertToWIB(time),
      currency: country,
      event:    title,
      impact,
      forecast: forecast || null,
      previous: previous || null,
      actual:   actual   || null,
    });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr || timeStr === 'All Day' || timeStr === 'Tentative') return 'Tentative';
  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return timeStr;
  let hour = parseInt(m[1]);
  const min = parseInt(m[2]), ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const isDST = (new Date().getUTCMonth() + 1) >= 3 && (new Date().getUTCMonth() + 1) <= 10;
  return `${String((hour + (isDST ? 11 : 12)) % 24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}
