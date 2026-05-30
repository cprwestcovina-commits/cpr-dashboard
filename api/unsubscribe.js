// One-click unsubscribe — sets email_optout='yes' on all of a student's records so future
// broadcast emails skip them. Transactional emails (confirmations, renewals) are unaffected.
const MAKE_TOKEN = '4317021d-3786-4640-8265-34e63c0aaa2e';
const DS_URL = 'https://us2.make.com/api/v2/data-stores/100809/data';
const TEAM_ID = '2313459';

function page(title, msg) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:-apple-system,Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center;color:#1a1a1a;">
  <h1 style="color:#243B5A;font-size:22px;">${title}</h1>
  <p style="color:#555;line-height:1.5;">${msg}</p>
  <p style="color:#999;font-size:12px;margin-top:30px;">CPR West Covina · West Covina, CA</p>
  </body></html>`;
}

export default async function handler(req, res) {
  const email = (req.query?.e || '').trim().toLowerCase();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!email || !email.includes('@')) {
    return res.status(400).send(page('Invalid link', 'This unsubscribe link is missing a valid email address.'));
  }
  try {
    // Fetch all records, find this email's records, flag them opted-out
    let all = [], offset = 0;
    while (true) {
      const r = await fetch(`${DS_URL}?teamId=${TEAM_ID}&pg[limit]=100&pg[offset]=${offset}`, { headers: { 'Authorization': `Token ${MAKE_TOKEN}` } });
      const data = await r.json();
      const batch = data.records || [];
      all = all.concat(batch);
      if (batch.length < 100) break;
      offset += 100;
      if (offset > 10000) break;
    }
    const mine = all.filter(r => (r.data?.email || '').toLowerCase() === email);
    let updated = 0;
    for (const rec of mine) {
      const body = { ...rec.data, email_optout: 'yes' };
      const resp = await fetch(`${DS_URL}/${encodeURIComponent(rec.key)}?teamId=${TEAM_ID}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Token ${MAKE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) updated++;
    }
    return res.status(200).send(page("You're unsubscribed", `${email} won't receive any more marketing emails from us. You'll still get important booking confirmations and class reminders. Changed your mind? Just reply to any email.`));
  } catch (e) {
    return res.status(500).send(page('Something went wrong', "We couldn't process your request right now. Please reply to the email and we'll remove you manually."));
  }
}
