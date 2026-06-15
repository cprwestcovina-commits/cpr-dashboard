// Recovery link redirect + click tracking: /api/r?t=<signed token> → records the click on the
// lead record (channel + tier from the token) then 302s to the booking widget. Both the email
// and SMS recovery links route through here, so click tracking covers both channels.
const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';

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

  let course = 'bls', payload = null;
  try {
    const payloadB64 = t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (payload.c) course = payload.c;
  } catch (e) { /* malformed → still route to default widget */ }

  // Log the click on the lead record (write-only; GET-by-key is unreliable but PATCH works).
  const ch = payload?.ch || 'email';
  if (payload?.k) {
    try {
      await fetch(`${DS_URL}/${encodeURIComponent(payload.k)}?teamId=${TEAM_ID}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recovery_clicked: 'yes',
          recovery_click_channel: ch,
          recovery_click_tier: payload.ti || '',
          recovery_clicked_at: new Date().toISOString(),
        }),
      });
    } catch (e) { /* never block the redirect on a tracking write */ }
  }

  return res.redirect(302, `${widgetFor(course)}?rcv=${encodeURIComponent(t)}&src=recovery&utm_content=${ch}`);
}
