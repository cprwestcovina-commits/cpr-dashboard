// Vercel Cron — pings the Make webhook that processes all pending leads
// needing the T+2hr recovery email. Runs every 2 hours. Bypasses Make's
// scheduler entirely (which has been unreliable).

export default async function handler(req, res) {
  // Verify request came from Vercel Cron (uses authorization header)
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const resp = await fetch('https://hook.us2.make.com/gt2vfh437ujhcixuwrerqqh8ydtfwvpn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: 'vercel-cron', ts: new Date().toISOString() }),
    });
    const text = await resp.text();
    return res.status(200).json({ ok: true, hookStatus: resp.status, hookBody: text.slice(0, 200) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
