/* ============================================================================
   OAuth 代理（Cloudflare Worker）

   整个投稿站只有这一小块需要服务端，就干一件事：
   把 GitHub 授权码换成 access token。

   ---- 为什么必须有这一块 ----
   OAuth 换 token 时要带上 client_secret。client_secret 一旦放进前端代码，
   等于公开 —— 任何人都能拿它冒充你的应用、诱导别人授权。
   所以这一步躲不开服务端。

   ---- token 怎么交回前端 ----
   换到 token 后不能用 302 带着它跳回前端（token 会进浏览器历史、Referer、
   服务器日志）。这里用 postMessage：回调页把 token 发给开它的那个窗口，
   然后自己立刻关闭。

   ---- 环境变量（在 Cloudflare 里配，别写进代码）----
     GITHUB_CLIENT_ID       OAuth App 的 Client ID（公开无妨）
     GITHUB_CLIENT_SECRET   OAuth App 的 Client Secret（⚠️ 必须保密）
   ============================================================================ */

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const STATE_COOKIE = 'oauth_state';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/config') return handleConfig(env);
    if (url.pathname === '/api/login') return handleLogin(url, env);
    if (url.pathname === '/api/callback') return handleCallback(request, url, env);

    // 其余交给静态资源
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
};

function handleConfig(env) {
  // client_id 是公开值，可以下发；client_secret 绝不下发
  return json({
    clientId: env.GITHUB_CLIENT_ID || '',
    ready: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
  });
}

function handleLogin(url, env) {
  if (!env.GITHUB_CLIENT_ID) {
    return html(errorPage('服务端还没配好',
      '缺少 <code>GITHUB_CLIENT_ID</code> 环境变量。按 README 配上再试。'), 500);
  }

  // state 防 CSRF：授权回来后校验它和发出去的一致。
  // 存进 cookie（HttpOnly + Secure + SameSite=Lax），不用数据库。
  const csrf = randomState();

  // nonce 用来「认领」：投稿页开的那个窗口放一个随机串，
  // 授权完带回来，页面对上了才收 token。
  // 不是安全边界（token 本来就回同源页面），纯粹避免多标签页时串台。
  const nonce = String(url.searchParams.get('nonce') || '').slice(0, 40);

  const auth = new URL(AUTHORIZE);
  auth.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  auth.searchParams.set('redirect_uri', url.origin + '/api/callback');
  // scope 固定成 public_repo —— 不从前端读，免得被构造成申请超权限的链接
  auth.searchParams.set('scope', 'public_repo');
  auth.searchParams.set('state', csrf);
  auth.searchParams.set('allow_signup', 'true');

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      // csrf 和 nonce 一起塞进 cookie，用 | 分隔
      'Set-Cookie': `${STATE_COOKIE}=${csrf}|${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    }
  });
}

async function handleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  const clearCookie = `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

  if (oauthError) {
    return html(callbackPage({
      error: url.searchParams.get('error_description') || oauthError
    }), 200, clearCookie);
  }
  if (!code) {
    return html(callbackPage({ error: 'GitHub 没返回授权码' }), 200, clearCookie);
  }

  // 校验 state（cookie 里是 "csrf|nonce" 两段）
  const saved = readCookie(request, STATE_COOKIE) || '';
  const [savedCsrf, savedNonce] = saved.split('|');
  if (!savedCsrf || savedCsrf !== state) {
    return html(callbackPage({
      error: 'state 校验失败（授权链接可能被伪造，或者 cookie 被清了）。请回投稿页重新登录。'
    }), 200, clearCookie);
  }

  if (!env.GITHUB_CLIENT_SECRET) {
    return html(callbackPage({
      error: '服务端缺少 GITHUB_CLIENT_SECRET，没法换取 token。'
    }), 200, clearCookie);
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
        redirect_uri: url.origin + '/api/callback'
      })
    });
    data = await r.json();
  } catch (e) {
    return html(callbackPage({ error: '向 GitHub 换取 token 时网络出错：' + e.message }),
                200, clearCookie);
  }

  if (!data || !data.access_token) {
    return html(callbackPage({
      error: (data && data.error_description) || 'GitHub 没有返回 token'
    }), 200, clearCookie);
  }

  return html(callbackPage({
    token: data.access_token,
    scope: data.scope,
    nonce: savedNonce || ''
  }), 200, clearCookie);
}

/* ---------- 小工具 ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 从请求头里读一个 cookie
function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const parts = raw.split(';');
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    if (p.slice(0, i).trim() === name) return p.slice(i + 1).trim();
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function html(body, status = 200, extraCookie) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (extraCookie) headers['Set-Cookie'] = extraCookie;
  return new Response(body, { status, headers });
}

/* ---------- 页面 ---------- */

function callbackPage({ token, scope, error, nonce }) {
  // token 通过两条通道回传给投稿页，都不写进 URL、不写进日志：
  //
  //   1. BroadcastChannel —— 同源窗口之间通信，**不依赖 window.opener**。
  //      这是主通道：GitHub 的授权页如果带了 Cross-Origin-Opener-Policy，
  //      opener 引用会被浏览器切断，postMessage 就发不出去了。
  //   2. window.opener.postMessage —— 后备，给不支持 BroadcastChannel 的老浏览器。
  //
  // 两条通道都只发给同源页面（BroadcastChannel 天然同源隔离；
  // postMessage 用 location.origin 而不是 '*'，避免误发给别的站）。
  // 回调页和投稿页同源，所以直接用 location.origin 就行。
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

  // 主通道：BroadcastChannel（不依赖 opener）
  try {
    if (window.BroadcastChannel) {
      var ch = new BroadcastChannel('nailong-oauth');
      ch.postMessage(msg);
      setTimeout(function () { try { ch.close(); } catch (e) {} }, 500);
    }
  } catch (e) {}

  // 后备：opener postMessage（只在同源时发）
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, location.origin);
    }
  } catch (e) {}
  ${error ? '' : `
  // 自动关掉。有些浏览器不允许脚本关闭「不是脚本开的」窗口，
  // 所以要给一个手动关闭的兜底 —— 否则用户会看到一个关不掉的页面。
  setTimeout(function () {
    try { window.close(); } catch (e) {}
    setTimeout(function () {
      var b = document.getElementById('closeBtn');
      if (b && !document.hidden) {
        b.hidden = false;
        document.getElementById('tip').textContent = '回去继续投稿就行，这个窗口可以关掉了。';
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
