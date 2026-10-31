import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Mock Seerr: sessions "good-1" and "good-2" map to users; requests 1..3 are made by user 2.
const calls = [];
const seerr = http.createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/v1/auth/me') {
    const cookie = req.headers.cookie ?? '';
    if (cookie.includes('connect.sid=good-2')) return res.end(JSON.stringify({ id: 2, username: 'a' }));
    if (cookie.includes('connect.sid=good-1')) return res.end(JSON.stringify({ id: 1, username: 'admin' }));
    res.statusCode = 403;
    return res.end('{}');
  }
  const m = /^\/api\/v1\/request\/(\d+)(\/(approve|decline))?$/.exec(req.url);
  if (m) {
    if (m[3]) return res.end('{}');
    return res.end(JSON.stringify({
      id: Number(m[1]), type: 'movie', requestedBy: { id: 2, username: 'a' }, media: { id: 500 + Number(m[1]), tmdbId: 900 + Number(m[1]) }, seasons: [],
    }));
  }
  if (req.url.startsWith('/api/v1/movie/')) return res.end(JSON.stringify({ title: 'Some Movie' }));
  res.statusCode = 404;
  return res.end('{}');
});
await new Promise((r) => seerr.listen(0, '127.0.0.1', r));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stew-inject-'));
process.env.SEERR_URL = `http://127.0.0.1:${seerr.address().port}`;
process.env.SEERR_API_KEY = 'x';
process.env.ADMIN_USER_ID = '1';
process.env.MIN_STEWARDSHIP_DAYS = '0'; // these tests release items right after requesting them
process.env.WEBHOOK_SECRET = 's';
process.env.DEFAULT_CREDITS = '2';
process.env.CREDIT_COST_MOVIE = '1';
process.env.CREDIT_COST_TV_SEASON = '2';

const credits = await import('../src/services/credits.js');
const { app } = await import('../src/index.js');
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { seerr.close(); server.close(); });

