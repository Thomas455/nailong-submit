/* ============================================================================
   小号绑定：用 OAuth 换 token，加密存起来，之后服务器代提交

   为什么不用 fine-grained PAT
   ----------------------------
   PAT 的 "Only select repositories" **只能选 token 拥有者自己的仓库**。
   小号只有它自己的 fork，选不到主仓库（Thomas455/nailong-university），
   于是主仓库的所有写操作都是 403。这是 PAT 机制本身的限制，改设置也绕不开。

   OAuth 没这个限制
   ----------------
   `public_repo` 是按「仓库类型」授权的：能读写**所有公开仓库里该用户有权限的部分**。
   小号作为主仓库的 collaborator（push=true），拿到的 token 就能写主仓库。

   流程
   ----
   1. 管理页点「绑定小号」→ 走 OAuth（和投稿登录同一个 App）
   2. 回调时服务端换到 token，用 AES-GCM 加密后存进 R2
   3. 之后「审核通过」「推送」都用这个 token，浏览器全程不碰它
   4. token 的加密密钥复用 GITHUB_CLIENT_SECRET，不新增环境变量

   环境变量
   --------
     GITHUB_CLIENT_ID       OAuth App 的 Client ID
     GITHUB_CLIENT_SECRET   OAuth App 的 Client Secret（⚠️ 保密，同时用作加密密钥）
   ============================================================================ */

import { json, html, escapeHtml, randomState, readCookie } from './admin.js';

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

// token 存哪
const BOT_META_KEY = 'bot/meta.json';        // { login, boundAt }
const BOT_TOKEN_KEY = 'bot/token.enc';       // 加密后的 token

export async function botRoutes(url, request, env) {
  const p = url.pathname;
  if (p === '/api/bot/login') return handleLogin(url, env);
  if (p === '/api/bot/callback') return handleCallback(request, url, env);
  if (p === '/api/bot/status' && request.method === 'GET') return handleStatus(request, env);
  if (p === '/api/bot/unbind' && request.method === 'POST') return handleUnbind(request, env);
  return null;
}

/* ============================================================
   登录入口
   ============================================================ */
function handleLogin(url, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return html(errorPage('还没配好',
      '缺少 <code>GITHUB_CLIENT_ID</code> 或 <code>GITHUB_CLIENT_SECRET</code>。'), 500);
  }

  const csrf = randomState();
  const nonce = String(url.searchParams.get('nonce') || '').slice(0, 40);

  const auth = new URL(AUTHORIZE);
  auth.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  auth.searchParams.set('redirect_uri', url.origin + '/api/bot/callback');
  auth.searchParams.set('scope', 'public_repo');   // 见文件头：这是能写主仓库的关键
  auth.searchParams.set('state', csrf);
  auth.searchParams.set('allow_signup', 'false');

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': `bot_state=${csrf}|${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
    }
  });
}

/* ============================================================
   回调：换 token → 校验权限 → 加密存储
   ============================================================ */
async function handleCallback(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const clearState = 'bot_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

  if (oauthError) {
    return html(botPage({ error: url.searchParams.get('error_description') || oauthError }),
                200, clearState);
  }
  if (!code) {
    return html(botPage({ error: 'GitHub 没返回授权码' }), 200, clearState);
  }

  const saved = readCookie(request, 'bot_state') || '';
  const [savedCsrf, savedNonce] = saved.split('|');
  if (!savedCsrf || savedCsrf !== state) {
    return html(botPage({ error: 'state 校验失败，请回管理页重试。' }), 200, clearState);
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
        redirect_uri: url.origin + '/api/bot/callback'
      })
    });
    data = await r.json();
  } catch (e) {
    return html(botPage({ error: '换取 token 时网络出错：' + e.message }), 200, clearState);
  }

  if (!data || !data.access_token) {
    return html(botPage({ error: (data && data.error_description) || 'GitHub 没有返回 token' }),
                200, clearState);
  }

  const token = data.access_token;

  // 验证：这是谁？对主仓库有没有写权限？
  const u = await ghSimple(token, 'GET', '/user');
  if (!u || !u.login) {
    return html(botPage({ error: '无法读取 GitHub 用户名' }), 200, clearState);
  }

  const repo = await ghSimple(token, 'GET', '/repos/Thomas455/nailong-university');
  const canPush = repo && (repo.permissions || {}).push === true;

  if (!canPush) {
    return html(botPage({
      login: u.login,
      error: '账号 ' + u.login + ' 对主仓库没有写权限。\n' +
             '请先把它加成 collaborator：\n' +
             '仓库 → Settings → Collaborators → Add people → ' + u.login
    }), 200, clearState);
  }

  // 加密存储
  try {
    const enc = await encryptToken(token, env);
    await env.SUBMIT_BUCKET.put(BOT_TOKEN_KEY, enc, {
      httpMetadata: { contentType: 'application/octet-stream' }
    });
    await env.SUBMIT_BUCKET.put(BOT_META_KEY, JSON.stringify({
      login: u.login, boundAt: Date.now()
    }), { httpMetadata: { contentType: 'application/json' } });
  } catch (e) {
    return html(botPage({ error: '存储 token 失败：' + e.message }), 200, clearState);
  }

  return html(botPage({ ok: true, login: u.login }), 200, clearState);
}

