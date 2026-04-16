// netlify/functions/calendar.js
// Fetches high-impact economic calendar from Forex Factory public XML feed
// Filters: high impact only, major forex currencies, today + tomorrow WIB

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';

const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

exports.handler = async function(event, context) {
  try {
    const res = await fetch(FF_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)',
        'Accept': 'application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) throw new Error('FF feed HTTP ' + res.status);

    const xml = await res.text();
    if (!xml.includes('<eventWeek>') && !xml.includes('<event>')) {
      throw new Error('Invalid XML response from FF feed');
    }

    const allEvents = parseFFXML(xml);

    // Get today and tomorrow in WIB (UTC+7)
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const todayWib = toDateStr(nowWib);
    const tomorrowWib = toDateStr(new Date(nowWib.getTime() + 86400000));

    const filtered = allEvents.filter(e =>
      (e.date === todayWib || e.date === tomorrowWib) &&
      e.impact === 'High' &&
      MAJOR_CURRENCIES.has(e.currency)
    );

    filtered.sort((a, b) => {
      const ka = a.date + (a.time_wib || '');
      const kb = b.date + (b.time_wib || '');
      return ka.localeCompare(kb);
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=900',
      },
      body: JSON.stringify({
        events: filtered,
        count: filtered.length,
        fetched_at: new Date().toISOString(),
      }),
    };

  } catch(e) {
    console.error('Calendar fetch error:', e.message);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};

function toDateStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseFFXML(xml) {
  const events = [];
  const eventRe = /<event>([\s\S]*?)<\/event>/g;
  let m;

  while ((m = eventRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return r ? r[1].trim() : '';
    };

    const title    = get('title');
    const country  = get('country').toUpperCase();
    const date     = get('date');
    const time     = get('time');
    const impact   = get('impact');
    const forecast = get('forecast');
    const previous = get('previous');

    if (!title || !country) continue;

    // Convert MM-DD-YYYY to YYYY-MM-DD
    const dateParts = date.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!dateParts) continue;
    const dateIso = `${dateParts[3]}-${dateParts[1]}-${dateParts[2]}`;

    const timeWib = convertToWIB(time);

    events.push({
      date: dateIso,
      time_wib: timeWib,
      currency: country,
      event: title,
      impact,
      forecast: forecast || null,
      previous: previous || null,
    });
  }

  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr || timeStr === 'All Day' || timeStr === 'Tentative') {
    return 'Tentative';
  }

  const m = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
  if (!m) return timeStr;

  let hour = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toLowerCase();

  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // FF times are US Eastern Time
  // EDT (UTC-4) active Mar-Nov: WIB = ET + 11h
  // EST (UTC-5) active Nov-Mar: WIB = ET + 12h
  const nowMonth = new Date().getUTCMonth() + 1;
  const isDST = nowMonth >= 3 && nowMonth <= 10;
  const offsetHours = isDST ? 11 : 12;

  const wibHour = (hour + offsetHours) % 24;
  return `${String(wibHour).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}
