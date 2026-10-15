/* ============================================================================
   投稿页主逻辑

   部署在 submit.宇宙奶龙大学.com（独立子域名），和主站是两个站点。
   OAuth 的 redirect_uri 必须是这个子域名下的地址，所以 Worker 里用的是
   url.origin —— 它在哪个域名下跑就自动用哪个，本地 wrangler dev 也能用。

   ---- 为什么 token 不存 localStorage ----
   存了就能少一次登录，但一旦页面有 XSS，token 就被偷走了（而且 public_repo
   权限不小）。投稿不是高频操作，刷新页面重新登录的成本可以接受，
   换来的是 token 只活在当前页面内存里，关掉就没了。
   ============================================================================ */
(function () {
  'use strict';

  var CFG = window.SUBMIT_CONFIG;

  // ---- 状态 ----
  var state = {
    token: null,
    login: null,
    avatar: null,
    college: null,       // { name, dir }
    items: [],           // [{ id, file, outName, blob, url, status, error, info }]
    submitting: false
  };
  var seq = 0;

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };
  var step1 = $('step1'), step2 = $('step2'), step3 = $('step3'), step4 = $('step4');
  var loginBtn = $('loginBtn'), whoami = $('whoami');
  var collegeBox = $('colleges'), collegeSearch = $('collegeSearch'), picked = $('picked');
  var drop = $('drop'), fileInput = $('fileInput'), filesEl = $('files'), counter = $('counter');
  var extraNote = $('extraNote'), submitBtn = $('submitBtn'), logoutBtn = $('logoutBtn');
  var logBox = $('log'), logTitle = $('logTitle'), logSteps = $('logSteps'), logResult = $('logResult');

  /* ============================================================
     一、登录
     ============================================================ */

  // 每次登录生成一个随机 nonce。授权绕一圈回来时带着它，
  // 对上了才认 —— 避免多个标签页同时登录时收错 token。
  var oauthNonce = null;

  loginBtn.addEventListener('click', function () {
    // 开个弹窗走 OAuth。用弹窗而不是整页跳转，是为了不丢掉用户已经填好的东西。
    oauthNonce = randomNonce();

    var w = 620, h = 720;
    var left = Math.max(0, (screen.width - w) / 2);
    var top = Math.max(0, (screen.height - h) / 2);
    var pop = window.open('/api/login?nonce=' + encodeURIComponent(oauthNonce),
      'nailong_oauth',
      'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top);

    if (!pop) {
      alert('弹窗被浏览器拦住了。请允许本站弹窗，然后重试。');
    }
  });

  // 收 token 的两条通道（和 worker 那边对应）：
  //   · BroadcastChannel —— 主通道，不依赖 window.opener
  //   · message 事件      —— 后备
  function onToken(msg) {
    if (!msg || msg.type !== 'nailong-oauth') return;

    // 认领：nonce 对不上就忽略（可能是别的标签页的登录结果）
    if (oauthNonce && msg.nonce && msg.nonce !== oauthNonce) return;

    if (msg.error) {
      alert('授权失败：' + msg.error);
      return;
    }
    if (!msg.token) return;

    state.token = msg.token;
    oauthNonce = null;      // 用掉了，防重放
    verifyToken();
  }

  try {
    if (window.BroadcastChannel) {
      var authCh = new BroadcastChannel('nailong-oauth');
      authCh.onmessage = function (e) { onToken(e.data); };
    }
  } catch (e) { /* 不支持就算了，还有 message 后备 */ }

  window.addEventListener('message', function (e) { onToken(e.data); });

  function randomNonce() {
    try {
      var a = new Uint8Array(12);
      crypto.getRandomValues(a);
      return Array.from(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (e) {
      return String(Math.random()).slice(2) + Date.now().toString(36);
    }
  }

  // 拿 token 换用户信息（顺便验证 token 有效）
  function verifyToken() {
    fetch('https://api.github.com/user', {
      headers: {
        'Authorization': 'Bearer ' + state.token,
        'Accept': 'application/vnd.github+json'
      }
    }).then(function (r) {
      if (!r.ok) throw new Error('token 无效（' + r.status + '）');
      return r.json();
    }).then(function (u) {
      state.login = u.login;
      state.avatar = u.avatar_url;

      whoami.hidden = false;
      whoami.innerHTML = '<img alt="" referrerpolicy="no-referrer">' +
        '<span>已登录：<b></b></span>';
      whoami.querySelector('img').src = u.avatar_url;
      whoami.querySelector('b').textContent = u.login;
      loginBtn.hidden = true;

      // 解锁后面两步
      step2.hidden = false;
      step3.hidden = false;
      step4.hidden = false;
      step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      alert('登录状态有问题：' + e.message + '\n请重新登录。');
      state.token = null;
    });
  }

  logoutBtn.addEventListener('click', function () {
    // 内存里的 token 清掉就没了（没存 localStorage）
    state.token = null;
    state.login = null;
    state.avatar = null;
    state.items = [];
    renderFiles();
    whoami.hidden = true;
    loginBtn.hidden = false;
    step2.hidden = step3.hidden = step4.hidden = true;
    logBox.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ============================================================
     二、学院选择
     ============================================================ */

  (function buildColleges() {
    var frag = document.createDocumentFragment();
    CFG.colleges.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'college';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', 'false');
      b.dataset.name = c.name;
      b.textContent = c.name;
      b.addEventListener('click', function () { pickCollege(c, b); });
      frag.appendChild(b);
    });
    collegeBox.appendChild(frag);
  })();

  function pickCollege(c, btn) {
    state.college = c;
    Array.prototype.forEach.call(collegeBox.children, function (el) {
      el.setAttribute('aria-selected', String(el === btn));
    });
    picked.hidden = false;
    picked.textContent = '已选择：' + c.name + '　→　作品会放进 works/' + c.dir + '/';
    updateCounter();

    // 选完学院自动带用户去看下一步
    step3.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  collegeSearch.addEventListener('input', function () {
    var q = collegeSearch.value.trim().toLowerCase();
    Array.prototype.forEach.call(collegeBox.children, function (el) {
      var hit = !q || el.dataset.name.toLowerCase().indexOf(q) >= 0;
      el.hidden = !hit;
    });
  });

  /* ============================================================
     三、选图 + 命名
     ============================================================ */

  drop.addEventListener('click', function () { fileInput.click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';      // 允许再选同一个文件
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      drop.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('over');
    });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  // 整页拖放也别让浏览器直接打开图片（那会丢掉当前进度）
  ['dragover', 'drop'].forEach(function (ev) {
    window.addEventListener(ev, function (e) {
      if (!drop.contains(e.target)) e.preventDefault();
    });
  });

  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    // 只收图片。HEIC 也放进来 —— 处理时会给出明确提示，比静默忽略好
    files = files.filter(function (f) {
      return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name);
    });

    var room = CFG.maxFiles - state.items.length;
    if (room <= 0) {
      alert('一次最多投 ' + CFG.maxFiles + ' 张。想投更多请分几次提交。');
      return;
    }
    if (files.length > room) {
      alert('一次最多投 ' + CFG.maxFiles + ' 张，这次只收前 ' + room + ' 张。');
      files = files.slice(0, room);
    }

    files.forEach(function (f) {
      // 默认文件名 = 去掉扩展名的原文件名，消毒后使用
      var base = f.name.replace(/\.[^.]+$/, '');
      var item = {
        id: ++seq,
        file: f,
        outName: window.SubmitImage.sanitizeName(base) || ('作品' + seq),
        blob: null,
        url: null,
        status: 'pending',
        error: null,
        info: null
      };
      state.items.push(item);
      processItem(item);
    });

    renderFiles();
    updateCounter();
  }

  // 逐张处理：读 → 缩放 → 转 webp → 压缩
  function processItem(item) {
    item.status = 'working';
    renderFiles();

    window.SubmitImage.process(item.file, item.outName)
      .then(function (r) {
        item.blob = r.blob;
        item.status = 'ready';
        item.info = {
          w: r.width,
          h: r.height,
          before: r.originalSize,
          after: r.blob.size,
          quality: r.quality,
          mime: r.mime
        };
        // 缩略图用处理后的小图，省内存
        item.url = URL.createObjectURL(r.blob);
      })
      .catch(function (e) {
        item.status = 'error';
        item.error = e.message;
      })
      .then(function () {
        renderFiles();
        updateCounter();
      });
  }

  // 改名要重新处理吗？不用 —— 文件名只影响上传路径，
  // 内容已经处理好了，改个名直接改字段即可。
  function renderFiles() {
    filesEl.innerHTML = '';
    state.items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'file' + (item.status === 'error' ? ' bad' : '');

      var img = document.createElement('img');
      img.className = 'thumb';
      img.alt = '';
      if (item.url) img.src = item.url;
      else if (item.status === 'working') img.style.background = 'rgba(254,206,14,.08)';

      var meta = document.createElement('div');
      meta.className = 'meta';

      var input = document.createElement('input');
      input.type = 'text';
      input.value = item.outName;
      input.setAttribute('aria-label', '作品名字');
      input.placeholder = '给这件作品起个名字';
      input.addEventListener('input', function () {
        item.outName = window.SubmitImage.sanitizeName(input.value);
      });
      input.addEventListener('blur', function () {
        // 失焦时把消毒后的名字回填，让用户看到实际会用什么
        input.value = item.outName;
      });

      var info = document.createElement('div');
      info.className = 'info';
      if (item.status === 'working') {
        info.innerHTML = '<span class="spin"></span> 正在处理…';
      } else if (item.status === 'error') {
        info.innerHTML = '<span class="err">✗ ' + escapeHtml(item.error) + '</span>';
      } else if (item.info) {
        var d = item.info;
        var saved = d.before > 0 ? (1 - d.after / d.before) * 100 : 0;
        var parts = [
          d.w + '×' + d.h,
          fmtSize(d.before) + ' → ' + fmtSize(d.after)
        ];
        if (saved > 3) parts.push('<span class="cut">省 ' + saved.toFixed(0) + '%</span>');
        info.innerHTML = parts.join(' · ');
      } else {
        info.textContent = '待处理';
      }

      meta.appendChild(input);
      meta.appendChild(info);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.setAttribute('aria-label', '移除这张');
      rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      rm.addEventListener('click', function () {
        if (item.url) URL.revokeObjectURL(item.url);
        state.items = state.items.filter(function (x) { return x !== item; });
        renderFiles();
        updateCounter();
      });

      li.appendChild(img);
      li.appendChild(meta);
      li.appendChild(rm);
      filesEl.appendChild(li);
    });
  }

  function updateCounter() {
    var ready = state.items.filter(function (i) { return i.status === 'ready'; }).length;
    var working = state.items.filter(function (i) { return i.status === 'working'; }).length;
    var bad = state.items.filter(function (i) { return i.status === 'error'; }).length;

    var txt = ready + ' / ' + CFG.maxFiles;
    if (working) txt += '（' + working + ' 张处理中）';
    counter.textContent = txt;

    var canSubmit = Boolean(state.token && state.college) && ready > 0 && working === 0 && !state.submitting;
    submitBtn.disabled = !canSubmit;
    if (bad && ready === 0) submitBtn.disabled = true;
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============================================================
     四、提交
     ============================================================ */

  submitBtn.addEventListener('click', function () {
    if (state.submitting) return;
    if (!state.token || !state.college) return;

    var ready = state.items.filter(function (i) { return i.status === 'ready'; });
    if (!ready.length) { alert('至少加一张作品'); return; }

    // 重名检查：同一个名字传两张，后一张会覆盖前一张
    var seen = {};
    var dup = ready.filter(function (i) {
      var k = i.outName.toLowerCase();
      if (seen[k]) return true;
      seen[k] = 1;
      return false;
    });
    if (dup.length) {
      alert('有重名的作品：' + dup.map(function (i) { return i.outName; }).join('、') +
            '\n请改成不同的名字，否则会互相覆盖。');
      return;
    }

    // 名字不能为空
    var empty = ready.filter(function (i) { return !i.outName; });
    if (empty.length) { alert('有作品还没起名字'); return; }

    state.submitting = true;
    updateCounter();
    submitBtn.disabled = true;
    logBox.hidden = false;
    logTitle.className = '';
    logTitle.textContent = '正在提交…';
    logSteps.innerHTML = '';
    logResult.innerHTML = '';
    logBox.scrollIntoView({ behavior: 'smooth', block: 'start' });

    var lines = [];   // 进度行

    function onStep(text) {
      // 上一行标成完成，新的一行标成进行中
      if (lines.length) lines[lines.length - 1].el.className = 'done';
      var li = document.createElement('li');
      li.className = 'now';
      li.innerHTML = '<span class="dot"></span><span></span>';
      li.querySelector('span:last-child').textContent = text;
      logSteps.appendChild(li);
      lines.push({ el: li });
      logBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    var job = {
      dir: state.college.dir,
      collegeName: state.college.name,
      // info 带上尺寸/体积/画质，会写进 PR 描述 ——
      // 维护者不用点开文件就能判断该不该合并
      items: ready.map(function (i) {
        return {
          name: i.outName + extOf(i.info.mime),
          blob: i.blob,
          info: i.info
        };
      }),
      note: extraNote.value.trim()
    };

    window.SubmitGitHub.submit(state.token, state.login, job, onStep)
      .then(function (res) {
        if (lines.length) lines[lines.length - 1].el.className = 'done';
        logTitle.className = 'ok';
        logTitle.textContent = '投稿成功！';

        var note = extraNote.value.trim();
        logResult.innerHTML =
          '<p>Pull Request 已经建好：<a href="' + res.prUrl + '" target="_blank" rel="noopener">#' +
          res.prNumber + '</a></p>' +
          '<p style="color:var(--muted);font-size:13px;margin-top:8px">' +
          '维护者合并后，作品会出现在展览馆里。你可以在 GitHub 上跟踪这个 PR 的进度。</p>';
        if (note) { /* 说明已经写进 PR 描述，这里不用重复 */ }

        // 提交完清空，避免手滑再点一次重复投
        state.items.forEach(function (i) { if (i.url) URL.revokeObjectURL(i.url); });
        state.items = [];
        renderFiles();
        extraNote.value = '';
      })
      .catch(function (e) {
        if (lines.length) lines[lines.length - 1].el.className = 'done';
        logTitle.className = 'bad';
        logTitle.textContent = '提交失败';
        logResult.innerHTML = '<p class="err">' + escapeHtml(e.message) + '</p>' +
          '<p style="color:var(--muted);font-size:13px;margin-top:8px">' +
          '已经上传的部分会留在你的仓库分支里，可以重试（会新建一个分支）。</p>';
      })
      .then(function () {
        state.submitting = false;
        updateCounter();
      });
  });

  function extOf(mime) {
    return mime === 'image/webp' ? '.webp' : '.jpg';
  }

  /* ============================================================
     启动
     ============================================================ */

  // 先问一下服务端 OAuth 配好了没，没配就直接提示，别让用户白点
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    if (!c.ready) {
      loginBtn.disabled = true;
      loginBtn.textContent = '服务端还没配好 OAuth（见 README）';
    }
  }).catch(function () {
    // 本地用 file:// 打开时会走到这里。不影响看界面。
  });

  updateCounter();
})();