/* ============================================================
   状态 / 解绑
   ============================================================ */
async function handleStatus(request, env) {
  const meta = await env.SUBMIT_BUCKET.get(BOT_META_KEY);
  if (!meta) return json({ bound: false, login: null });
  try {
    const m = JSON.parse(await meta.text());
    // 顺便验一下 token 还在不在（有没有被 revoke）
    let alive = true;
    try {
      const tok = await getBotToken(env);
      alive = Boolean(tok);
    } catch (e) { alive = false; }
    return json({ bound: true, login: m.login, boundAt: m.boundAt, alive });
  } catch (e) {
    return json({ bound: true, login: null, alive: false });
  }
}

async function handleUnbind(request, env) {
  await env.SUBMIT_BUCKET.delete(BOT_TOKEN_KEY);
  await env.SUBMIT_BUCKET.delete(BOT_META_KEY);
  return json({ ok: true });
}

/* ============================================================
   给 review.js 用：拿已绑定的 token
   ============================================================ */
export async function getBotToken(env) {
  const obj = await env.SUBMIT_BUCKET.get(BOT_TOKEN_KEY);
  if (!obj) return null;
  const enc = new Uint8Array(await obj.arrayBuffer());
  return await decryptToken(enc, env);
}

/* ============================================================
   加密 / 解密（AES-GCM）

   密钥用 GITHUB_CLIENT_SECRET 派生 —— 不用新增环境变量（OAuth 本来就要它）。
   但 AES-GCM 要求**正好 32 字节**，而 Client Secret 的长度不固定，
   所以这里用 SHA-256 把它压成 32 字节当密钥。
   ============================================================ */
async function getAesKey(env) {
  const material = env.GITHUB_CLIENT_SECRET || env.BOT_ENCRYPT_KEY;
  if (!material) {
    throw new Error('缺少加密密钥：请配置 GITHUB_CLIENT_SECRET 环境变量');
  }
  // SHA-256 → 32 字节，恰好满足 AES-256 的密钥长度要求
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(material));
  return await crypto.subtle.importKey('raw', digest,
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptToken(token, env) {
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(token);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  // iv(12) + 密文
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

async function decryptToken(bytes, env) {
  const key = await getAesKey(env);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/* ============================================================
   小工具
   ============================================================ */
async function ghSimple(token, method, path) {
  try {
    const r = await fetch('https://api.github.com' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nailong-submit-worker'
      }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

function botPage({ ok, login, error }) {
  const payload = JSON.stringify({
    type: 'nailong-bot-auth',
    ok: Boolean(ok),
    login: login || null,
    error: error || null
  });

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${error ? '绑定失败' : '绑定成功'}</title>
<meta name="robots" content="noindex">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b1a;color:#eef1ff;
       font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;text-align:center;padding:20px}
  .box{max-width:520px}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#8b93b8;font-size:14px;line-height:1.9;margin:0;white-space:pre-wrap;text-align:left}
  .ok{color:#3ddc84}.bad{color:#ff6b60}
  code{background:rgba(254,206,14,.18);padding:2px 6px;border-radius:6px;color:#fece0e}
  button{margin-top:18px;padding:10px 22px;border-radius:999px;border:0;cursor:pointer;
         background:#fece0e;color:#2a2000;font:inherit;font-weight:700}
</style></head><body>
<div class="box">
  <h1 class="${error ? 'bad' : 'ok'}">${error ? '绑定没成功' : '绑定成功'}</h1>
  <p id="tip">${error ? escapeHtml(error) : ('小号 ' + escapeHtml(login || '') + ' 已绑定。以后审核通过和推送都由它代提交。')}</p>
  <button id="closeBtn" type="button" hidden>关掉这个窗口</button>
</div>
<script>
(function () {
  var msg = ${payload};
  try {
    if (window.BroadcastChannel) {
      var ch = new BroadcastChannel('nailong-bot-auth');
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
        document.getElementById('tip').textContent = '回到管理页就能用了，这个窗口可以关掉了。';
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
font-family:system-ui,sans-serif;padding:24px;text-align:center;line-height:1.9}
code{background:rgba(254,206,14,.18);padding:2px 6px;border-radius:6px;color:#fece0e}</style>
</head><body><div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
}