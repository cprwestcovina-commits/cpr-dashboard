// Short SMS redirect: /api/r?k=<leadKey> → 302 to the lead's course booking widget with their
// signed recovery token attached. Keeps recovery texts short (one segment) instead of pasting a
// ~200-char token inline. The token itself is stored on the lead record by the cron.
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
  const key = (req.query?.k || '').trim();
  const fallback = 'https://cprwestcovina.com';
  if (!key) return res.redirect(302, fallback);
  try {
    const r = await fetch(`${DS_URL}/${encodeURIComponent(key)}?teamId=${TEAM_ID}`, {
      headers: { 'Authorization': `Token ${MAKE_TOKEN}` },
    });
    const j = await r.json();
    const d = (j && (j.record?.data || j.data)) || null;
    if (!d || !d.recovery_token) return res.redirect(302, fallback);
    const url = `${widgetFor(d.course_type)}?rcv=${d.recovery_token}&src=recovery&utm_content=sms`;
    return res.redirect(302, url);
  } catch (e) {
    return res.redirect(302, fallback);
  }
}
