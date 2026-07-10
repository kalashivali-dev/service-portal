import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || 'example.com';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const OAUTH_REDIRECT_URI = `${BASE_URL}/oauth2/callback`;
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const OAUTH_SCOPES = 'openid email profile';
const SESSION_COOKIE_NAME = 'svc_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------
/** @type {Map<string, { user: object, expires: number }>} */
const sessions = new Map();

function createSession(user) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { user, expires: Date.now() + SESSION_TTL_MS });
  return id;
}

function getSession(id) {
  const sess = sessions.get(id);
  if (!sess) return null;
  if (sess.expires < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return sess;
}

function deleteSession(id) {
  sessions.delete(id);
}

// ---------------------------------------------------------------------------
// OAuth state anti-forgery tokens
// ---------------------------------------------------------------------------
const oauthStates = new Map(); // state -> expiry

function createOAuthState() {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 5 * 60 * 1000); // 5-min expiry
  return state;
}

function validateOAuthState(state) {
  const expiry = oauthStates.get(state);
  oauthStates.delete(state);
  return expiry && expiry > Date.now();
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(p => {
      const [k, ...v] = p.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    }).filter(([k]) => k)
  );
}

function setSessionCookie(res, sessionId) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/`
  ]);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
  ]);
}

// ---------------------------------------------------------------------------
// Resolve the session from an incoming request
// ---------------------------------------------------------------------------
function resolveUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;
  const sess = getSession(sessionId);
  return sess ? { sessionId, user: sess.user } : null;
}

// ---------------------------------------------------------------------------
// HTTPS helper — make a JSON request using native https
// ---------------------------------------------------------------------------
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Static file MIME types
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    const mime = getMime(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJSON(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------
let config = { staff: [], allowedDomain: ALLOWED_DOMAIN };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'services.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  config = { ...parsed, allowedDomain: ALLOWED_DOMAIN }; // env var always wins
} catch (e) {
  console.warn('Could not load data/services.json, using defaults:', e.message);
}

// ---------------------------------------------------------------------------
// Mock cases data
// ---------------------------------------------------------------------------
const MOCK_CASES = [
  { id: 'SVC-001', title: 'Network switch offline in Building A', status: 'Open', assignedTo: 'Jordan Lee', priority: 'P1', date: '2026-07-08' },
  { id: 'SVC-002', title: 'Printer queue stuck on Floor 3', status: 'In Progress', assignedTo: 'Sam Patel', priority: 'P3', date: '2026-07-07' },
  { id: 'SVC-003', title: 'VPN access request for new contractor', status: 'Resolved', assignedTo: 'Jordan Lee', priority: 'P4', date: '2026-07-06' },
  { id: 'SVC-004', title: 'Email delivery delays for ops team', status: 'Open', assignedTo: 'Alex Rivera', priority: 'P2', date: '2026-07-08' },
  { id: 'SVC-005', title: 'Conference room AV system broken', status: 'In Progress', assignedTo: 'Sam Patel', priority: 'P3', date: '2026-07-05' },
  { id: 'SVC-006', title: 'Laptop battery replacement request', status: 'Resolved', assignedTo: 'Jordan Lee', priority: 'P4', date: '2026-07-04' },
  { id: 'SVC-007', title: 'SSO login loop for marketing tools', status: 'Open', assignedTo: 'Alex Rivera', priority: 'P2', date: '2026-07-09' },
  { id: 'SVC-008', title: 'Onboarding access for Morgan Chen', status: 'Resolved', assignedTo: 'Alex Rivera', priority: 'P4', date: '2026-07-03' },
];

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// GET /login — redirect to Google OAuth
function handleLogin(req, res) {
  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — Service Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1d27;
      border: 1px solid #2d3148;
      border-radius: 16px;
      padding: 48px 40px;
      width: 100%;
      max-width: 400px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo {
      width: 56px; height: 56px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 14px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 24px;
      font-size: 24px; font-weight: 700; color: #fff;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; }
    p { color: #94a3b8; font-size: 14px; margin-bottom: 32px; }
    .btn-google {
      display: inline-flex; align-items: center; gap: 12px;
      background: #fff; color: #1f2937;
      border: none; border-radius: 10px;
      padding: 14px 24px;
      font-family: 'DM Sans', sans-serif;
      font-size: 15px; font-weight: 500;
      cursor: pointer; text-decoration: none;
      width: 100%; justify-content: center;
      transition: background 0.15s, box-shadow 0.15s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    }
    .btn-google:hover { background: #f1f5f9; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .btn-google svg { flex-shrink: 0; }
    .note { margin-top: 20px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">S</div>
    <h1>Service Portal</h1>
    <p>Sign in with your company Google account to continue.</p>
    <a href="${OAUTH_AUTH_URL}?${params.toString()}" class="btn-google">
      <svg width="20" height="20" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Sign in with Google
    </a>
    <p class="note">Access restricted to @${ALLOWED_DOMAIN} accounts.</p>
  </div>
</body>
</html>`;

  sendText(res, 200, loginHtml, 'text/html; charset=utf-8');
}

