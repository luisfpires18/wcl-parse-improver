// The session cookie is the whole access-control boundary: whatever it says the
// user is, that is whose characters the API hands back. So the tests that matter
// are the negative ones — a forged or tampered cookie must buy nothing.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Set before the import below: session.js resolves its store path at load time,
// and it must not be the running app's.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'wcl-sessions-'));
process.env.WCL_DATA_DIR = DATA_DIR;
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const {
  SESSION_COOKIE,
  STATE_COOKIE,
  createSession,
  getSession,
  destroySession,
  requireSession,
  issueState,
  consumeState,
} = await import('../server/session.js');

process.env.SESSION_SECRET = 'test-secret';

// Minimal express req/res stand-ins — we only touch headers and Set-Cookie.
const mkRes = () => {
  const cookies = [];
  return {
    cookies,
    statusCode: 200,
    body: null,
    append: (_h, v) => cookies.push(v),
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
};

/** Read a cookie's value out of the Set-Cookie headers a response collected. */
const cookieFrom = (res, name) => {
  const header = [...res.cookies].reverse().find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
};

const mkReq = (cookies = {}) => ({
  headers: {
    cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('; '),
  },
});

const signIn = (userId = '4242') => {
  const res = mkRes();
  createSession(res, {
    userId,
    name: 'Tester',
    avatar: null,
    accessToken: 'wcl-token',
    tokenExpiresAt: Date.now() + 3600_000,
  });
  return cookieFrom(res, SESSION_COOKIE);
};

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret';
});

test('a signed-in cookie round-trips to the right user', () => {
  const cookie = signIn('4242');
  const session = getSession(mkReq({ [SESSION_COOKIE]: cookie }));
  assert.equal(session.userId, '4242');
  assert.equal(session.accessToken, 'wcl-token');
});

test('the access token never leaves the server — the cookie is an opaque id', () => {
  const res = mkRes();
  createSession(res, {
    userId: '4242',
    name: 'Tester',
    avatar: null,
    accessToken: 'super-secret-wcl-token',
    tokenExpiresAt: Date.now() + 3600_000,
  });
  assert.ok(!res.cookies.join(';').includes('super-secret-wcl-token'));
});

test('no cookie, a made-up id, or a tampered signature all get nothing', () => {
  const cookie = signIn('4242');
  const [id, sig] = cookie.split('.');

  assert.equal(getSession(mkReq()), null, 'no cookie');
  assert.equal(getSession(mkReq({ [SESSION_COOKIE]: 'deadbeef.cafe' })), null, 'invented id');
  assert.equal(getSession(mkReq({ [SESSION_COOKIE]: id })), null, 'no signature at all');
  assert.equal(getSession(mkReq({ [SESSION_COOKIE]: `${id}.${'0'.repeat(sig.length)}` })), null, 'wrong signature');

  // The attack that matters: keep a valid signature, swap the id it signs.
  assert.equal(getSession(mkReq({ [SESSION_COOKIE]: `deadbeef.${sig}` })), null, 'signature of another id');
});

test('changing SESSION_SECRET invalidates every cookie already out there', () => {
  const cookie = signIn('4242');
  assert.ok(getSession(mkReq({ [SESSION_COOKIE]: cookie })));

  process.env.SESSION_SECRET = 'a-different-secret';
  assert.equal(getSession(mkReq({ [SESSION_COOKIE]: cookie })), null);
});

test('signing out drops the session, so the same cookie stops working', () => {
  const cookie = signIn('4242');
  const req = mkReq({ [SESSION_COOKIE]: cookie });
  destroySession(req, mkRes());
  assert.equal(getSession(mkReq({ [SESSION_COOKIE]: cookie })), null);
});

test('requireSession 401s without a session and attaches it with one', () => {
  const res = mkRes();
  let nexted = false;
  requireSession(mkReq(), res, () => (nexted = true));
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Not signed in' });

  const cookie = signIn('4242');
  const req = mkReq({ [SESSION_COOKIE]: cookie });
  const ok = mkRes();
  requireSession(req, ok, () => (nexted = true));
  assert.equal(nexted, true);
  assert.equal(req.session.userId, '4242');
});

// The OAuth `state` check is what stops a third party from feeding this browser
// a callback for a login it never started.
test('a state token is accepted once, and only the one we issued', () => {
  const res = mkRes();
  const state = issueState(res);
  const cookie = cookieFrom(res, STATE_COOKIE);

  assert.equal(consumeState(mkReq({ [STATE_COOKIE]: cookie }), mkRes(), 'not-the-state'), false);
  assert.equal(consumeState(mkReq(), mkRes(), state), false, 'no cookie to compare against');
  assert.equal(consumeState(mkReq({ [STATE_COOKIE]: cookie }), mkRes(), state), true);
});

test('a state cookie with a forged signature is refused', () => {
  const res = mkRes();
  const state = issueState(res);
  const forged = `${state}.${'0'.repeat(64)}`;
  assert.equal(consumeState(mkReq({ [STATE_COOKIE]: forged }), mkRes(), state), false);
});
