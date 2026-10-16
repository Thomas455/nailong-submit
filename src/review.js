import { requireAdmin, json } from './admin.js';
import { GH_API, REPO, WORKS_DIR } from './config.js';
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

          // 顺带看这条的状态：已审核通过 / 已拒绝 / 待审核
          //
          // ⚠️ 以前只读 _approved.json，导致**拒绝后的条目看起来和待审一模一样** ——
          //    管理员会以为还没处理，又点一次拒绝。所以拒绝状态必须读出来。
          const [ap, rj] = await Promise.all([
            env.SUBMIT_BUCKET.get(`${id}/_approved.json`),
            env.SUBMIT_BUCKET.get(`${id}/_rejected.json`)
          ]);
          m.approved = ap ? JSON.parse(await ap.text()) : null;
          m.rejected = rj ? JSON.parse(await rj.text()) : null;
          // 已推到主仓库的（推送成功时写的）
          const pj = await env.SUBMIT_BUCKET.get(`${id}/_pushed.json`);
          m.pushed = pj ? JSON.parse(await pj.text()) : null;
          // 一个统一的状态字段，前端直接用
          m.state = m.pushed ? 'pushed' : (m.rejected ? 'rejected' : (m.approved ? 'approved' : 'pending'));

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

    // 重名被拦下：**不要**写 _approved.json。
    // 写了的话这条会算进「已审核通过待推送」，推送时又被重放一遍。
    if (res.rejected) {
      return json({ ok: false, error: res.reason, nameClash: true }, 409);
    }

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

/* ---- 把作品写进小号的 fork（直接写 main，不建分支）----
 *
 * 为什么不再建 guest/xxx 分支：
 * 原来每条投稿开一个分支，推送时逐个提 PR —— 分支一多就乱，而且
 * 手动调整（改名/删图/调顺序）必须先进那个分支，改完才能推。
 *
 * 现在直接提交到 fork 的 main，于是：
 *   · 所有已审核通过的内容都堆在 fork 的 main 上（一个地方，看得全）
 *   · 「推送」= fork 的 main → 主仓库的 main，一个 PR 解决全部
 *   · 想调整直接在 GitHub 网页上改 main 就行，不用挑分支
 *
 * 代价：并发审核时可能撞（两条投稿同时写同一个 list.txt）。
 * 对策见下面的 recoverFromConflict —— 撞了就强制同步，然后
 * 把所有「已审核通过但没推送」的重新提交一遍。
 */
async function pushToFork(m, env, { admin, adminNote }) {
  const token = await botToken(env);
  const fork = await forkRepo(env);
  const dir = `${WORKS_DIR}/${m.collegeDir}`;

  // 0. ★ 先把 fork 同步到主仓库最新
  //
  // 不做这一步会有个**静默的破坏**：updateList 读的是 fork 上的 list.txt，
  // fork 一旦落后于主仓库，它就会基于旧版本追加新作品 ——
  // PR 的 diff 里会出现**删除别人的行**，一合并就把别人已发布的作品撤了，
  // 而且不会报任何错。
  const synced = await syncFork(token, fork);
  if (!synced) {
    console.warn('pushToFork: fork 同步未成功，继续用现有版本（可能产生多余差异）');
  }

  // 1. 读 fork 上 main 的 sha（同步之后拿到的就是最新的）
  const ref = await gh(token, 'GET',
    `/repos/${fork.owner}/${fork.repo}/git/ref/heads/${REPO.branch}`);
  const baseSha = ref.object.sha;

  // 1.5 ★ 重名检查：目标目录里已经有同名文件就拒绝
  //
  // 为什么必须在这里挡：
  // 下面那个 PUT /contents/<路径> 走的是「不带 sha 的新建」语义。
  // GitHub 官方文档明确 sha 是 "Required if you are updating a file" ——
  // 目标文件已存在时，这个 PUT 会直接 **422 Invalid request**，不是覆盖。
  // （实测确认过：对已存在文件不带 sha PUT → 422 "sha" wasn't supplied，
  //   而且原文件内容原封不动。别照着「已存在就覆盖」去理解这段代码。）
  //
  // 那为什么还要在前面挡一道？因为 422 的失败方式很难看，还会留半成品：
  //   · 文件是逐张上传的，撞名前那张已经提交进 fork 的 main 了；
  //   · _approved.json 要整个 pushToFork 成功后才写 —— 于是这条投稿
  //     看起来还「待审核」，fork 里却多了一张没人认领的图；
  //   · 重试还会在那张孤儿图上再 422（syncFork 不会清掉它），
  //     不会自愈，只能人工去 GitHub 删。
  // 所以在上传之前先列目录查一遍：撞名就明确拒绝（409 + 说清原因），
  // 一个文件都不写，_approved.json 也不写。
  //
  // 这一步放在同步之后：同步保证读到的是主仓库的最新内容，
  // 否则可能漏掉别人刚合并进来的同名文件。
  const clash = await findNameClash(token, fork, dir, m.files);
  if (clash) {
    return {
      branch: REPO.branch,
      files: [],
      forkFull: `${fork.owner}/${fork.repo}`,
      forkUrl: `https://github.com/${fork.owner}/${fork.repo}/tree/${REPO.branch}`,
      rejected: true,
      reason: clash
    };
  }

  // 2. 传图 + 更新 list.txt，都落在 main 上
  const uploaded = [];
  for (const f of m.files) {
    const obj = await env.SUBMIT_BUCKET.get(`${m.id}/${f.name}`);
    if (!obj) throw new Error('R2 里找不到文件：' + f.name);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await gh(token, 'PUT',
      `/repos/${fork.owner}/${fork.repo}/contents/${enc(dir + '/' + f.name)}`, {
        message: `guest submission: ${f.name}`,
        content: b64(bytes),
        branch: REPO.branch              // ← 直接写 main
      });
    uploaded.push(f.name);
  }

  // 3. 更新 list.txt（追加到末尾 = 显示在最上面）
  await updateList(token, fork, dir, uploaded, REPO.branch);

  return {
    branch: REPO.branch,                 // 永远是 main
    files: uploaded,
    forkFull: `${fork.owner}/${fork.repo}`,
    // 点进去就能看到，方便你手动调整
    forkUrl: `https://github.com/${fork.owner}/${fork.repo}/tree/${REPO.branch}`
  };
}