const get = (p, cookie = '') => fetch(base + p, { headers: { Cookie: cookie } });
const hook = (requestId, type = 'MEDIA_PENDING') => fetch(`${base}/api/seerr-webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s' },
  body: JSON.stringify({ notification_type: type, request: { request_id: String(requestId) } }),
});

test('a Seerr session identifies the user; a bad one does not', async () => {
  assert.equal((await get('/api/user/credits')).status, 401);
  assert.equal((await get('/api/user/credits', 'connect.sid=nope')).status, 401);

  credits.upsertUser({ id: 2, username: 'a' });
  const res = await get('/api/user/credits', 'connect.sid=good-2');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.userId, body.credits, body.allowance], [2, 2, 2]);
  assert.deepEqual(body.costs, { movie: 1, tv: 2 });

  const admin = await (await get('/api/user/credits', 'connect.sid=good-1')).json();
  assert.deepEqual(admin.costs, { movie: 0, tv: 0 });
});

test('the Seerr session cannot reach admin routes', async () => {
  assert.equal((await get('/api/admin/users', 'connect.sid=good-1')).status, 401);
});

test('media status tells the caller what a request costs and whether they can afford it', async () => {
  let info = (await (await get('/api/media/status?type=movie&id=123', 'connect.sid=good-2')).json());
  assert.deepEqual(info.request, { unitCost: 1, balance: 2, canAfford: true });
  assert.equal(info.tracked, false);

  credits.setAllowance(2, 0, 1);
  info = (await (await get('/api/media/status?type=tv&id=123', 'connect.sid=good-2')).json());
  assert.deepEqual(info.request, { unitCost: 2, balance: 0, canAfford: false });

  const admin = (await (await get('/api/media/status?type=movie&id=123', 'connect.sid=good-1')).json());
  assert.deepEqual(admin.request, { unitCost: 0, balance: null, canAfford: true });
});

test('the webhook records declines and approvals, and the activity feed shows them', async () => {
  assert.equal((await (await hook(1)).json()).action, 'declined'); // balance 0
  credits.setAllowance(2, 5, 1);
  assert.equal((await (await hook(2)).json()).action, 'approved');
  assert.equal((await (await hook(2)).json()).action, 'none'); // duplicate: no second event

  const { events } = await (await get('/api/user/activity', 'connect.sid=good-2')).json();
  assert.deepEqual(events.map((e) => e.action), ['APPROVED', 'DECLINED']);
  assert.equal(events[1].reason, 'insufficient_credits');
  assert.deepEqual([events[1].cost, events[1].balance, events[1].title], [1, 0, 'Some Movie']);
  assert.equal(events[0].balance, 4);
  assert.ok(calls.includes('POST /api/v1/request/1/decline'));
  assert.ok(calls.includes('POST /api/v1/request/2/approve'));
});

test('an auto-approved request is charged and tracked without a second approve call; other events are ignored', async () => {
  const before = credits.getBalance(2);
  const out = await (await hook(7, 'MEDIA_AUTO_APPROVED')).json();
  assert.equal(out.action, 'approved');
  assert.equal(credits.getBalance(2), before - 1);
  const unit = credits.findUnit('movie:907');
  assert.ok(unit, 'the unit is created right away');
  assert.equal(unit.current_owner_id, 2);
  assert.equal(unit.available, 0);
  assert.ok(!calls.includes('POST /api/v1/request/7/approve'), 'already approved, so no approve call');
  assert.equal((await (await hook(7, 'MEDIA_AUTO_APPROVED')).json()).action, 'none'); // duplicate
  assert.equal((await (await hook(8, 'MEDIA_AVAILABLE')).json()).ignored, true);
  assert.equal(credits.findUnit('movie:908'), undefined);
});

test('the drawer endpoints work with a Seerr session and reject anonymous callers', async () => {
  for (const p of ['/api/user/media', '/api/media/flagged', '/api/user/activity?limit=10']) {
    assert.equal((await get(p)).status, 401, p);
    assert.equal((await get(p, 'connect.sid=good-2')).status, 200, p);
  }
  const media = await (await get('/api/user/media', 'connect.sid=good-2')).json();
  assert.ok(Array.isArray(media.items));
  assert.equal(typeof media.items[0]?.remainingDays, 'number');
  assert.ok(Array.isArray((await (await get('/api/media/flagged', 'connect.sid=good-2')).json()).items));
});

test('an admin can act as another user; nobody else can, and admin routes keep the real identity', async () => {
  const { sessionToken, sign, ACT_AS_COOKIE, SESSION_COOKIE } = await import('../src/services/session.js');
  const post = (p, body, cookie) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
  });
  credits.upsertUser({ id: 2, username: 'a' });
  const adminCookie = `${SESSION_COOKIE}=${sessionToken(1)}`;
  const userCookie = `${SESSION_COOKIE}=${sessionToken(2)}`;

  // A normal user cannot start acting as anyone.
  assert.equal((await post('/api/admin/act-as', { userId: 1 }, userCookie)).status, 403);

  // The admin starts acting as user 2 and the user API then sees user 2.
  const start = await post('/api/admin/act-as', { userId: 2 }, adminCookie);
  assert.equal(start.status, 200);
  const setCookie = start.headers.getSetCookie().find((c) => c.startsWith(`${ACT_AS_COOKIE}=`));
  assert.ok(setCookie && /HttpOnly/i.test(setCookie));
  const acting = `${adminCookie}; ${setCookie.split(';')[0]}`;
  const me = await (await get('/api/user/credits', acting)).json();
  assert.deepEqual([me.userId, me.isAdmin, me.actingAs], [2, false, true]);

  // Admin routes still use the real admin, so the admin can stop acting.
  assert.equal((await get('/api/admin/users', acting)).status, 200);
  const stop = await post('/api/admin/act-as', { userId: null }, acting);
  assert.equal(stop.status, 200);
  const back = await (await get('/api/user/credits', adminCookie)).json();
  assert.deepEqual([back.userId, back.actingAs], [1, false]);

  // Unknown users are rejected, and a forged or foreign act-as cookie is ignored.
  assert.equal((await post('/api/admin/act-as', { userId: 999 }, adminCookie)).status, 404);
  const forged = `${ACT_AS_COOKIE}=${sign({ t: 'actas', admin: 1, uid: 2, exp: Date.now() + 60000 })}x`;
  assert.equal((await (await get('/api/user/credits', `${adminCookie}; ${forged}`)).json()).userId, 1);
  const valid = `${ACT_AS_COOKIE}=${sign({ t: 'actas', admin: 1, uid: 1, exp: Date.now() + 60000 })}`;
  assert.equal((await (await get('/api/user/credits', `${userCookie}; ${valid}`)).json()).userId, 2); // not the admin's session
});
