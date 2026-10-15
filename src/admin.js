/* ============================================================================
   管理员登录（OAuth）

   游客投稿用小号的 token（见 guest.js），跟这里完全无关。
   这个 OAuth App **只用来确认「你是不是管理员」**，不碰任何仓库，
   所以它申请的权限极小（read:user，只为拿 login）。

   ---- 为什么管理员也要 OAuth，而不是一个密码 ----
   密码要自己管（存哪儿、怎么防爆破、怎么轮换）。OAuth 把这件事交给 GitHub：
   身份由 GitHub 认证，你只要维护一份 ADMIN_LOGIN 白名单。
   而且顺带能证明「确实是那个 GitHub 账号」，不是只知道密码的人。

   ---- 会话怎么维持 ----
   不把 GitHub token 下发给浏览器（没必要，也不安全）。
   校验通过后发一个 **HttpOnly + 签名** 的 cookie，内容是 login。
   签名用 GITHUB_CLIENT_SECRET 做 HMAC 密钥 —— 这样无状态、不用数据库，
   也不用新增一个环境变量。

   ★ 安全原则：ADMIN_LOGIN 没配 → isAdmin() 一律返回 false（失败即拒绝）。
     绝不能因为「配置缺失」就放行。

   ---- 环境变量 ----
     GITHUB_CLIENT_ID       OAuth App 的 Client ID
     GITHUB_CLIENT_SECRET   Client Secret（⚠️ 保密；同时用作会话签名密钥）
     ADMIN_LOGIN            允许进管理页的 GitHub 用户名（逗号分隔可多个）
   ============================================================================ */

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL = 60 * 60 * 12;      // 12 小时

export async function adminRoutes(url, request, env) {
  if (url.pathname === '/api/admin/login') return handleLogin(url, env);
  if (url.pathname === '/api/admin/callback') return handleCallback(request, url, env);
  if (url.pathname === '/api/admin/session') return handleSession(request, env);
  return null;
}

/* ============================================================
   登录入口
   ============================================================ */
function handleLogin(url, env) {
  if (!env.GITHUB_CLIENT_ID) {
    return html(errorPage('服务端还没配好',
      '缺少 <code>GITHUB_CLIENT_ID</code> 环境变量。按 README 配上再试。'), 500);
  }

  const csrf = randomState();
  const nonce = String(url.searchParams.get('nonce') || '').slice(0, 40);

  const auth = new URL(AUTHORIZE);
  auth.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  auth.searchParams.set('redirect_uri', url.origin + '/api/admin/callback');
  // 只要能读到自己是谁。不要 public_repo —— 管理页不需要碰仓库。
  auth.searchParams.set('scope', 'read:user');
  auth.searchParams.set('state', csrf);
  auth.searchParams.set('allow_signup', 'false');

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': `admin_state=${csrf}|${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    }
  });
}

/* ============================================================
   回调：换 token → 查身份 → 验白名单 → 发会话 cookie
   ============================================================ */
async function handleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const clearState = 'admin_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

  if (oauthError) {
    return html(callbackPage({ error: url.searchParams.get('error_description') || oauthError }),
                200, clearState);
  }
  if (!code) {
    return html(callbackPage({ error: 'GitHub 没返回授权码' }), 200, clearState);
  }

  // CSRF 校验
  const saved = readCookie(request, 'admin_state') || '';
  const [savedCsrf, savedNonce] = saved.split('|');
  if (!savedCsrf || savedCsrf !== state) {
    return html(callbackPage({ error: 'state 校验失败，请回管理页重新登录。' }), 200, clearState);
  }

  if (!env.GITHUB_CLIENT_SECRET) {
    return html(callbackPage({ error: '服务端缺少 GITHUB_CLIENT_SECRET。' }), 200, clearState);
  }

  // 换 token
  let data;
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: url.origin + '/api/admin/callback'
      })
    });
    data = await r.json();
  } catch (e) {
    return html(callbackPage({ error: '向 GitHub 换取 token 时网络出错：' + e.message }),
                200, clearState);
  }

  if (!data || !data.access_token) {
    return html(callbackPage({ error: (data && data.error_description) || 'GitHub 没有返回 token' }),
                200, clearState);
  }

  // ★ 立刻查身份并验白名单
  const login = await fetchLogin(data.access_token);
  if (!login) {
    return html(callbackPage({ error: '无法读取你的 GitHub 用户名，请重试' }), 200, clearState);
  }
  if (!isAdmin(login, env)) {
    // 注意：这里**不发**会话 cookie。没通过就是没通过。
    return html(callbackPage({ error: '这个账号（' + login + '）没有管理权限' }), 200, clearState);
  }

  // 通过：发签名会话。token 本身不外传。
  const sess = await signSession(login, Date.now(), env);
  return html(
    callbackPage({ ok: true, login }),
    200,
    `${SESSION_COOKIE}=${sess}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`
  );
}

async function fetchLogin(token) {
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json'
      }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u.login || null;
  } catch (e) {
    return null;
  }
}

/* ============================================================
   会话查询（管理页刷新后用来恢复登录态）
   ============================================================ */
function handleSession(request, env) {
  const login = verifySession(request, env);
  return json({ loggedIn: Boolean(login), login });
}

/**
 * 验证会话 cookie：签名 + 过期 + 仍在白名单。
 * 任何一项不过就返回 null。全部同步 —— HMAC 密钥在 Worker 启动时就备好了。
 */