/* ============================================================
   重名检查：目标目录里已经有同名文件吗

   返回 null = 没冲突；返回字符串 = 冲突说明（直接给管理员看）

   为什么用「列目录」而不是「逐个查文件」：
   GET /contents/<dir> 一次就能拿到整个目录的清单，
   而逐文件查要 N 次请求（GitHub API 有速率限制）。

   ⚠️ 大小写不敏感比较：GitHub、Windows、macOS 上
   A.webp 和 a.webp 是同一个文件，用 === 比会漏掉这种情况。
   ============================================================ */
async function findNameClash(token, fork, dir, files) {
  if (!files || !files.length) return null;

  let listing = [];
  try {
    listing = await gh(token, 'GET',
      `/repos/${fork.owner}/${fork.repo}/contents/${enc(dir)}` +
      `?ref=${encodeURIComponent(REPO.branch)}`, undefined, true);
  } catch (e) {
    // 目录还不存在（这个学院第一次有人投稿）→ 不可能有冲突
    console.warn('findNameClash: 列目录失败，按无冲突处理', e && e.message);
    return null;
  }
  if (!Array.isArray(listing)) return null;

  // list.txt 是我们自己维护的索引，不参与重名判断
  const existing = new Set(
    listing
      .filter((it) => it && it.type === 'file' && it.name !== 'list.txt')
      .map((it) => String(it.name).toLowerCase())
  );

  const dup = files.find((f) => existing.has(String(f.name).toLowerCase()));
  if (!dup) return null;

  return '学院目录里已经有叫「' + dup.name + '」的作品了。\n' +
         '请把这次的作品改名后重新提交；\n' +
         '如果确实是要替换旧作品，先把旧文件从仓库里删掉，再点审核通过。';
}

/* ============================================================
   把 fork 的 main 同步到主仓库最新

   用 GitHub 官方的 merge-upstream：它把主仓库的 main 合并进 fork 的 main。
   返回 true = 确认已经是最新；false = 没能确认（继续，但可能有多余差异）。

   ⚠️ 失败不阻断流程 —— 投稿是主要目的，同步只是保证差异干净。
   409 = 有冲突（fork 上有改动没进主仓库），422 = 已经是最新了
   ============================================================ */
