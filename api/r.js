// Short SMS redirect: /api/r?t=<signed token> → 302 to the lead's course booking widget with the
// token attached. The token is carried IN the link (no datastore lookup) because Make's GET-by-key
// is unreliable for synthetic keys. The token is already URL-safe (base64url + '.'), and the
// checkout endpoint verifies its signature — this redirect just routes to the right widget.
function widgetFor(ct) {
  const c = (ct || '').toLowerCase().replace(/^aha_/, '');
  if (c === 'heartsaver' || c === 'hs') return 'https://cpr-dashboard-cprwc.vercel.app/heartsaver.html';
  if (c === 'acls') return 'https://cpr-dashboard-cprwc.vercel.app/acls.html';
  if (c === 'pals') return 'https://cpr-dashboard-cprwc.vercel.app/pals.html';
  return 'https://cprwestcovina-commits.github.io/bls-booking/bls-booking.html';
}

export default async function handler(req, res) {
  const fallback = 'https://cprwestcovina.com';
  const t = (req.query?.t || '').trim();
  if (!t) return res.redirect(302, fallback);
  let course = 'bls';
  try {
    const payloadB64 = t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (payload.c) course = payload.c;
  } catch (e) { /* malformed token → still route to default widget */ }
  return res.redirect(302, `${widgetFor(course)}?rcv=${encodeURIComponent(t)}&src=recovery&utm_content=sms`);
}
