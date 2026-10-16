/* ============================================================================
   管理页：待审列表 / 预览 / 发布 / 拒绝

   ---- 鉴权 ----
   每一个接口都先过 requireAdmin()（校验 HttpOnly 签名 cookie + 白名单）。
   没登录 → 401。这是**服务端**判断，不依赖前端藏不藏按钮。

   ---- 发布做了什么 ----
   拿小号的 token（BOT_TOKEN）：
     建分支 → 从 R2 读图写入 works/ → 更新 list.txt → 建 PR
   小号只有仓库所有者手动点「发布」时才会被用到一次。

   ---- 发布后的文件怎么办 ----
   把暂存的图片挪到 done/{id}/，并写一份带发布结果的 _meta.json。
   访客拿编号能查到「已发布 + PR 链接」。
   （不删除是为了让访客能查到状态；R2 便宜，定期清即可。）
   ============================================================ */

import { requireAdmin, json } from './admin.js';
import { GH_API, REPO, WORKS_DIR } from './guest.js';

export async function reviewRoutes(url, request, env) {
  const p = url.pathname;

  if (p === '/api/review/list' && request.method === 'GET') return listPending(request, env);
  if (p === '/api/review/detail' && request.method === 'GET') return detail(request, env, url);
  if (p === '/api/review/image' && request.method === 'GET') return image(request, env, url);
  if (p === '/api/review/publish' && request.method === 'POST') return publish(request, env);
  if (p === '/api/review/reject' && request.method === 'POST') return reject(request, env);
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
  // R2 的 list() 返回 Promise，要先 await 才能 for await。
  //
  // 这里不用 for await 遍历，改用 .objects 数组逐页处理 ——
  // 原因：真实 R2 的异步迭代器在游标翻页时可能抛异常，而这个接口是
  // 管理页的核心，出错就等于「管理页整个挂掉」。逐页 + 显式 try/catch
  // 更可控，而且能顺手处理 1000 条/页的上限。
  const seen = new Set();
  let cursor;

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
        if (!key.endsWith('/_meta.json')) continue;   // 只看元数据，不重复处理图片
        if (seen.has(id)) continue;
        seen.add(id);

        try {
          const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
          if (!meta) continue;
          const m = JSON.parse(await meta.text());
          m.id = id;
          out.push(m);
        } catch (e) {
          // 单条读失败不影响其它条目
          console.error('listPending: 读取', id, '失败', e && e.message);
        }
      }

      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    // 列 R2 本身失败 —— 记日志，但把已经拿到的部分返回，
    // 免得整个管理页因为一条坏数据就打不开
    console.error('listPending: 列举 R2 失败', e && e.message);
  }

  // 新的在前
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return json({ ok: true, items: out });
}

/* ============================================================
   单条详情（管理页预览用，带图片直链）
   ============================================================ */
async function detail(request, env, url) {
  if (!(await requireAdmin(request, env))) return unauthorized();
  const id = String(url.searchParams.get('id') || '').trim();
  if (!/^[0-9A-Z]{6}$/.test(id)) return json({ ok: false, error: '编号不对' }, 400);

  const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (!meta) return json({ ok: false, error: '找不到这条投稿' }, 404);

  const m = JSON.parse(await meta.text());
  // 图片直链：管理页已登录，靠 cookie 鉴权后从这里取
  m.previews = (m.files || []).map((f) => `/api/review/image?id=${id}&name=${encodeURIComponent(f.name)}`);
  m.id = id;
  return json({ ok: true, item: m });
}

// 单独取图（管理页 <img> 用）。必须登录。
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
   发布
   ============================================================ */
