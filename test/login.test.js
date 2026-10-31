import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Mock plex.tv: the PIN becomes "signed in" after the first poll.
let polls = 0;
let plexUserId = 777;
const plex = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url.startsWith('/api/v2/pins')) return res.end(JSON.stringify({ id: 5, code: 'ABCD' }));
  if (req.url.startsWith('/api/v2/pins/5')) {
    polls += 1;
    return res.end(JSON.stringify({ authToken: polls > 1 ? 'tok' : null }));
  }
  if (req.url.startsWith('/api/v2/pins/')) { res.statusCode = 404; return res.end('{}'); }
  if (req.url.startsWith('/api/v2/user')) {
    return res.end(JSON.stringify(req.headers['x-plex-token'] === 'tok' ? { id: plexUserId, username: 'p' } : {}));
  }
  res.statusCode = 404;
  return res.end('{}');
});
await new Promise((r) => plex.listen(0, '127.0.0.1', r));

process.env.PLEX_API_URL = `http://127.0.0.1:${plex.address().port}`;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-login-'));
process.env.SEERR_URL = 'http://127.0.0.1:1';
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // these tests release items right after requesting them
process.env.WEBHOOK_SECRET = 's';

const credits = await import('../src/services/credits.js');
const { app } = await import('../src/index.js');
const { sign, verify } = await import('../src/services/session.js');
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const post = (p, cookie = '', body = {}) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
});
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));

test.after(() => { plex.close(); server.close(); });

test('signed tokens reject tampering and expiry', () => {
  const t = sign({ t: 'x', exp: Date.now() + 1000 });
  assert.equal(verify(t).t, 'x');
  assert.equal(verify(`${t}a`), null);
  assert.equal(verify(`${t.split('.')[0]}.AAAA`), null);
  assert.equal(verify(sign({ t: 'x', exp: Date.now() - 1 })), null);
  assert.equal(verify(undefined), null);
});

test('API requires a session', async () => {
  const res = await fetch(`${base}/api/user/credits`);
  assert.equal(res.status, 401);
  // The old unauthenticated shortcut cookies must not work.
  assert.equal((await fetch(`${base}/api/user/credits`, { headers: { Cookie: 'dev_user=1' } })).status, 401);
});

test('Plex login signs in a known user and sets a session', async () => {
  credits.upsertUser({ id: 2, username: 'alice', plexId: '777' });
  const start = await post('/api/auth/plex/start', '', { forwardUrl: 'http://localhost:3000/' });
  assert.equal(start.status, 200);
  const { authUrl } = await start.json();
  assert.match(authUrl, /^https:\/\/app\.plex\.tv\/auth#\?/);
  assert.match(authUrl, /code=ABCD/);
  const pinCookie = cookiesOf(start).join('; ');

  assert.equal((await (await post('/api/auth/plex/poll', pinCookie)).json()).status, 'pending');
  const done = await post('/api/auth/plex/poll', pinCookie);
  assert.deepEqual(await done.json(), { status: 'ok', username: 'alice' });
  const session = cookiesOf(done).find((c) => c.startsWith('stew_session='));
  assert.ok(session);

  const me = await (await fetch(`${base}/api/user/credits`, { headers: { Cookie: session } })).json();
  assert.equal(me.userId, 2);
  assert.equal(me.isAdmin, false);

  // A forged session is rejected, and the admin endpoints stay closed to normal users.
  assert.equal((await fetch(`${base}/api/user/credits`, { headers: { Cookie: 'stew_session=2.bad' } })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/report`, { headers: { Cookie: session } })).status, 403);
});

test('a Plex account that is not a Seerr user is refused and never created', async () => {
  polls = 1;
  plexUserId = 999;
  const start = await post('/api/auth/plex/start', '', { forwardUrl: 'http://localhost:3000/' });
  const res = await post('/api/auth/plex/poll', cookiesOf(start).join('; '));
  assert.equal(res.status, 403);
  assert.equal(cookiesOf(res).some((c) => c.startsWith('stew_session=')), false);
  assert.equal(credits.getBalance(999), 0);
});

test('polling without a PIN cookie, bad forward URLs and logout', async () => {
  assert.equal((await (await post('/api/auth/plex/poll')).json()).status, 'none');
  assert.equal((await post('/api/auth/plex/start', '', { forwardUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await post('/api/auth/plex/start', '', {})).status, 400);
  const out = await post('/api/auth/logout');
  assert.equal(out.status, 200);
  assert.ok(out.headers.getSetCookie().some((c) => c.startsWith('stew_session=;')));
});
