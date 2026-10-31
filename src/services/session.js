import crypto from 'node:crypto';
import { config } from '../config.js';
import { persisted } from './secrets.js';

export const SESSION_COOKIE = 'stew_session';
export const PIN_COOKIE = 'stew_plex_pin';
export const ACT_AS_COOKIE = 'stew_actas'; // admin "act as user": signed, HttpOnly, only honoured for the real admin's session

const secret = () => config.sessionSecret || persisted('session-secret', () => crypto.randomBytes(32).toString('hex'));
const mac = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

/** Signed (not encrypted) token: base64url(JSON).hmac. Payloads must carry `t` (purpose) and `exp` (epoch ms). */
export function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}

export function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie ?? '');
  return match ? match[1] : undefined;
}

/** HttpOnly, SameSite=Lax; Secure whenever the request arrived over HTTPS (needs TRUST_PROXY=1 behind a proxy). */
export function setCookie(res, req, name, value, maxAgeMs) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res, req, name) {
  setCookie(res, req, name, '', 0);
}

export const sessionToken = (userId) =>
  sign({ t: 'session', uid: userId, exp: Date.now() + config.sessionDays * 86_400_000 });

/** Returns the user id of a valid session cookie, or null. */
export function sessionUserId(req) {
  const s = verify(readCookie(req, SESSION_COOKIE));
  return s && s.t === 'session' && Number.isInteger(s.uid) ? s.uid : null;
}
