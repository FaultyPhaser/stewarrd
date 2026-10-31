import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { requireJson } from '../middleware/auth.js';
import { buildAuthUrl, checkPin, createPin, getPlexUser } from '../services/plex.js';
import { resolvePlexUser } from '../services/login.js';
import {
  ACT_AS_COOKIE, PIN_COOKIE, SESSION_COOKIE, clearCookie, readCookie, setCookie, sessionToken, sign, verify,
} from '../services/session.js';

const PIN_TTL_MS = 10 * 60_000;
const router = Router();
router.use(requireJson);

/** Step 1: get a Plex PIN, remember it in a short-lived signed cookie, and return the Plex sign-in URL. */
router.post('/plex/start', async (req, res, next) => {
  try {
    let forward;
    try {
      forward = new URL(String(req.body?.forwardUrl ?? ''));
    } catch {
      throw new HttpError(400, 'Invalid forwardUrl');
    }
    if (forward.protocol !== 'http:' && forward.protocol !== 'https:') throw new HttpError(400, 'Invalid forwardUrl');
    forward.hash = '';

    const pin = await createPin();
    if (!pin?.id || !pin?.code) throw new HttpError(502, 'Plex did not return a PIN', { expose: true });
    // The pin lives in a cookie, so only the browser that started the login can finish it.
    setCookie(res, req, PIN_COOKIE, sign({ t: 'pin', id: pin.id, code: pin.code, exp: Date.now() + PIN_TTL_MS }), PIN_TTL_MS);
    res.json({ authUrl: buildAuthUrl(pin.code, forward.href) });
  } catch (err) {
    next(err);
  }
});

/** Step 2: has the user signed in at Plex yet? Returns { status: 'none' | 'pending' | 'expired' | 'ok' }. */
router.post('/plex/poll', async (req, res, next) => {
  try {
    const pin = verify(readCookie(req, PIN_COOKIE));
    if (!pin || pin.t !== 'pin') return res.json({ status: 'none' });

    let token;
    try {
      token = await checkPin(pin.id, pin.code);
    } catch (err) {
      if (err.upstreamStatus === 404) {
        clearCookie(res, req, PIN_COOKIE);
        return res.json({ status: 'expired' });
      }
      throw err;
    }
    if (!token) return res.json({ status: 'pending' });

    clearCookie(res, req, PIN_COOKIE); // one login per pin, success or not
    const user = await resolvePlexUser(await getPlexUser(token));
    setCookie(res, req, SESSION_COOKIE, sessionToken(user.id), config.sessionDays * 86_400_000);
    res.json({ status: 'ok', username: user.username });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearCookie(res, req, SESSION_COOKIE);
  clearCookie(res, req, PIN_COOKIE);
  clearCookie(res, req, ACT_AS_COOKIE);
  res.json({ ok: true });
});

export default router;