async function syncFork(token, fork) {
  try {
    const r = await fetch(`${GH_API}/repos/${fork.owner}/${fork.repo}/merge-upstream`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nailong-submit-worker',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ branch: REPO.branch })
    });

    // 204 = 已经是最新的；200 = 刚同步完
    if (r.status === 200 || r.status === 204) return true;

    const txt = await r.text().catch(() => '');
    console.warn('syncFork: HTTP', r.status, txt.slice(0, 160));
    return false;
  } catch (e) {
    console.error('syncFork 异常', e && e.message);
    return false;
  }
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

  const fork = await forkRepo(env);
  const token = await botToken(env);

  // fork 的 main 得存在
  try {
    await gh(token, 'GET', `/repos/${fork.owner}/${fork.repo}/git/ref/heads/${REPO.branch}`);
  } catch (e) {
    return json({ ok: false, error: 'fork 上没有 main 分支：' + e.message }, 400);
  }

  // 和主仓库 main 比一下，看看 fork 上有什么改动
  let compare = null;
  try {
    compare = await gh(token, 'GET',
      `/repos/${REPO.owner}/${REPO.repo}/compare/${REPO.branch}...${fork.owner}:${REPO.branch}`);
  } catch (e) {
    console.error('push: compare 失败', e && e.message);
  }

  const colleges = compare ? touchedColleges(compare) : [];
  const commits = (compare && compare.total_commits) || 0;
  const filesChanged = (compare && compare.files && compare.files.length) || 0;

  if (compare && commits === 0) {
    return json({ ok: false, error: 'fork 的 main 相对主仓库没有改动，可能已经合并过了。' }, 400);
  }

  const title = `[游客投稿] ${colleges.length ? colleges.join('、') : '作品更新'}（${commits} 次提交）`;

  let pr;
  try {
    pr = await gh(token, 'POST', `/repos/${REPO.owner}/${REPO.repo}/pulls`, {
      title,
      body: buildPushPRBody(compare, colleges, REPO.branch, fork),
      head: `${fork.owner}:${REPO.branch}`,   // fork 的 main → 主仓库的 main
      base: REPO.branch
    });
  } catch (e) {
    // ---- 冲突恢复 ----
    //
    // 什么情况会走到这：你在 GitHub 网页上手动往主仓库推过东西，
    // 此时 fork 的 main 和主仓库的 main 产生了分叉，直接提 PR 会 409。
    //
    // 处理：强制同步（把 fork 硬重置到主仓库最新），
    // 然后把所有「已审核通过但还没推送」的重新提交一遍，最后再推。
    if (e.status !== 409 && e.status !== 422) throw e;

    console.warn('push: 建 PR 冲突，开始恢复：强制同步 + 重扫已审核未推送的内容');

    const rec = await recoverFromConflict(env, { token, fork, admin });
    if (!rec.ok) return json({ ok: false, error: rec.error }, 409);

    // 恢复完之后再建一次 PR
    const c2 = await gh(token, 'GET',
      `/repos/${REPO.owner}/${REPO.repo}/compare/${REPO.branch}...${fork.owner}:${REPO.branch}`);
    const commits2 = (c2 && c2.total_commits) || 0;
    if (!commits2) {
      return json({ ok: false, error: '恢复完成，但 fork 相对主仓库已无差异（可能内容都已上线）。' }, 400);
    }

    pr = await gh(token, 'POST', `/repos/${REPO.owner}/${REPO.repo}/pulls`, {
      title: `[游客投稿] ${rec.colleges.length ? rec.colleges.join('、') : '作品更新'}（${commits2} 次提交）`,
      body: buildPushPRBody(c2, rec.colleges, REPO.branch, fork)
        + `\n\n> ⚠️ 本次推送前发生过冲突，已强制同步并重新提交了 ${rec.replayed} 条待推内容。`,
      head: `${fork.owner}:${REPO.branch}`,
      base: REPO.branch
    });
  }

  // 这次 PR 涵盖的所有「已审核通过但没推送」的投稿，都标记成已推送
  await markPushed(env, { prUrl: pr.html_url, prNumber: pr.number });

  return json({
    ok: true,
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch: REPO.branch,
    commits,
    filesChanged,
    colleges
  });
}

/* ============================================================
   冲突恢复：强制同步 + 重扫已审核未推送的内容

   步骤（按你说的顺序）：
     1. 强制把 fork 的 main 对齐到主仓库 main（丢掉分叉）
     2. 扫描所有「已审核通过、但没有 _pushed.json」的投稿
     3. 把它们重新提交到 fork 的 main
     4. 之后再推 PR

   为什么第 1 步要「强制」：merge-upstream 遇到冲突会失败（409），
   而我们要的是「以主仓库为准，fork 重新开始」。所以用 update-ref
   把 fork 的 main 直接指到主仓库的 main（force=true）。
   ⚠️ 这会丢掉 fork 上「尚未推送」的改动 —— 所以必须先做第 2/3 步，
      而第 3 步的源数据在 R2 里（不是 fork 上），所以强制同步不会丢内容。
   ============================================================ */
