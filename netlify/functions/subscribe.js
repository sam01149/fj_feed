const { getStore } = require('@netlify/blobs');

function getStoreWithContext(context, name) {
  // Netlify injects siteID and token via context.clientContext or env vars
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.TOKEN;

  if (siteID && token) {
    return getStore({ name, siteID, token, consistency: 'strong' });
  }
  // Fall back to auto-detection (works when properly deployed via Git)
  return getStore({ name, consistency: 'strong' });
}

exports.handler = async function(event, context) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
      },
      body: '',
    };
  }

  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const body = JSON.parse(event.body || '{}');
    const store = getStoreWithContext(context, 'push-subscriptions');

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