async function publish(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.BOT_TOKEN) return json({ ok: false, error: '服务端没配 BOT_TOKEN' }, 503);

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
  const skipPR = form.get('skipPR') === '1';      // 直接提交到 main，不建 PR

  try {
    const res = await pushToRepo(m, env, { admin, adminNote, skipPR });
    // 写结果 + 挪到 done/
    await env.SUBMIT_BUCKET.put(`done/${id}/_meta.json`, JSON.stringify({
      ...m, status: 'published', ...res, adminNote
    }), { httpMetadata: { contentType: 'application/json' } });
    await moveToDone(env, id, m);
    return json({ ok: true, ...res });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

/* ---- 真正写 GitHub 的部分 ---- */
async function pushToRepo(m, env, { admin, adminNote, skipPR }) {
  const token = env.BOT_TOKEN;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const branch = 'guest/' + stamp + '-' + m.id.toLowerCase();

  const dir = `${WORKS_DIR}/${m.collegeDir}`;

  // 1. 找 main 的 sha（从主仓库拿，因为小号是 owner 有全权限）
  const ref = await gh(token, 'GET', `/repos/${REPO.owner}/${REPO.repo}/git/ref/heads/${REPO.branch}`);
  const baseSha = ref.object.sha;

  // 2. 建分支
  await gh(token, 'POST', `/repos/${REPO.owner}/${REPO.repo}/git/refs`, {
    ref: `refs/heads/${branch}`, sha: baseSha
  });

  // 3. 传图
  const uploaded = [];
  for (const f of m.files) {
    const obj = await env.SUBMIT_BUCKET.get(`${m.id}/${f.name}`);
    if (!obj) throw new Error('R2 里找不到文件：' + f.name);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await gh(token, 'PUT', `/repos/${REPO.owner}/${REPO.repo}/contents/${enc(dir + '/' + f.name)}`, {
      message: `guest submission: ${f.name}`,
      content: b64(bytes),
      branch
    });
    uploaded.push(f.name);
  }

  // 4. 更新 list.txt（追加到末尾 = 显示在最上面）
  const listRes = await gh(token, 'GET',
    `/repos/${REPO.owner}/${REPO.repo}/contents/${enc(dir + '/list.txt')}?ref=${encodeURIComponent(REPO.branch)}`,
    undefined, true);
  let lines = [];
  let sha;
  if (listRes) {
    lines = String(listRes.content || '').replace(/\s/g, '')
      ? decodeB64(listRes.content).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
    sha = listRes.sha;
  }
  const seen = {};
  uploaded.forEach(n => { seen[n.toLowerCase()] = 1; });
  lines = lines.filter(l => !seen[l.toLowerCase()]);
  lines = lines.concat(uploaded);
  const listText = lines.join('\n') + '\n';

  await gh(token, 'PUT', `/repos/${REPO.owner}/${REPO.repo}/contents/${enc(dir + '/list.txt')}`, {
    message: `guest submission: update list.txt for ${m.collegeName}`,
    content: b64(new TextEncoder().encode(listText)),
    branch,
    ...(sha ? { sha } : {})
  });

  // 5. 建 PR 或直接推 main
  if (skipPR) {
    // 把分支合并进 main
    await gh(token, 'PUT',
      `/repos/${REPO.owner}/${REPO.repo}/merges`, {
        base: REPO.branch, head: branch, commit_message: `guest submission ${m.id}`
      });
    return { branch, prUrl: null, prNumber: null, publishedBy: admin };
  }

  const body = [
    `## 游客投稿 · ${m.collegeName}`,
    '',
    `编号 \`${m.id}\` · 由 @${admin} 审核通过`,
    '',
    m.note ? `> 投稿留言：\n> ${m.note.split(/\r?\n/).join('\n> ')}\n` : '',
    adminNote ? `**审核备注**：${adminNote}\n` : '',
    '**作品**',
    '',
    ...uploaded.map(n => `- \`${n}\``),
    '',
    '---',
    '> 这是一次游客投稿（投稿人没有 GitHub 账号，通过投稿站提交）。'
  ].filter(Boolean).join('\n');

  const pr = await gh(token, 'POST', `/repos/${REPO.owner}/${REPO.repo}/pulls`, {
    title: `[游客投稿] ${m.collegeName} · ${uploaded.length} 件`,
    body, head: branch, base: REPO.branch
  });
  return { branch, prUrl: pr.html_url, prNumber: pr.number, publishedBy: admin };
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

  await env.SUBMIT_BUCKET.put(`done/${id}/_meta.json`, JSON.stringify({
    ...m, status: 'rejected', adminNote
  }), { httpMetadata: { contentType: 'application/json' } });
  await moveToDone(env, id, m);

  return json({ ok: true });
}

// 把图片从 pending 前缀挪到 done/ 下（保留记录让访客查状态，图片可定期清）
async function moveToDone(env, id, m) {
  for (const f of m.files || []) {
    const obj = await env.SUBMIT_BUCKET.get(`${id}/${f.name}`);
    if (obj) {
      await env.SUBMIT_BUCKET.put(`done/${id}/${f.name}`, await obj.arrayBuffer(), {
        httpMetadata: obj.httpMetadata || { contentType: f.type }
      });
      await env.SUBMIT_BUCKET.delete(`${id}/${f.name}`);
    }
  }
  await env.SUBMIT_BUCKET.delete(`${id}/_meta.json`);
}

/* ============================================================
   GitHub API 小封装

   出错时把「哪个接口 + HTTP 状态 + GitHub 的原话 + 缺什么权限」
   都带上 —— 只说 "GitHub: Resource not accessible by integration"
   根本没法排查。
   ============================================================ */

// 接口路径片段 → 需要什么权限，用来在报错时给出可执行的提示。
// ⚠️ 顺序重要：更具体的路径要排在更宽的前面，
//    否则 /git/refs 会被 /git/ref 先匹配掉，提示成「读」而不是「写」。
const NEEDED = [
  ['/contents',   'Contents: 读写（提交文件）'],
  ['/pulls',      'Pull requests: 写（建 PR）'],
  ['/merges',     'Contents: 写（合并分支）'],
  ['/git/refs',   'Contents: 写（建分支）'],
  ['/git/ref/',   'Contents: 读（读分支）']
];

function hintFor(path, status) {
  if (status === 401) return 'BOT_TOKEN 无效或已过期，需要重新生成。';
  if (status === 404) return '找不到资源 —— 确认仓库名对、小号能看到这个仓库、branch 存在。';
  if (status === 422) return 'GitHub 拒绝了这次请求（参数或状态不对），常见于分支已存在或文件冲突。';
  if (status === 403 || status === 401) {
    const hit = NEEDED.find((p) => path.indexOf(p[0]) >= 0);
    return '小号的 token 没有权限做这件事。检查三处：\n' +
           '  1. token 的 Permissions 里有没有「' + (hit ? hit[1] : '对应权限') + '」\n' +
           '  2. Repository access 选的是不是「Only select repositories」并且勾选了这个仓库\n' +
           '  3. 小号是不是对仓库有 collaborator 权限（公开仓库也要在 token 里勾上）';
  }
  return '';
}

async function gh(token, method, path, body, allow404) {
  const opt = {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
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
    const apiMsg = (d && d.message) || txt.slice(0, 120) || ('HTTP ' + r.status);
    // 简短路径，方便人看（完整路径太长）
    const shortPath = path.replace('/repos/Thomas455/nailong-university', '')
                        .slice(0, 60);
    const hint = hintFor(shortPath, r.status);
    const err = new Error(
      `GitHub ${r.status}（${method} ${shortPath}）：${apiMsg}` +
      (hint ? '\n' + hint : '')
    );
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

// 单独导出给 worker.js 注册 /api/review/image
export { image as reviewImage };