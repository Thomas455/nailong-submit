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

  // 投稿页那条「用 GitHub 登录」的路。同一个 OAuth App，但 scope 不同，
  // 而且要把 token 交回前端（得用它 fork + 提 PR）。
  // 故意和 /api/admin/* 分开：管理员那条只要 read:user，不碰仓库。
  if (url.pathname === '/api/login') return handleSubmitLogin(url, env);
  if (url.pathname === '/api/callback') return handleSubmitCallback(request, url, env);

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
   投稿页的 GitHub 登录（和上面的管理员登录是两回事）

   管理员那条：只要 read:user，验完白名单发个会话 cookie，token 不外传。
   这一条：要 public_repo（fork + 推内容 + 提 PR 是最低要求），
            并且 token 必须交回前端 —— 因为提 PR 是在浏览器里做的。

   用同一个 OAuth App：GitHub 的一个 App 只能配一个回调地址，
   所以两条路共用 /api/callback 的思路，但 state cookie 和 scope 分开。
   ============================================================ */
function handleSubmitLogin(url, env) {
  if (!env.GITHUB_CLIENT_ID) {
    return html(errorPage('服务端还没配好',
      '缺少 <code>GITHUB_CLIENT_ID</code> 环境变量。'), 500);
  }

  const csrf = randomState();
  const nonce = String(url.searchParams.get('nonce') || '').slice(0, 40);

  const auth = new URL(AUTHORIZE);
  auth.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  auth.searchParams.set('redirect_uri', url.origin + '/api/callback');
  auth.searchParams.set('scope', 'public_repo');   // fork + 提 PR 的最低要求
  auth.searchParams.set('state', csrf);
  auth.searchParams.set('allow_signup', 'true');

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': `submit_state=${csrf}|${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    }
  });
}

async function handleSubmitCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const clearState = 'submit_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

  if (oauthError) {
    return html(oidcPage({ error: url.searchParams.get('error_description') || oauthError }),
                200, clearState);
  }
  if (!code) {
    return html(oidcPage({ error: 'GitHub 没返回授权码' }), 200, clearState);
  }

  const saved = readCookie(request, 'submit_state') || '';
  const [savedCsrf, savedNonce] = saved.split('|');
  if (!savedCsrf || !timingSafeEqual(savedCsrf, state)) {
    return html(oidcPage({ error: 'state 校验失败，请回投稿页重新登录。' }), 200, clearState);
  }

  let data;
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: url.origin + '/api/callback'
      })
    });
    data = await r.json();
  } catch (e) {
    return html(oidcPage({ error: '向 GitHub 换取 token 时网络出错：' + e.message }),
                200, clearState);
  }

  if (!data || !data.access_token) {
    return html(oidcPage({ error: (data && data.error_description) || 'GitHub 没有返回 token' }),
                200, clearState);
  }

  // 把 token 交回投稿页（只在这一步出现，走 postMessage 不进 URL/日志）
  return html(oidcPage({ token: data.access_token, scope: data.scope, nonce: savedNonce || '' }),
              200, clearState);
}

