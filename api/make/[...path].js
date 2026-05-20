export const config = { runtime: 'edge' };

export default async function handler(req) {
  const auth = req.headers.get('authorization') || '';
  const pw = auth.replace(/^Bearer /i, '').trim();
  if (!pw || pw !== process.env.DASHBOARD_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  // /api/make/foo/bar?x=1 -> https://us2.make.com/api/v2/foo/bar?x=1
  const upstream = 'https://us2.make.com/api/v2' + url.pathname.replace(/^\/api\/make/, '') + url.search;

  const init = {
    method: req.method,
    headers: {
      'Authorization': 'Token ' + process.env.MAKE_TOKEN,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  };
  if (!['GET','HEAD'].includes(req.method)) {
    init.body = await req.text();
    init.headers['Content-Type'] = req.headers.get('content-type') || 'application/json';
  }

  try {
    const r = await fetch(upstream, init);
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('content-type') || 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