function verifySession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const [login, ts, sig] = raw.split('.');
  if (!login || !ts || !sig) return null;

  if (!/^\d+$/.test(ts)) return null;
  if (Date.now() - parseInt(ts, 10) > SESSION_TTL * 1000) return null;   // 过期

  // 白名单先查：把你从 ADMIN_LOGIN 删掉后，旧 cookie 立刻失效
  if (!isAdmin(login, env)) return null;

  // 签名是同步 HMAC（见 signSessionMemo）。签名不过 → 未登录。
  const want = signMemo(`${login}.${ts}`, env);
  return timingSafeEqual(want, sig) ? login : null;
}

/**
 * 管理接口的统一入口检查。返回登录名，未登录返回 null。
 * 调用方据此返回 401。
 */
export function requireAdmin(request, env) {
  return verifySession(request, env);
}

/* ============================================================
   白名单与签名
   ============================================================ */
export function isAdmin(login, env) {
  const allow = String(env.ADMIN_LOGIN || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) return false;          // 没配 → 谁都不是管理员（失败即拒绝）
  return allow.includes(String(login || '').toLowerCase());
}

/* ------------------------------------------------------------
   签名工具：同步 HMAC-SHA256

   用 Web Crypto 的 sync 版（signSync），因为会话验证发生在
   每个管理请求的同步路径上。密钥由 GITHUB_CLIENT_SECRET 派生 ——
   不用新增环境变量，也不必把 secret 存进 KV。
   secret 没配时用一个固定的占位串（此时 ADMIN_LOGIN 若也没配，
   isAdmin() 会一律拒绝，所以不会因为这个占位符产生绕过）。
   ------------------------------------------------------------ */
const hmacKeyCache = new Map();

function getHmacKey(env) {
  const secret = env.GITHUB_CLIENT_SECRET || 'no-secret-configured';
  if (hmacKeyCache.has(secret)) return hmacKeyCache.get(secret);

  const key = crypto.subtle.importKeySync
    ? crypto.subtle.importKeySync('raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    : null;
  hmacKeyCache.set(secret, key);
  return key;
}

function signMemo(msg, env) {
  const key = getHmacKey(env);
  if (!key || !crypto.subtle.signSync) return '';   // 拿不到签名能力 → 视为不匹配
  const sig = crypto.subtle.signSync('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 定长比较，避免时序侧信道
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signSession(login, ts, env) {
  const sig = signMemo(`${login}.${ts}`, env);
  if (!sig) throw new Error('无法生成会话签名');
  return `${login}.${ts}.${sig}`;
}

/* ============================================================
   工具
   ============================================================ */
export function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function readCookie(request, name) {
  const raw = (request && request.headers && request.headers.get('Cookie')) || '';
  for (const p of raw.split(';')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    if (p.slice(0, i).trim() === name) return p.slice(i + 1).trim();
  }
  return null;
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export function html(body, status = 200, extraCookie) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (extraCookie) headers['Set-Cookie'] = extraCookie;
  return new Response(body, { status, headers });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function callbackPage({ ok, login, error }) {
  const payload = JSON.stringify({
    type: 'nailong-admin-auth',
    ok: Boolean(ok),
    login: login || null,
    error: error || null
  });

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${error ? '登录失败' : '登录成功'}</title>
<meta name="robots" content="noindex">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b1a;color:#eef1ff;
       font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;text-align:center;padding:20px}
  .box{max-width:460px}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#8b93b8;font-size:14px;line-height:1.8;margin:0}
  .ok{color:#3ddc84}.bad{color:#ff6b60}
  button{margin-top:18px;padding:10px 22px;border-radius:999px;border:0;cursor:pointer;
         background:#fece0e;color:#2a2000;font:inherit;font-weight:700}
</style></head><body>
<div class="box">
  <h1 class="${error ? 'bad' : 'ok'}">${error ? '登录失败' : '登录成功'}</h1>
  <p id="tip">${error ? escapeHtml(error)
    : (login ? '已识别：' + escapeHtml(login) + '。这个窗口会自动关掉。' : '这个窗口会自动关掉。')}</p>
  <button id="closeBtn" type="button" hidden>关掉这个窗口</button>
</div>
<script>
(function () {
  var msg = ${payload};
  try {
    if (window.BroadcastChannel) {
      var ch = new BroadcastChannel('nailong-admin-auth');
      ch.postMessage(msg);
      setTimeout(function () { try { ch.close(); } catch (e) {} }, 500);
    }
  } catch (e) {}
  try {
    if (window.opener && !window.opener.closed) window.opener.postMessage(msg, location.origin);
  } catch (e) {}
  ${error ? '' : `
  setTimeout(function () {
    try { window.close(); } catch (e) {}
    setTimeout(function () {
      var b = document.getElementById('closeBtn');
      if (b && !document.hidden) {
        b.hidden = false;
        document.getElementById('tip').textContent = '回到管理页继续就行，这个窗口可以关掉了。';
      }
    }, 700);
  }, 300);
  `}
})();
</script>
</body></html>`;
}

function errorPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b1a;color:#eef1ff;
font-family:system-ui,sans-serif;padding:24px;text-align:center;line-height:1.8}
code{background:rgba(254,206,14,.18);padding:2px 6px;border-radius:6px;color:#fece0e}</style>
</head><body><div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}