// 投稿页的回调页：用 BroadcastChannel + opener 双通道回传 token
function oidcPage({ token, scope, nonce, error }) {
  const payload = JSON.stringify({
    type: 'nailong-oauth',
    token: token || null,
    scope: scope || null,
    nonce: nonce || '',
    error: error || null
  });

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${error ? '授权失败' : '授权成功'}</title>
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
  <h1 class="${error ? 'bad' : 'ok'}">${error ? '授权没成功' : '授权成功'}</h1>
  <p id="tip">${error ? escapeHtml(error) : '这个窗口会自动关掉，回去继续投稿。'}</p>
  <button id="closeBtn" type="button" hidden>关掉这个窗口</button>
</div>
<script>
(function () {
  var msg = ${payload};
  try {
    if (window.BroadcastChannel) {
      var ch = new BroadcastChannel('nailong-oauth');
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
        document.getElementById('tip').textContent = '回到投稿页继续就行，这个窗口可以关掉了。';
      }
    }, 700);
  }, 300);
  `}
})();
</script>
</body></html>`;
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
    // 把真实原因记进 Worker 日志（Cloudflare Dashboard → 实时日志 能看到），
    // 页面上只给笼统提示。到底是 401 还是网络问题，日志里能看出来。
    console.error('admin login: fetchLogin 失败',
      'token 前缀=', String(data.access_token).slice(0, 7),
      'scope=', data.scope);
    return html(callbackPage({
      error: '无法读取你的 GitHub 用户名，可能是网络问题或授权被撤回。请重试；' +
             '若一直失败请看 Worker 日志。'
    }), 200, clearState);
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
        Accept: 'application/vnd.github+json',
        'User-Agent': 'nailong-submit-worker'
      }
    });
    if (!r.ok) {
      console.error('fetchLogin: GitHub 返回', r.status,
        await r.text().then(t => t.slice(0, 200)).catch(() => ''));
      return null;
    }
    const u = await r.json();
    return u.login || null;
  } catch (e) {
    console.error('fetchLogin: 请求异常', e && e.message);
    return null;
  }
}

/* ============================================================
   会话查询（管理页刷新后用来恢复登录态）
   ============================================================ */
async function handleSession(request, env) {
  const login = await verifySession(request, env);
  return json({ loggedIn: Boolean(login), login });
}

/**
 * 验证会话 cookie：签名 + 过期 + 仍在白名单。任一项不过返回 null。
 *
 * ⚠️ 这里是 **async** 的。原来用 crypto.subtle 的同步版（importKeySync/signSync）
 * 来做同步签名，但那两个 API 是比较新的，Workers 运行时上不一定有 ——
 * 线上就因为拿不到签名而 500 了。改用标准的异步 Web Crypto（到处都支持）。
 */
async function verifySession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const [login, ts, sig] = raw.split('.');
  if (!login || !ts || !sig) return null;

  if (!/^\d+$/.test(ts)) return null;
  if (Date.now() - parseInt(ts, 10) > SESSION_TTL * 1000) return null;   // 过期

  // 白名单先查：把你从 ADMIN_LOGIN 删掉后，旧 cookie 立刻失效
  if (!isAdmin(login, env)) return null;

  const want = await hmac(`${login}.${ts}`, env);
  return timingSafeEqual(want, sig) ? login : null;
}

/**
 * 管理接口的统一入口检查。返回登录名，未登录返回 null。
 * 调用方据此返回 401。
 *
 * 注意是 async —— 调它的地方都要 await。
 */
export async function requireAdmin(request, env) {
  return await verifySession(request, env);
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
   签名工具：HMAC-SHA256（标准异步 Web Crypto）

   密钥由 GITHUB_CLIENT_SECRET 派生 —— 不用新增环境变量。
   secret 没配时用一个固定的占位串（此时若 ADMIN_LOGIN 也没配，
   isAdmin() 会一律拒绝，所以不会因为这个占位符产生绕过）。

   ⚠️ 不要改回 crypto.subtle 的 **同步** 版（importKeySync / signSync）。
   那两个 API 比较新，Workers 运行时上不一定有；线上就因为拿不到签名
   导致 signSession 抛错、整个登录 500。标准异步版到处都支持。
   ------------------------------------------------------------ */
const hmacKeyCache = new Map();

async function getHmacKey(env) {
  const secret = env.GITHUB_CLIENT_SECRET || 'no-secret-configured';
  if (hmacKeyCache.has(secret)) return hmacKeyCache.get(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  hmacKeyCache.set(secret, key);
  return key;
}

// 返回小写十六进制签名
async function hmac(msg, env) {
  const key = await getHmacKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 恒定时间字符串比较。
//
// 会话 cookie 的 HMAC 校验、以及 OAuth state 的比对都走这里 ——
// 用 !== 比对理论上会给时序侧信道留缝（攻击者靠响应时间差异逐字节猜）。
// 实际上 HTTP 层的抖动远大于这点差异，几乎不可能利用，
// 但这是安全审查的通用要求，改起来也就几行。
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signSession(login, ts, env) {
  const sig = await hmac(`${login}.${ts}`, env);
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