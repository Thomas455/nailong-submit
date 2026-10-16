import { requireAdmin, json } from './admin.js';
import { GH_API, REPO, WORKS_DIR } from './guest.js';
import { getBotToken } from './bot.js';

/* ============================================================
   拿小号的 token

   来源是管理页「绑定小号」时用 OAuth 换来的（加密存在 R2 里）。

   为什么不用 fine-grained PAT：
   PAT 的 "Only select repositories" **只能选 token 拥有者自己的仓库**。
   小号只有它自己的 fork，选不到主仓库，所以对主仓库的写操作全是 403。
   OAuth 的 public_repo 按「仓库类型」授权，没这个限制 ——
   小号只要是 collaborator，token 就能写主仓库。
   ============================================================ */
async function botToken(env) {
  const t = await getBotToken(env);
  if (!t) {
    throw new Error('还没绑定小号。请到管理页点「绑定小号」，用小号登录一次。');
  }
  return t;
}

/* ============================================================================
   审核：两个动作

   ① 审核通过（approve）
      把图片和 list.txt 写进**小号自己的 fork**，不建 PR、不碰主仓库。

      为什么写 fork 而不是主仓库：小号不是主仓库的成员（push=false），
      而 GitHub 明确规定 fine-grained token 无法给「非成员」的公开仓库写入。
      但 token 对**自己拥有的 fork** 有完整写权限 —— 这就是绕开该限制的办法。

   ② 推送（push）
      把 fork 上攒好的所有改动，以**一个** PR 的形式提到主仓库。

      好处：审核通过之后你可以去 GitHub 网页上手动改名、删图、调顺序、
      攒几批再一次性推，比每条投稿开一个 PR 省事得多。

   数据流：
       待审投稿 ──[审核通过]──> 小号 fork（可以手动改）
                                 │
                                 └──[推送]──> 主仓库的 PR

   环境变量：
     （没有 token 类环境变量 —— 小号由管理页 OAuth 绑定，token 加密存 R2）
     BOT_FORK_OWNER   小号用户名。不配就用 token 自动反查
     BOT_FORK_REPO    fork 的仓库名，默认和主仓库同名
   ============================================================================ */

export async function reviewRoutes(url, request, env) {
  const p = url.pathname;

  if (p === '/api/review/list' && request.method === 'GET') return listPending(request, env);
  if (p === '/api/review/detail' && request.method === 'GET') return detail(request, env, url);
  if (p === '/api/review/image' && request.method === 'GET') return image(request, env, url);
  if (p === '/api/review/approve' && request.method === 'POST') return approve(request, env);
  if (p === '/api/review/push' && request.method === 'POST') return push(request, env);
  if (p === '/api/review/reject' && request.method === 'POST') return reject(request, env);

  // 已审核但还没推到主仓库的分支列表
  if (p === '/api/review/pending-branches' && request.method === 'GET') {
    return pendingBranches(request, env);
  }

  return null;
}

function unauthorized() {
  return json({ ok: false, error: '未登录管理页' }, 401);
}

/* ============================================================
   待审列表
   ============================================================ */
