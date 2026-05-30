// Vercel Cron — fires every Make webhook that processes scheduled cadence touches.
// Runs every 2 hours; each webhook internally only processes leads matching its filter
// (T+2hr → 2hr-7d old, T+24hr → 24hr-7d old, Day 5 → 5-30d old, Day 7 → 6.5-7.5d ACLS/PALS).
// Bypasses Make's scheduler (which has been unreliable) by triggering via webhook
// (which always works). Idempotent — leads already touched have their nudge flag set
// and are skipped by each scenario's filter.

const HOOKS = [
  { name: 'T+2hr email',         url: 'https://hook.us2.make.com/gt2vfh437ujhcixuwrerqqh8ydtfwvpn' },
  { name: 'T+24hr SMS',          url: 'https://hook.us2.make.com/gx28l5ozstqidieqm8cwmvy8knye9y85' },
  { name: 'Day 5 email',         url: 'https://hook.us2.make.com/oxlc4vhndmrcj8x95cdoxje83akkhoih' },
  { name: 'Day 5 SMS',           url: 'https://hook.us2.make.com/shvcw8em6a7ods39woicvc3me0py6m4s' },
  { name: 'Day 7 ACLS/PALS SMS', url: 'https://hook.us2.make.com/fj54ozgu6uwc19qh73vqavispxf0ebqm' },
];

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const ts = new Date().toISOString();
  const results = [];
  for (const hook of HOOKS) {
    try {
      const resp = await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggered_by: 'vercel-cron', ts }),
      });
      results.push({ name: hook.name, status: resp.status });
    } catch (e) {
      results.push({ name: hook.name, error: String(e) });
    }
    // 300ms gap so Make doesn't see 5 simultaneous webhook fires
    await new Promise(r => setTimeout(r, 300));
  }
  return res.status(200).json({ ok: true, ts, results });
}
