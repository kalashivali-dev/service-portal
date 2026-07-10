import assert from 'node:assert/strict';
import http from 'node:http';
import { requestHandler } from './server.js';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// HTTP helper — make a request to the test server
// ---------------------------------------------------------------------------
let server;
let baseUrl;

function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Start test server
// ---------------------------------------------------------------------------
async function setup() {
  server = http.createServer(requestHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function teardown() {
  await new Promise(resolve => server.close(resolve));
}

// ---------------------------------------------------------------------------
// Helper: create an authenticated session cookie via internal API
// ---------------------------------------------------------------------------
async function makeSessionCookie() {
  const { createTestSession } = await import('./server.js');
  const sessionId = createTestSession({
    name: 'Test User',
    email: 'test@sycamoreinformatics.com',
    picture: '',
    sub: 'test-sub-123',
  });
  return `svc_session=${sessionId}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
await setup();

console.log('\nHealth check');
await test('GET /healthz returns 200 with status ok', async () => {
  const res = await request('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.json?.status, 'ok');
});

console.log('\nLogin page');
await test('GET /login returns 200 HTML', async () => {
  const res = await request('/login');
  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type']?.includes('text/html'));
});
await test('GET /login page contains Sycamore Informatics branding', async () => {
  const res = await request('/login');
  assert.ok(res.body.includes('Sycamore Informatics'), 'Missing Sycamore Informatics text');
});
await test('GET /login page contains Sign in with Google button', async () => {
  const res = await request('/login');
  assert.ok(res.body.includes('Sign in with Google'), 'Missing Google sign-in button');
});
await test('GET /login page references allowed domain', async () => {
  const res = await request('/login');
  assert.ok(res.body.includes('sycamoreinformatics.com') || res.body.includes('example.com'));
});

console.log('\nAuth gating');
await test('GET / without session redirects to /login', async () => {
  const res = await request('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});
await test('GET /api/me without session returns 401', async () => {
  const res = await request('/api/me');
  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'Unauthorized');
});
await test('GET /api/cases without session returns 401', async () => {
  const res = await request('/api/cases');
  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'Unauthorized');
});
await test('GET /api/stats without session returns 401', async () => {
  const res = await request('/api/stats');
  assert.equal(res.status, 401);
  assert.equal(res.json?.error, 'Unauthorized');
});
await test('GET /api/wiki/index.md without session returns 401', async () => {
  const res = await request('/api/wiki/index.md');
  assert.equal(res.status, 401);
});

console.log('\nAuthenticated endpoints');
const cookie = await makeSessionCookie();
await test('GET /api/me with valid session returns user info', async () => {
  const res = await request('/api/me', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json?.name, 'Test User');
  assert.equal(res.json?.email, 'test@sycamoreinformatics.com');
  assert.ok(!('sub' in (res.json || {})), 'sub should not be exposed');
});
await test('GET /api/cases with valid session returns array', async () => {
  const res = await request('/api/cases', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  assert.ok(res.json.length > 0);
});
await test('GET /api/cases each case has required fields', async () => {
  const res = await request('/api/cases', { headers: { Cookie: cookie } });
  for (const c of res.json) {
    assert.ok(c.id, 'missing id');
    assert.ok(c.title, 'missing title');
    assert.ok(c.status, 'missing status');
    assert.ok(c.priority, 'missing priority');
  }
});
await test('GET /api/stats with valid session returns counts', async () => {
  const res = await request('/api/stats', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.ok(typeof res.json?.open === 'number');
  assert.ok(typeof res.json?.inProgress === 'number');
  assert.ok(typeof res.json?.resolved === 'number');
});
await test('GET /api/stats counts add up correctly', async () => {
  const cases = (await request('/api/cases', { headers: { Cookie: cookie } })).json;
  const stats = (await request('/api/stats', { headers: { Cookie: cookie } })).json;
  assert.equal(stats.open, cases.filter(c => c.status === 'Open').length);
  assert.equal(stats.inProgress, cases.filter(c => c.status === 'In Progress').length);
  assert.equal(stats.resolved, cases.filter(c => c.status === 'Resolved').length);
});

console.log('\nLogout');
await test('GET /logout clears session and redirects to /login', async () => {
  const res = await request('/logout', { headers: { Cookie: cookie } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
  const setCookie = res.headers['set-cookie']?.[0] || '';
  assert.ok(setCookie.includes('Max-Age=0'), 'session cookie not cleared');
});
await test('Session is invalid after logout', async () => {
  const logoutCookie = await makeSessionCookie();
  await request('/logout', { headers: { Cookie: logoutCookie } });
  const res = await request('/api/me', { headers: { Cookie: logoutCookie } });
  assert.equal(res.status, 401);
});

console.log('\nOAuth callback');
await test('GET /oauth2/callback with no params redirects to /login', async () => {
  const res = await request('/oauth2/callback');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});
await test('GET /oauth2/callback with error param returns 400', async () => {
  const res = await request('/oauth2/callback?error=access_denied');
  assert.equal(res.status, 400);
});
await test('GET /oauth2/callback with invalid state redirects to /login', async () => {
  const res = await request('/oauth2/callback?code=abc&state=invalid_state');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

console.log('\nSecurity');
await test('GET sensitive .env file returns 403', async () => {
  const res = await request('/.env');
  assert.equal(res.status, 403);
});
await test('Path traversal attempt returns 403 or 404', async () => {
  const res = await request('/../../etc/passwd');
  assert.ok([403, 404].includes(res.status));
});
await test('Wiki path traversal returns 403', async () => {
  const res = await request('/api/wiki/../server.js', { headers: { Cookie: cookie } });
  assert.ok([403, 404].includes(res.status));
});
await test('POST method returns 405', async () => {
  const res = await request('/healthz', { method: 'POST' });
  assert.equal(res.status, 405);
});
await test('X-Content-Type-Options header is set', async () => {
  const res = await request('/healthz');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});
await test('X-Frame-Options header is set', async () => {
  const res = await request('/healthz');
  assert.equal(res.headers['x-frame-options'], 'DENY');
});

console.log('\nNot found');
await test('GET unknown route returns 404', async () => {
  const res = await request('/this-does-not-exist');
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
await teardown();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Tests FAILED — aborting deploy.');
  process.exit(1);
}
console.log('All tests passed.');
