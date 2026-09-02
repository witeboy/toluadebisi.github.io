const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const CF_WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
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
    'Access-Control-Allow-Headers': 'Content-Type, X-CF-Account-ID, X-CF-AI-Token',
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

function readCredentials(request) {
  const accountId = String(request.headers.get('X-CF-Account-ID') || '').trim();
  const token = String(request.headers.get('X-CF-AI-Token') || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) return { error: 'Enter a valid 32-character Cloudflare Account ID.' };
  if (token.length < 20) return { error: 'Enter a valid Workers AI API token.' };
  return { accountId, token };
}

function cloudflareError(data, fallback) {
  return data?.errors?.[0]?.message || data?.error?.message || data?.message || fallback;
}

async function cloudflareFetch(accountId, token, path, options = {}) {
  const url = `${CF_API_BASE}/${encodeURIComponent(accountId)}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
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
      return json({ ok: true, service: 'accompaniment-studio-stt-relay', provider: 'Cloudflare Workers AI', model: CF_WHISPER_MODEL }, 200, origin);
    }

    if (!['/test', '/translate'].includes(url.pathname) || request.method !== 'POST') {
      return json({ error: 'Not found.' }, 404, origin);
    }

    if (env.TRANSLATION_RATE_LIMITER) {
      const { success } = await env.TRANSLATION_RATE_LIMITER.limit({ key: clientKey(request) });
      if (!success) return json({ error: 'Too many AI requests. Try again in a minute.' }, 429, origin);
    }

    const credentials = readCredentials(request);
    if (credentials.error) return json({ error: credentials.error }, 400, origin);
    const { accountId, token } = credentials;

    if (url.pathname === '/test') {
      try {
        const response = await cloudflareFetch(
          accountId,
          token,
          `/ai/models/search?search=${encodeURIComponent('whisper-large-v3-turbo')}&per_page=10`,
          { method: 'GET' },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
          return json({ error: cloudflareError(data, `Cloudflare returned HTTP ${response.status}.`) }, response.status || 502, origin);
        }
        return json({ ok: true, model: CF_WHISPER_MODEL }, 200, origin);
      } catch (error) {
        console.error('Workers AI credential test failed');
        return json({ error: 'Could not reach Cloudflare Workers AI from the relay.' }, 502, origin);
      }
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return json({ error: 'Expected application/json.' }, 415, origin);
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength && contentLength > MAX_REQUEST_BYTES) {
      return json({ error: 'Audio chunk is too large. Reduce the chunk duration and try again.' }, 413, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON request.' }, 400, origin);
    }

    if (!body?.audio || typeof body.audio !== 'string') {
      return json({ error: 'Audio payload is missing.' }, 400, origin);
    }

    const upstreamBody = {
      audio: body.audio,
      task: 'translate',
      language: 'yo',
      vad_filter: body.vad_filter !== false,
      condition_on_previous_text: body.condition_on_previous_text === true,
      initial_prompt: String(body.initial_prompt || 'Yoruba conversational speech. Translate faithfully into clear natural English. Preserve personal names, place names, kinship terms, and culturally specific Yoruba words when a direct English replacement would lose meaning.').slice(0, 1200),
    };

    try {
      const response = await cloudflareFetch(
        accountId,
        token,
        `/ai/run/${CF_WHISPER_MODEL}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(upstreamBody),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        return json({ error: cloudflareError(data, `Cloudflare returned HTTP ${response.status}.`) }, response.status || 502, origin);
      }
      return json(data, 200, origin);
    } catch (error) {
      console.error('Workers AI translation relay failed');
      return json({ error: 'Could not reach Cloudflare Workers AI from the relay.' }, 502, origin);
    }
  },
};