// GET /oauth2/callback — exchange code for token, create session
async function handleOAuthCallback(req, res, searchParams) {
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return sendText(res, 400, `OAuth error: ${error}`);
  }

  if (!code || !state || !validateOAuthState(state)) {
    return sendRedirect(res, '/login');
  }

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  let tokenResp;
  try {
    tokenResp = await httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(tokenBody),
        },
      },
      tokenBody
    );
  } catch (err) {
    console.error('Token exchange error:', err);
    return sendRedirect(res, '/login?error=token_exchange');
  }

  if (tokenResp.status !== 200 || !tokenResp.body.access_token) {
    console.error('Token exchange failed:', tokenResp.body);
    return sendRedirect(res, '/login?error=token_failed');
  }

  const accessToken = tokenResp.body.access_token;

  // Fetch user info
  let userResp;
  try {
    userResp = await httpsRequest({
      hostname: 'www.googleapis.com',
      path: '/oauth2/v3/userinfo',
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    console.error('Userinfo error:', err);
    return sendRedirect(res, '/login?error=userinfo');
  }

  if (userResp.status !== 200 || !userResp.body.email) {
    return sendRedirect(res, '/login?error=userinfo_failed');
  }

  const user = userResp.body;
  const emailDomain = (user.email || '').split('@')[1] || '';
  const allowed = ALLOWED_DOMAIN;

  if (emailDomain !== allowed) {
    return sendText(
      res, 403,
      `Access denied. Only @${allowed} accounts are permitted.`
    );
  }

  const sessionId = createSession({
    name: user.name || user.email,
    email: user.email,
    picture: user.picture || '',
    sub: user.sub,
  });

  setSessionCookie(res, sessionId);
  sendRedirect(res, '/');
}

// GET /logout
function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId) deleteSession(sessionId);
  clearSessionCookie(res);
  sendRedirect(res, '/login');
}

// GET /api/me
function handleApiMe(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });
  const { name, email, picture } = auth.user;
  sendJSON(res, 200, { name, email, picture });
}

// GET /api/cases
function handleApiCases(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });
  sendJSON(res, 200, MOCK_CASES);
}

// GET /api/stats
function handleApiStats(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  const open = MOCK_CASES.filter(c => c.status === 'Open').length;
  const inProgress = MOCK_CASES.filter(c => c.status === 'In Progress').length;
  const resolved = MOCK_CASES.filter(c => c.status === 'Resolved').length;
  const totalStaff = config.staff ? config.staff.length : 0;

  sendJSON(res, 200, { open, inProgress, resolved, totalStaff });
}

// GET /api/wiki/* — serve raw markdown
function handleApiWiki(req, res, wikiPath) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  // Sanitize path — no traversal
  const safe = path.normalize(wikiPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(__dirname, 'wiki', safe);

  // Must stay inside wiki/
  if (!filePath.startsWith(path.join(__dirname, 'wiki'))) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  if (!fs.existsSync(filePath)) {
    return sendJSON(res, 404, { error: 'Article not found' });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    sendText(res, 200, content, 'text/plain; charset=utf-8');
  } catch {
    sendJSON(res, 500, { error: 'Could not read article' });
  }
}

// GET /healthz
function handleHealthz(req, res) {
  sendJSON(res, 200, { status: 'ok' });
}

// GET / — serve index.html (auth-gated)
function handleIndex(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendRedirect(res, '/login');
  sendFile(res, path.join(__dirname, 'index.html'));
}

// Fallback static file server
function handleStatic(req, res, urlPath) {
  // Never serve .env or sensitive files
  if (/\.(env|secret|key)$/i.test(urlPath)) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  const safe = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(__dirname, safe);

  // Must stay within project root
  if (!filePath.startsWith(__dirname)) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJSON(res, 404, { error: 'Not found' });
  }

  sendFile(res, filePath);
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
async function requestHandler(req, res) {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS headers for API calls (same-origin in production, useful in dev)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (method !== 'GET' && method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (pathname === '/login') return handleLogin(req, res);
    if (pathname === '/oauth2/callback') return await handleOAuthCallback(req, res, parsedUrl.searchParams);
    if (pathname === '/logout') return handleLogout(req, res);
    if (pathname === '/healthz') return handleHealthz(req, res);
    if (pathname === '/api/me') return handleApiMe(req, res);
    if (pathname === '/api/cases') return handleApiCases(req, res);
    if (pathname === '/api/stats') return handleApiStats(req, res);
    if (pathname.startsWith('/api/wiki/')) {
      const wikiFile = pathname.slice('/api/wiki/'.length);
      return handleApiWiki(req, res, wikiFile);
    }
    if (pathname === '/' || pathname === '/index.html') return handleIndex(req, res);

    // Static file fallback
    return handleStatic(req, res, pathname);
  } catch (err) {
    console.error('Unhandled error for', pathname, err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(`Service Portal running on http://localhost:${PORT}`);
  console.log(`Allowed domain: ${config.allowedDomain || ALLOWED_DOMAIN}`);
  console.log(`OAuth redirect: ${OAUTH_REDIRECT_URI}`);
  if (!GOOGLE_CLIENT_ID) {
    console.warn('Warning: GOOGLE_CLIENT_ID is not set. OAuth will not work.');
  }
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
