// Saves push subscription to Netlify Blobs
const { getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS' }, body: '' };
  }

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const body = JSON.parse(event.body || '{}');
    const store = getStore({ name: 'push-subscriptions', consistency: 'strong' });

    if (event.httpMethod === 'DELETE') {
      const { endpoint } = body;
      if (!endpoint) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing endpoint' }) };
      const key = Buffer.from(endpoint).toString('base64').slice(0, 100);
      await store.delete(key);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (event.httpMethod === 'POST') {
      const { subscription } = body;
      if (!subscription?.endpoint) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid subscription' }) };
      const key = Buffer.from(subscription.endpoint).toString('base64').slice(0, 100);
      await store.set(key, JSON.stringify(subscription), { metadata: { subscribedAt: Date.now() } });
      return { statusCode: 201, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    console.error('Subscribe error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
