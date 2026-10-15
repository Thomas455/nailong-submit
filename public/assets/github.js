/* ============================================================================
   通过 GitHub API 提交作品：fork → 建分支 → 传图 → 改 list.txt → 提 PR

   全程用**投稿者自己的 token**，所以 PR 的作者是他本人，不是机器人。
   好处是 GitHub 记录里追溯得到人，出了问题能找到提交者。

   ---- 为什么必须 fork ----
   投稿者对你的仓库没有写权限，不改 fork 就没法提 PR。这是 GitHub 的模型决定的。

   ---- fork 的两个坑 ----
   1. **异步**：POST /forks 返回后，fork 不一定马上可用，要轮询等它就绪。
   2. **会陈旧**：fork 是「某个时刻的快照」。同一个投稿者第二次投稿时，
      他的 fork 可能落后主仓库很多，直接在上面改会让 PR 混进一堆无关差异。
      → 对策：每次投稿前先 merge-upstream 把 fork 的 main 同步到最新。
        同步失败（比如有冲突）不致命，继续用现有的 main 也能提 PR。

   ---- 这些接口要求 token 有 public_repo ----
   这是「fork + 往 fork 推内容 + 提 PR」的最低权限，GitHub 的粒度下限。
   ============================================================================ */
(function (global) {
  'use strict';

  var API = 'https://api.github.com';
  var CFG = global.SUBMIT_CONFIG;

  // ---- 底层请求 ----
  function req(token, method, path, body) {
    var opt = {
      method: method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }

    return fetch(API + path, opt).then(function (r) {
      // 204 没有 body
      if (r.status === 204) return null;
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* 非 JSON */ }

        if (r.ok) return data;

        // 把 GitHub 的错误信息翻成人话
        var msg = (data && data.message) || ('HTTP ' + r.status);
        var err = new Error(translateError(r.status, msg));
        err.status = r.status;
        err.detail = msg;
        throw err;
      });
    });
  }

  function translateError(status, msg) {
    if (status === 401) return '登录已过期，请重新登录 GitHub';
    if (status === 403) {
      if (/rate limit/i.test(msg)) return 'GitHub 接口调用太频繁了，等一小时再试（或者换个账号）';
      return '没有权限：可能是授权时没勾选仓库权限，或者 token 已失效。退出重新登录试试';
    }
    if (status === 404) return '找不到目标（仓库或文件），可能名字写错了，或者 fork 还没建好';
    if (status === 409) return '文件冲突：这个分支或文件刚被别人改过，稍后再试一次';
    if (status === 422) return 'GitHub 拒绝了这次提交：' + msg;
    return msg;
  }

  // ---- base64 编码（要分段，否则大图会爆栈）----
  function toBase64(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var chunk = 0x8000;           // 32KB 一段
      var parts = [];
      for (var i = 0; i < bytes.length; i += chunk) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
      }
      return btoa(parts.join(''));
    });
  }

  function fromBase64(b64) {
    // GitHub 返回的 base64 带换行，先去掉
    var s = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---- 1. 确保 fork 存在且是新的 ----
  function ensureFork(token, login, onStep) {
    var owner = CFG.owner, repo = CFG.repo;

    onStep('检查你的 fork…');
    return req(token, 'GET', '/repos/' + login + '/' + repo)
      .then(function (fork) {
        // 已经有了
        return syncFork(token, login, onStep).then(function () { return fork; });
      })
      .catch(function (e) {
        if (e.status !== 404) throw e;

        // 没有就建一个
        onStep('第一次投稿，正在为你创建仓库副本（fork）…');
        return req(token, 'POST', '/repos/' + owner + '/' + repo + '/forks', {})
          .then(function () {
            // fork 是异步的，轮询等它就绪（最多等约 30 秒）
            var tries = 0;
            function poll() {
              tries++;
              return req(token, 'GET', '/repos/' + login + '/' + repo)
                .then(function (f) { return f; })
                .catch(function () {
                  if (tries > 15) throw new Error('仓库副本创建超时，请过一会儿再试');
                  return sleep(2000).then(poll);
                });
            }
            return poll();
          });
      });
  }

  // 把 fork 的默认分支同步到上游最新（避免陈旧 fork 带来无关差异）
  function syncFork(token, login, onStep) {
    var owner = CFG.owner, repo = CFG.repo;
    onStep('同步你的副本到最新…');
    return req(token, 'POST', '/repos/' + login + '/' + repo + '/merge-upstream',
               { branch: CFG.baseBranch })
      .then(function () { return true; })
      .catch(function (e) {
        // 422 = 已经是最新（GitHub 有时这么返回）；409 = 有冲突
        // 都不致命：继续用现有的 main，PR 顶多多几个无关差异
        if (e.status === 422 || e.status === 409) return false;
        return false;
      });
  }

  // ---- 2. 建分支 ----
  function createBranch(token, login, branch, onStep) {
    var repo = CFG.repo;
    onStep('创建提交分支…');

    // 先拿 main 的最新 commit sha
    return req(token, 'GET', '/repos/' + login + '/' + repo + '/git/ref/heads/' + CFG.baseBranch)
      .then(function (ref) {
        return req(token, 'POST', '/repos/' + login + '/' + repo + '/git/refs', {
          ref: 'refs/heads/' + branch,
          sha: ref.object.sha
        });
      });
  }

  // ---- 3. 传一个文件（已存在则更新）----
  function putFile(token, login, branch, path, blob, message) {
    var repo = CFG.repo;
    var api = '/repos/' + login + '/' + repo + '/contents/' + encodePath(path);

    return toBase64(blob).then(function (b64) {
      // 先看文件在不在 —— 在的话必须带上 sha，否则 GitHub 会拒绝更新
      return req(token, 'GET', api + '?ref=' + encodeURIComponent(branch))
        .then(function (existing) { return existing.sha; })
        .catch(function (e) {
          if (e.status === 404) return null;   // 新文件
          throw e;
        })
        .then(function (sha) {
          var body = { message: message, content: b64, branch: branch };
          if (sha) body.sha = sha;
          return req(token, 'PUT', api, body);
        });
    });
  }

  // 路径里的每段都要编码，但斜杠要留着当分隔符
  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  // ---- 4. 读 list.txt ----
  function getList(token, login, branch, dir) {
    var api = '/repos/' + login + '/' + CFG.repo + '/contents/' +
              encodePath(dir + '/list.txt');

    return req(token, 'GET', api + '?ref=' + encodeURIComponent(branch))
      .then(function (f) {
        return { text: fromBase64(f.content), sha: f.sha, exists: true };
      })
      .catch(function (e) {
        if (e.status === 404) return { text: '', sha: null, exists: false };
        throw e;
      });
  }

  // ---- 5. 提 PR ----
  function createPR(token, login, branch, title, body) {
    return req(token, 'POST', '/repos/' + CFG.owner + '/' + CFG.repo + '/pulls', {
      title: title,
      body: body,
      head: login + ':' + branch,     // 跨 fork 提 PR 要写成 "用户名:分支名"
      base: CFG.baseBranch
    });
  }

  /**
   * 完整提交流程
   * @param {string} token  投稿者的 access token
   * @param {string} login  投稿者的用户名
   * @param {object} job    { dir, collegeName, items:[{name, blob, info}], note }
   *                        info = { w, h, before, after, quality, mime }
   * @param {function} onStep 进度回调 (文字)
   * @returns {Promise<{prUrl:string, prNumber:number, branch:string, files:string[]}>}
   */
  function submit(token, login, job, onStep) {
    onStep = onStep || function () {};

    // 分支名带时间戳 + 随机串：同一秒提交两次也不会撞
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    var rand = Math.random().toString(36).slice(2, 6);
    var branch = 'submit/' + stamp + '-' + rand;

    var uploaded = [];      // 文件名列表（给 list.txt 用）
    var detail = [];        // 带规格的明细（给 PR 描述用）

    return ensureFork(token, login, onStep)
      .then(function () { return createBranch(token, login, branch, onStep); })

      // 传图片
      .then(function () {
        onStep('上传 ' + job.items.length + ' 张图片…');
        // 串行传：并行容易撞 GitHub 的二级限流，而且串行进度更好看
        return job.items.reduce(function (chain, it, i) {
          return chain.then(function () {
            onStep('上传图片 ' + (i + 1) + '/' + job.items.length + '：' + it.name);
            var path = CFG.worksDir + '/' + job.dir + '/' + it.name;
            return putFile(token, login, branch, path,
                           it.blob, 'add ' + it.name + ' to ' + job.collegeName)
              .then(function () {
                uploaded.push(it.name);
                detail.push({
                  name: it.name,
                  info: it.info || null,
                  path: path
                });
              });
          });
        }, Promise.resolve());
      })

      // 更新 list.txt
      .then(function () {
        onStep('更新作品清单 list.txt…');
        return getList(token, login, branch, CFG.worksDir + '/' + job.dir);
      })
      .then(function (lst) {
        // 主站的规则：list.txt 里写在**下面**的显示在**上面**（当最新的）。
        // 所以新作品追加到末尾。
        var lines = lst.text ? lst.text.split(/\r?\n/).filter(function (s) {
          return s.trim() !== '';
        }) : [];

        // 去掉同名的旧条目（避免重复），再加新的
        var seen = {};
        uploaded.forEach(function (n) { seen[n.toLowerCase()] = 1; });
        lines = lines.filter(function (l) { return !seen[l.trim().toLowerCase()]; });
        lines = lines.concat(uploaded);

        var text = lines.join('\n') + '\n';
        var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        var path = CFG.worksDir + '/' + job.dir + '/list.txt';

        // putFile 会自己查 sha，这里直接复用
        return putFile(token, login, branch, path, blob,
                       'update list.txt for ' + job.collegeName);
      })

      // 提 PR
      .then(function () {
        onStep('创建 Pull Request…');
        var title = '[投稿] ' + job.collegeName + ' · ' + uploaded.length + ' 件作品';
        var body = buildPRBody(login, job, detail, branch);
        return createPR(token, login, branch, title, body);
      })
      .then(function (pr) {
        onStep('完成');
        return {
          prUrl: pr.html_url,
          prNumber: pr.number,
          branch: branch,
          files: uploaded
        };
      });
  }

  // ---- PR 描述 ----
  // 目标是让维护者**不用点开任何文件**就能判断该不该合并：
  // 学院对不对、每张图什么规格、有没有异常。
  function buildPRBody(login, job, detail, branch) {
    var L = [];

    L.push('## 投稿 · ' + job.collegeName);
    L.push('');
    L.push('| 项 | 值 |');
    L.push('| --- | --- |');
    L.push('| 投稿人 | [@' + login + '](https://github.com/' + login + ') |');
    L.push('| 学院 | ' + job.collegeName + ' |');
    L.push('| 目标目录 | `' + CFG.worksDir + '/' + job.dir + '/` |');
    L.push('| 作品数 | ' + detail.length + ' 件 |');
    L.push('| 提交时间 | ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC |');
    L.push('');

    // 投稿人自己写的说明（如果有）
    var note = (job.note || '').trim();
    if (note) {
      L.push('### 投稿人的话');
      L.push('');
      L.push(note.split(/\r?\n/).map(function (s) { return '> ' + s; }).join('\n'));
      L.push('');
    }

    L.push('### 作品明细');
    L.push('');
    L.push('| # | 文件名 | 尺寸 | 体积 | 压缩 | 画质 | 查看 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    detail.forEach(function (d, i) {
      var n = d.name;
      var info = d.info;

      // 「查看」指向**投稿者 fork 里那个分支**上的文件。
      // 不能指向上游仓库：文件还没合并，上游那边根本不存在。
      // 带上分支名，否则 blob 会去看默认分支（那里也没有）。
      var viewUrl = 'https://github.com/' + login + '/' + CFG.repo +
                    '/blob/' + encodeURIComponent(branch) + '/' + encodePath(d.path);

      var cells = [];
      if (info) {
        var saved = info.before > 0 ? ((1 - info.after / info.before) * 100).toFixed(0) + '%' : '—';
        cells.push(info.w + '×' + info.h);
        cells.push(fmtSize(info.after));
        cells.push('省 ' + saved);
        cells.push(Math.round(info.quality * 100) + '%');
      } else {
        cells.push('—', '—', '—', '—');
      }

      L.push('| ' + (i + 1) + ' | `' + n + '` | ' + cells.join(' | ') +
             ' | [打开](' + viewUrl + ') |');
    });
    L.push('');

    // 一个总入口：直接把这次改动的文件列表摊开，省得在 PR 的 Files changed 里翻
    L.push('### 本次改动');
    L.push('');
    L.push('- `' + CFG.worksDir + '/' + job.dir + '/` 新增 ' + detail.length + ' 个文件');
    L.push('- 更新 `' + CFG.worksDir + '/' + job.dir + '/list.txt`（把新作品追加到末尾）');
    L.push('');
    L.push('> **关于预览**：这里没有内嵌缩略图。GitHub 对 PR 描述里相对路径图片的解析');
    L.push('> 行为不稳定，解析错了会显示一排裂图。点上面表格里的「打开」看原图更可靠。');
    L.push('');

    L.push('---');
    L.push('');
    L.push('**维护者检查清单**');
    L.push('');
    L.push('- [ ] 学院对不对（决定作品出现在哪个卡片下）');
    L.push('- [ ] 内容合适（没有不当内容、没有侵权素材）');
    L.push('- [ ] 文件名清楚（会显示在展览馆里，鼠标悬停可见）');
    L.push('');
    L.push('> 合并后 Cloudflare 会自动重新部署，作品出现在 ' +
           '[奶龙展览馆](https://xn--psszg58cydsdq780c.com/show) 对应学院的卡片里。');

    return L.join('\n');
  }

  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  global.SubmitGitHub = {
    submit: submit,
    buildPRBody: buildPRBody,   // 导出给测试用
    _req: req,
    _toBase64: toBase64
  };
})(window);
