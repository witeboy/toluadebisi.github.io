const OPENAI_TRANSLATIONS_URL = 'https://api.openai.com/v1/audio/translations';
const MAX_REQUEST_BYTES = 23 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  'https://witeboy.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]);

function corsHeaders(origin = '') {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  });
  if (ALLOWED_ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function json(data, status = 200, origin = '') {
  const headers = corsHeaders(origin);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers });
}

function allowedOrigin(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function clientKey(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (!allowedOrigin(origin)) return json({ error: 'Origin not allowed.' }, 403, origin);
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!allowedOrigin(origin)) return json({ error: 'Origin not allowed.' }, 403, origin);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'accompaniment-studio-stt', model: 'whisper-1' }, 200, origin);
    }

    if (request.method !== 'POST' || url.pathname !== '/translate') {
      return json({ error: 'Not found.' }, 404, origin);
    }

    if (!env.OPENAI_API_KEY) {
      return json({ error: 'OPENAI_API_KEY is not configured on this Worker.' }, 503, origin);
    }

    if (env.TRANSLATION_RATE_LIMITER) {
      const { success } = await env.TRANSLATION_RATE_LIMITER.limit({ key: clientKey(request) });
      if (!success) return json({ error: 'Too many translation requests. Try again in a minute.' }, 429, origin);
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return json({ error: 'Expected multipart/form-data.' }, 415, origin);
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength && contentLength > MAX_REQUEST_BYTES) {
      return json({ error: 'Audio chunk is too large. Keep each request under 23 MiB.' }, 413, origin);
    }

    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

    let upstream;
    try {
      upstream = await fetch(OPENAI_TRANSLATIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': contentType,
        },
        body: request.body,
      });
    } catch (error) {
      console.error('OpenAI request failed', error);
      return json({ error: 'Could not reach the OpenAI translation service.' }, 502, origin);
    }

    const raw = await upstream.text();
    if (!upstream.ok) {
      let details = raw;
      try {
        const parsed = JSON.parse(raw);
        details = parsed?.error?.message || parsed?.message || raw;
      } catch {}
      console.error('OpenAI translation error', upstream.status, details);
      return json({ error: details || `OpenAI returned ${upstream.status}.` }, upstream.status, origin);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: 'OpenAI returned an unreadable translation response.' }, 502, origin);
    }

    const segments = Array.isArray(data.segments)
      ? data.segments
          .map((segment) => ({
            start: offset + Math.max(0, Number(segment.start || 0)),
            end: offset + Math.max(0, Number(segment.end ?? segment.start ?? 0)),
            text: String(segment.text || '').trim(),
          }))
          .filter((segment) => segment.text)
      : [];

    return json(
      {
        text: String(data.text || '').trim(),
        language: data.language || 'english',
        duration: Number(data.duration || 0),
        offset,
        segments,
      },
      200,
      origin,
    );
  },
};
