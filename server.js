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
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: #0d1117;
      color: #f0f6fc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .login-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      padding: 40px;
      border: 1px solid rgba(240,246,252,.12);
      border-radius: 12px;
      background: #161b22;
      text-align: center;
    }
    .logo {
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .logo-icon {
      width: 44px; height: 44px;
      background: linear-gradient(135deg, #1a6fc4, #0ea5e9);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 800; color: #fff;
      letter-spacing: -0.5px;
      flex-shrink: 0;
    }
    .logo-text {
      text-align: left;
    }
    .logo-name {
      font-size: 15px;
      font-weight: 600;
      color: #f0f6fc;
      line-height: 1.2;
    }
    .logo-sub {
      font-size: 11px;
      color: #8b949e;
      margin-top: 2px;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { margin: 0 0 32px; color: #8b949e; font-size: 14px; line-height: 1.5; }
    .btn-google {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      min-height: 48px; padding: 0 24px;
      border-radius: 6px;
      background: #238636; color: #fff;
      text-decoration: none;
      font-family: Inter, sans-serif;
      font-weight: 600; font-size: 15px;
      width: 100%;
      transition: background 0.2s;
    }
    .btn-google:hover { background: #2ea043; }
    .btn-google svg { flex-shrink: 0; }
    .note { margin-top: 20px; font-size: 12px; color: #8b949e; }
    footer {
      padding: 20px;
      text-align: center;
      color: #8b949e;
      font-size: 12px;
      border-top: 1px solid rgba(240,246,252,.08);
      font-family: Inter, sans-serif;
    }
    .footer-inner {
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .footer-logo-icon {
      width: 18px; height: 18px;
      background: linear-gradient(135deg, #1a6fc4, #0ea5e9);
      border-radius: 4px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 9px; font-weight: 800; color: #fff;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <main>
      <div class="logo">
        <div class="logo-icon">SI</div>
        <div class="logo-text">
          <div class="logo-name">Sycamore Informatics</div>
          <div class="logo-sub">Service Operations Portal</div>
        </div>
      </div>
      <h1>Service Portal</h1>
      <p class="subtitle">Sign in with your ${ALLOWED_DOMAIN} Google account to continue.</p>
      <a href="${OAUTH_AUTH_URL}?${params.toString()}" class="btn-google">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/></svg>
        Sign in with Google
      </a>
      <p class="note">Access restricted to @${ALLOWED_DOMAIN} accounts.</p>
    </main>
  </div>
  <footer>
    <div class="footer-inner">
      <span>Powered by</span>
      <div class="footer-logo-icon">SI</div>
      <span>Sycamore Informatics</span>
    </div>
  </footer>
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