async function listPending(request, env) {
  if (!(await requireAdmin(request, env))) return unauthorized();
  if (!env.SUBMIT_BUCKET) return json({ ok: false, error: '未配置存储' }, 503);

  const out = [];
  const seen = new Set();
  let cursor;

  // 逐页取，不用 for await —— 真实 R2 的异步迭代器翻页时可能抛异常，
  // 而这个接口挂了等于管理页全废。逐页 + try/catch 更可控。
  try {
    do {
      const page = await env.SUBMIT_BUCKET.list({ prefix: '', cursor });
      const objects = (page && page.objects) || [];
      if (!objects.length) break;

      for (const obj of objects) {
        const key = (obj && obj.key) || '';
        const slash = key.indexOf('/');
        if (slash <= 0) continue;                    // 顶层 key（rl/xxx 这类）
        const id = key.slice(0, slash);
        if (!/^[0-9A-Z]{6}$/.test(id)) continue;      // 跳过 rl/、done/ 之类
        if (!key.endsWith('/_meta.json')) continue;   // 只看元数据
        if (seen.has(id)) continue;
        seen.add(id);

        try {
          const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
          if (!meta) continue;
          const m = JSON.parse(await meta.text());
          m.id = id;

          // 顺带看看这条是不是已经审核通过过（写过 _approved.json）
          const ap = await env.SUBMIT_BUCKET.get(`${id}/_approved.json`);
          m.approved = ap ? JSON.parse(await ap.text()) : null;

          out.push(m);
        } catch (e) {
          console.error('listPending: 读取', id, '失败', e && e.message);
        }
      }

      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error('listPending: 列举 R2 失败', e && e.message);
  }

  // 新的在前
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return json({ ok: true, items: out });
}

/* ============================================================
   单条详情（带预览图链接）
   ============================================================ */
async function detail(request, env, url) {
  if (!(await requireAdmin(request, env))) return unauthorized();
  const id = String(url.searchParams.get('id') || '').trim();
  if (!/^[0-9A-Z]{6}$/.test(id)) return json({ ok: false, error: '编号不对' }, 400);

  const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (!meta) return json({ ok: false, error: '找不到这条投稿' }, 404);

  const m = JSON.parse(await meta.text());
  m.previews = (m.files || []).map((f) =>
    `/api/review/image?id=${id}&name=${encodeURIComponent(f.name)}`);
  m.id = id;

  const ap = await env.SUBMIT_BUCKET.get(`${id}/_approved.json`);
  m.approved = ap ? JSON.parse(await ap.text()) : null;

  return json({ ok: true, item: m });
}

// 预览图（管理页 <img> 用）。必须登录。
async function image(request, env, url) {
  if (!(await requireAdmin(request, env))) return new Response('unauthorized', { status: 401 });
  const id = String(url.searchParams.get('id') || '');
  const name = String(url.searchParams.get('name') || '');

  // 文件名必须严格等于元数据里记录的那个，不能只靠参数（防路径穿越）
  const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (!meta) return new Response('not found', { status: 404 });
  const m = JSON.parse(await meta.text());
  const rec = (m.files || []).find((f) => f.name === name);
  if (!rec) return new Response('not found', { status: 404 });

  const obj = await env.SUBMIT_BUCKET.get(`${id}/${name}`);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': rec.type,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

/* ============================================================
   ① 审核通过 → 写进小号的 fork
   ============================================================ */
async function approve(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.SUBMIT_BUCKET) return json({ ok: false, error: '未配置存储' }, 503);

  let form;
  try { form = await request.formData(); } catch (e) {
    return json({ ok: false, error: '请求不对' }, 400);
  }
  const id = String(form.get('id') || '').trim();
  if (!/^[0-9A-Z]{6}$/.test(id)) return json({ ok: false, error: '编号不对' }, 400);

  const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (!meta) return json({ ok: false, error: '找不到这条投稿' }, 404);
  const m = JSON.parse(await meta.text());

  const adminNote = String(form.get('note') || '').slice(0, 300);

  try {
    const res = await pushToFork(m, env, { admin, adminNote });

    // 记一笔，方便「推送」时列出待推分支
    await env.SUBMIT_BUCKET.put(`${id}/_approved.json`, JSON.stringify({
      at: Date.now(), by: admin, adminNote,
      branch: res.branch, files: res.files
    }), { httpMetadata: { contentType: 'application/json' } });

    return json({ ok: true, ...res });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ---- 把作品写进小号的 fork ---- */
async function pushToFork(m, env, { admin, adminNote }) {
  const token = await botToken(env);
  const fork = await forkRepo(env);
  const branch = 'guest/' + stamp() + '-' + m.id.toLowerCase();
  const dir = `${WORKS_DIR}/${m.collegeDir}`;

  // 1. 读 fork 上 main 的 sha
  const ref = await gh(token, 'GET',
    `/repos/${fork.owner}/${fork.repo}/git/ref/heads/${REPO.branch}`);
  const baseSha = ref.object.sha;

  // 2. 建分支（写在 fork 上 —— token 对自己的 fork 有权限）
  await gh(token, 'POST', `/repos/${fork.owner}/${fork.repo}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: baseSha
  });

  // 3. 传图
  const uploaded = [];
  for (const f of m.files) {
    const obj = await env.SUBMIT_BUCKET.get(`${m.id}/${f.name}`);
    if (!obj) throw new Error('R2 里找不到文件：' + f.name);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await gh(token, 'PUT',
      `/repos/${fork.owner}/${fork.repo}/contents/${enc(dir + '/' + f.name)}`, {
        message: `guest submission: ${f.name}`,
        content: b64(bytes),
        branch
      });
    uploaded.push(f.name);
  }

  // 4. 更新 list.txt（追加到末尾 = 显示在最上面）
  await updateList(token, fork, dir, uploaded, branch);

  return {
    branch,
    files: uploaded,
    forkFull: `${fork.owner}/${fork.repo}`,
    // 点进去就能看到，方便你手动调整
    forkUrl: `https://github.com/${fork.owner}/${fork.repo}/tree/${encodeURIComponent(branch)}`
  };
}

/* ---- 改 list.txt：读现有内容 → 追加新作品 ---- */
async function updateList(token, fork, dir, uploaded, branch) {
  const api = `/repos/${fork.owner}/${fork.repo}/contents/${enc(dir + '/list.txt')}`;

  // fork 上可能已经有 list.txt（旧副本），也可能没有
  let lines = [];
  let sha;
  const existing = await gh(token, 'GET', api + '?ref=' + encodeURIComponent(REPO.branch), undefined, true);
  if (existing) {
    lines = String(existing.content || '').replace(/\s/g, '')
      ? decodeB64(existing.content).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
    sha = existing.sha;
  }

  // 去掉同名旧条目（避免重复），再追加新的
  const seen = {};
  uploaded.forEach((n) => { seen[n.toLowerCase()] = 1; });
  lines = lines.filter((l) => !seen[l.toLowerCase()]);
  lines = lines.concat(uploaded);

  const body = {
    message: 'guest submission: update list.txt',
    content: b64(new TextEncoder().encode(lines.join('\n') + '\n')),
    branch
  };
  if (sha) body.sha = sha;

  await gh(token, 'PUT', api, body);
}

/* ============================================================
   ② 推送 → fork 上的改动以 PR 形式提到主仓库
   ============================================================ */
async function push(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.SUBMIT_BUCKET) return json({ ok: false, error: '未配置存储' }, 503);

  let form;
  try { form = await request.formData(); } catch (e) {
    return json({ ok: false, error: '请求不对' }, 400);
  }
  const branch = String(form.get('branch') || '').trim();

  // 只允许 guest/ 开头的分支名 —— 不让前端随便传分支名来推东西
  if (!/^guest\/[a-zA-Z0-9._-]+$/.test(branch)) {
    return json({ ok: false, error: '分支名不对（应该像 guest/20260101-abc123）' }, 400);
  }

  const fork = await forkRepo(env);
  const token = await botToken(env);

  // 这个分支得真的存在
  let head;
  try {
    head = await gh(token, 'GET', `/repos/${fork.owner}/${fork.repo}/git/ref/heads/${branch}`);
  } catch (e) {
    return json({ ok: false, error: 'fork 上找不到分支 ' + branch + '\n' + e.message }, 400);
  }

  // 和主仓库的 main 比一下，看看这个分支改了什么
  let compare = null;
  try {
    compare = await gh(token, 'GET',
      `/repos/${REPO.owner}/${REPO.repo}/compare/${REPO.branch}...${fork.owner}:${branch}`);
  } catch (e) {
    // compare 失败不致命，接着试着建 PR（GitHub 自己会判断有没有差异）
    console.error('push: compare 失败', e && e.message);
  }

  const colleges = compare ? touchedColleges(compare) : [];
  const commits = (compare && compare.total_commits) || 0;
  const filesChanged = (compare && compare.files && compare.files.length) || 0;

  if (compare && commits === 0) {
    return json({ ok: false, error: '这个分支相对主仓库没有改动，可能已经合并过了。' }, 400);
  }

  const title = String(form.get('title') || '').trim()
    || `[游客投稿] ${colleges.length ? colleges.join('、') : '作品更新'}（${commits} 次提交）`;

  const pr = await gh(token, 'POST', `/repos/${REPO.owner}/${REPO.repo}/pulls`, {
    title,
    body: buildPushPRBody(compare, colleges, branch, fork),
    head: `${fork.owner}:${branch}`,      // 跨 fork 提 PR 的写法
    base: REPO.branch
  });

  // 把「这条投稿已推成 PR」记下来，投稿人查编号时能看到链接
  await markPushed(env, branch, { prUrl: pr.html_url, prNumber: pr.number });

  return json({
    ok: true,
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    commits,
    filesChanged,
    colleges
  });
}

// 把这个分支上的所有投稿标记为「已推送」
async function markPushed(env, branch, res) {
  try {
    const page = await env.SUBMIT_BUCKET.list({ prefix: '', cursor: undefined });
    for (const obj of ((page && page.objects) || [])) {
      const key = (obj && obj.key) || '';
      const m = /^([0-9A-Z]{6})\/_approved\.json$/.exec(key);
      if (!m) continue;
      try {
        const r = await env.SUBMIT_BUCKET.get(key);
        if (!r) continue;
        const a = JSON.parse(await r.text());
        if (a.branch !== branch) continue;      // 只标记同一个分支上的
        await env.SUBMIT_BUCKET.put(`${m[1]}/_pushed.json`, JSON.stringify({
          at: Date.now(), ...res
        }), { httpMetadata: { contentType: 'application/json' } });
      } catch (e) { /* 坏数据跳过 */ }
    }
  } catch (e) {
    console.error('markPushed 失败', e && e.message);
  }
}

/* ---- 已审核但还没推的分支 ---- */
async function pendingBranches(request, env) {
  if (!(await requireAdmin(request, env))) return unauthorized();
  if (!env.SUBMIT_BUCKET) return json({ ok: false, error: '未配置存储' }, 503);

  const out = [];
  try {
    const page = await env.SUBMIT_BUCKET.list({ prefix: '', cursor: undefined });
    for (const obj of ((page && page.objects) || [])) {
      const key = (obj && obj.key) || '';
      const m = /^([0-9A-Z]{6})\/_approved\.json$/.exec(key);
      if (!m) continue;
      try {
        const r = await env.SUBMIT_BUCKET.get(key);
        if (r) out.push({ id: m[1], ...JSON.parse(await r.text()) });
      } catch (e) { /* 坏数据跳过 */ }
    }
  } catch (e) {
    console.error('pendingBranches 失败', e && e.message);
  }

  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return json({ ok: true, items: out });
}

// 从 compare 结果里找出改了哪些学院的作品
function touchedColleges(compare) {
  const set = new Set();
  for (const f of (compare && compare.files) || []) {
    const m = new RegExp('^' + WORKS_DIR + '/([^/]+)/').exec(f.filename || '');
    if (m) set.add(m[1]);
  }
  return [...set];
}

function buildPushPRBody(compare, colleges, branch, fork) {
  const L = [];
  const commits = (compare && compare.total_commits) || 0;
  const files = (compare && compare.files) || [];

  L.push('## 游客作品合集');
  L.push('');
  L.push('这批作品已推到小号的 fork（`' + fork.owner + '/' + fork.repo + '`）的 `' + branch + '` 分支，在此合并到主仓库。');
  L.push('');
  L.push('**本批改动**');
  L.push('');
  L.push('- 提交数：' + commits);
  L.push('- 改动文件：' + files.length);
  L.push('- 涉及学院：' + (colleges.length ? colleges.join('、') : '—'));
  L.push('');

  if (files.length) {
    L.push('**文件清单**');
    L.push('');
    for (const f of files.slice(0, 100)) {
      L.push('- `' + f.filename + '`（' + (f.status || '') + '）');
    }
    if (files.length > 100) L.push('- …还有 ' + (files.length - 100) + ' 个');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('> 合并后 Cloudflare 会自动重新部署，作品出现在展览馆对应学院的卡片里。');
  return L.join('\n');
}

/* ============================================================
   拒绝
   ============================================================ */
async function reject(request, env) {
  if (!(await requireAdmin(request, env))) return unauthorized();
  let form;
  try { form = await request.formData(); } catch (e) {
    return json({ ok: false, error: '请求不对' }, 400);
  }
  const id = String(form.get('id') || '').trim();
  if (!/^[0-9A-Z]{6}$/.test(id)) return json({ ok: false, error: '编号不对' }, 400);

  const adminNote = String(form.get('note') || '').slice(0, 300);
  const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (!meta) return json({ ok: false, error: '找不到这条投稿' }, 404);
  const m = JSON.parse(await meta.text());

  // 标记为已拒绝，投稿人查编号时能看到
  await env.SUBMIT_BUCKET.put(`${id}/_rejected.json`, JSON.stringify({
    at: Date.now(), adminNote
  }), { httpMetadata: { contentType: 'application/json' } });

  return json({ ok: true });
}

/* ============================================================
   工具
   ============================================================ */
function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// 小号 fork 的仓库坐标。
//
// ⚠️ owner 是**小号**，不是主仓库 owner —— fork 属于小号，
//   而 token 只对自己的 fork 有写权限。
//   小号用户名用 token 反查（GET /user），不用额外配环境变量。
const forkOwnerCache = new Map();

async function forkOwner(env) {
  if (env.BOT_FORK_OWNER) return env.BOT_FORK_OWNER;
  const cached = forkOwnerCache.get('o');
  if (cached) return cached;

  const u = await gh(await botToken(env), 'GET', '/user');
  const login = u && u.login;
  if (!login) throw new Error('无法确定小号用户名：GitHub 没返回 login');
  forkOwnerCache.set('o', login);
  return login;
}

async function forkRepo(env) {
  return { owner: await forkOwner(env), repo: env.BOT_FORK_REPO || REPO.repo };
}

/* ============================================================
   GitHub API 封装

   ⚠️ User-Agent 头是**必须的**，少了会被 GitHub 直接 403：
      "Request forbidden by administrative rules. Please make sure your
       request has a User-Agent header"
   ============================================================ */
const NEEDED = [
  ['/contents',  'Contents: 读写（提交文件）'],
  ['/pulls',     'Pull requests: 写（建 PR）'],
  ['/compare',   'Contents: 读（比较分支）'],
  ['/merges',    'Contents: 写（合并分支）'],
  ['/git/refs',  'Contents: 写（建分支）'],
  ['/git/ref/',  'Contents: 读（读分支）']
];

function hintFor(path, status) {
  if (status === 401) return '小号的 token 无效或已过期，重新绑定一次小号。';
  if (status === 404) {
    return '找不到资源。注意：小号必须**先 fork 这个仓库**，' +
           '而且 fork 的仓库名要和主仓库一样（当前期望 ' + REPO.repo + '）。';
  }
  if (status === 422) return 'GitHub 拒绝了这次请求（参数或状态不对），常见于分支已存在或文件冲突。';
  if (status === 403) {
    const hit = NEEDED.find((p) => path.indexOf(p[0]) >= 0);
    return '小号的 token 没权限做这件事。检查：\n' +
           '  1. token 权限里有没有「' + (hit ? hit[1] : '对应权限') + '」\n' +
           '  2. Repository access 里勾选了这个仓库\n' +
           '  3. 如果操作的是**主仓库**——小号不是主仓库成员，写不进去。\n' +
           '     这是 GitHub 的限制：fine-grained token 不能给非成员的仓库写入。\n' +
           '     所以审核流程是「写进小号自己的 fork → 再从 fork 提 PR」。';
  }
  return '';
}

async function gh(token, method, path, body, allow404) {
  const opt = {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nailong-submit-worker'
    }
  };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }

  const r = await fetch(GH_API + path, opt);
  if (r.status === 404 && allow404) return null;
  if (r.status === 204) return null;

  const txt = await r.text();
  let d = null;
  try { d = txt ? JSON.parse(txt) : null; } catch (e) {}

  if (!r.ok) {
    const apiMsg = (d && d.message) || txt.slice(0, 140) || ('HTTP ' + r.status);
    const shortPath = path.replace('/repos/Thomas455/nailong-university', '').slice(0, 64);
    const hint = hintFor(shortPath, r.status);
    const err = new Error(`GitHub ${r.status}（${method} ${shortPath}）：${apiMsg}` + (hint ? '\n' + hint : ''));
    err.status = r.status;
    throw err;
  }
  return d;
}

function enc(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function b64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function decodeB64(b64s) {
  const s = atob(String(b64s).replace(/\s/g, ''));
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return new TextDecoder('utf-8').decode(arr);
}