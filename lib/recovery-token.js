// Signed recovery-discount tokens.
// The cron SIGNS a token (lead key + course + discount + absolute expiry) and drops it in the
// recovery email/text link. The /api/recovery-checkout endpoint VERIFIES it before minting a
// discounted Square payment link. HMAC signature = the discount can't be forged or extended,
// and the expiry is an absolute timestamp so a closed/reopened widget counts down accurately.
import crypto from 'crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function hmac(payloadB64, secret) {
  return b64u(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

// payload: { k: leadKey, c: course_type, a: discountCents, t: tierLabel, ch: channel, x: expiryMs }
export function signToken(payload, secret = process.env.RECOVERY_SECRET) {
  if (!secret) throw new Error('RECOVERY_SECRET not set');
  const payloadB64 = b64u(JSON.stringify(payload));
  return `${payloadB64}.${hmac(payloadB64, secret)}`;
}

// Returns { valid, expired, payload }.
// valid=false → tampered/garbage (reject outright). valid=true+expired=true → fall back to backup offer.
export function verifyToken(token, secret = process.env.RECOVERY_SECRET) {
  try {
    if (!secret) throw new Error('RECOVERY_SECRET not set');
    const [payloadB64, sig] = String(token).split('.');
    if (!payloadB64 || !sig) return { valid: false };
    const expected = hmac(payloadB64, secret);
    // constant-time compare
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false };
    const payload = JSON.parse(b64uDecode(payloadB64));
    const expired = !payload.x || Date.now() > Number(payload.x);
    return { valid: true, expired, payload };
  } catch (e) {
    return { valid: false };
  }
}