async function recoverFromConflict(env, { token, fork, admin }) {
  // 1. 强制同步：fork:main ← 主仓库:main
  let mainRef;
  try {
    mainRef = await gh(token, 'GET',
      `/repos/${REPO.owner}/${REPO.repo}/git/ref/heads/${REPO.branch}`);
  } catch (e) {
    return { ok: false, error: '读主仓库 main 失败：' + e.message };
  }
  const mainSha = mainRef.object.sha;

  try {
    await gh(token, 'PATCH',
      `/repos/${fork.owner}/${fork.repo}/git/refs/heads/${REPO.branch}`, {
        sha: mainSha,
        force: true              // ← 强制，丢掉分叉
      });
  } catch (e) {
    return { ok: false, error: '强制同步 fork 失败：' + e.message };
  }
  console.log('recover: fork main 已强制对齐到主仓库', mainSha.slice(0, 8));

  // 2. 扫描「已审核通过但没推送」的投稿
  const pending = await approvedNotPushed(env);
  if (!pending.length) {
    return { ok: true, replayed: 0, colleges: [] };
  }

  // 3. 逐条重新提交到 fork 的 main
  const colleges = new Set();
  let replayed = 0;

  for (const item of pending) {
    const dir = `${WORKS_DIR}/${item.collegeDir}`;
    const uploaded = [];
    let failed = null;

    for (const f of item.files || []) {
      const obj = await env.SUBMIT_BUCKET.get(`${item.id}/${f.name}`);
      if (!obj) { failed = `R2 里找不到 ${item.id}/${f.name}`; break; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      try {
        await gh(token, 'PUT',
          `/repos/${fork.owner}/${fork.repo}/contents/${enc(dir + '/' + f.name)}`, {
            message: `replay after conflict: ${f.name}`,
            content: b64(bytes),
            branch: REPO.branch
          });
        uploaded.push(f.name);
      } catch (e) { failed = e.message; break; }
    }

    if (failed) {
      console.error('recover: 重放', item.id, '失败', failed);
      continue;
    }

    try {
      await updateList(token, fork, dir, uploaded, REPO.branch);
    } catch (e) {
      console.error('recover: 重放', item.id, '的 list.txt 失败', e.message);
      continue;
    }

    colleges.add(item.collegeName);
    replayed++;
  }

  return { ok: true, replayed, colleges: [...colleges] };
}

// 列出「已审核通过、但还没推送」的投稿
async function approvedNotPushed(env) {
  const out = [];
  const seen = new Set();
  let cursor;

  try {
    do {
      const page = await env.SUBMIT_BUCKET.list({ prefix: '', cursor });
      for (const obj of ((page && page.objects) || [])) {
        const key = (obj && obj.key) || '';
        const m = /^([0-9A-Z]{6})\/_approved\.json$/.exec(key);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);

        const id = m[1];
        // 推过的、拒绝过的，都不算
        if (await env.SUBMIT_BUCKET.get(`${id}/_pushed.json`)) continue;
        if (await env.SUBMIT_BUCKET.get(`${id}/_rejected.json`)) continue;

        const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
        if (!meta) continue;
        const mm = JSON.parse(await meta.text());
        out.push({ ...mm, id });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.error('approvedNotPushed 失败', e && e.message);
  }

  return out;
}

// 把「已审核通过、但还没推送」的投稿全部标记为「已推送」
//
// 以前按 branch 匹配（每个投稿一个分支），现在所有内容都在 fork 的 main 上，
// 一个 PR 就全推走了 —— 所以改成「凡是还没标记过的都标记」。
async function markPushed(env, res) {
  const items = await approvedNotPushed(env);
  let n = 0;
  for (const it of items) {
    try {
      await env.SUBMIT_BUCKET.put(`${it.id}/_pushed.json`, JSON.stringify({
        at: Date.now(), ...res
      }), { httpMetadata: { contentType: 'application/json' } });
      n++;
    } catch (e) { /* 单条失败不影响其他 */ }
  }
  console.log('markPushed: 标记了', n, '条');
}

/* ---- 已审核通过、但还没推送到主仓库的投稿 ---- */
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
      // 推过的不用再列
      if (await env.SUBMIT_BUCKET.get(`${m[1]}/_pushed.json`)) continue;
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

  // 拒绝 = 撤回之前的审核通过。
  // 不清掉的话状态会变成「既通过又拒绝」，而推送时只认 approved —— 会出现
  // 「列表显示已拒绝，但内容照样被推上去」这种不对账的情况。
  await env.SUBMIT_BUCKET.delete(`${id}/_approved.json`);

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