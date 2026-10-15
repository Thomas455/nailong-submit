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
    mode: 'gh',             // 'gh' | 'guest'
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
  var stepMine = $('stepMine'), mineList = $('mineList'), refreshMine = $('refreshMine');
  var modeGh = $('modeGh'), modeGuest = $('modeGuest');
  var guestBits = $('guestBits'), submitHint = $('submitHint');
  var stepStatus = $('stepStatus'), statusId = $('statusId'), statusBtn = $('statusBtn'),
      statusResult = $('statusResult');
  var turnstileWidget = null;

  /* ============================================================
     零、选一条路（GitHub 登录 / 游客投稿）
     ============================================================ */

  function setMode(mode) {
    if (state.mode === mode) return;
    applyMode(mode);
  }

  // 真正干活的：设置状态 + 同步界面。首次初始化也走这里。
  function applyMode(mode) {
    state.mode = mode;

    modeGh.setAttribute('aria-pressed', String(mode === 'gh'));
    modeGuest.setAttribute('aria-pressed', String(mode === 'guest'));

    var guest = mode === 'guest';

    // 第 1 步（登录卡片）在游客模式下不显示；「我投过的稿」保持独立
    step1.hidden = guest;
    stepStatus.hidden = !guest;

    submitBtn.textContent = guest ? '提交到审核队列' : '提交投稿';
    if (guest) {
      submitHint.innerHTML = '提交后会进入审核队列，维护者看过后才会发布到展览馆。' +
        '图片里的手机定位等隐私信息会被自动抹掉。';
      loadTurnstile();
    } else {
      submitHint.innerHTML = '提交后会创建 Pull Request。主站维护者合并后，作品会出现在 ' +
        '<a href="https://xn--psszg58cydsdq780c.com/show" target="_blank" rel="noopener">奶龙展览馆</a>' +
        '对应学院的卡片里。';
      guestBits.hidden = true;
    }

    // 已选的文件保留（用户可能只是切回来）
    updateCounter();
  }

  modeGh.addEventListener('click', function () { setMode('gh'); });
  modeGuest.addEventListener('click', function () { setMode('guest'); });

  /* ============================================================
     Turnstile（游客模式的人机验证）
     ============================================================ */

  var guestCfg = null;   // 服务端下发的 site key

  function loadTurnstile() {
    if (guestBits.hidden === false && turnstileWidget) return;
    if (!guestCfg || !guestCfg.turnstileSiteKey) {
      guestBits.innerHTML = '<p class="note">验证码还没配好，暂时只能用 GitHub 登录投稿。</p>';
      return;
    }
    if (!window.turnstile) {
      // 按需加载：只有游客模式才拉这个脚本
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = mountTurnstile;
      document.head.appendChild(s);
    } else {
      mountTurnstile();
    }
  }

  function mountTurnstile() {
    if (turnstileWidget || !window.turnstile || !guestCfg) return;
    guestBits.hidden = false;
    turnstileWidget = window.turnstile.render('#turnstile', {
      sitekey: guestCfg.turnstileSiteKey,
      callback: function () { updateCounter(); },
      'expired-callback': function () { updateCounter(); },
      'error-callback': function () { updateCounter(); }
    });
  }

  function getTurnstileToken() {
    if (state.mode !== 'guest') return 'N/A';     // GitHub 模式不用验证码
    if (!turnstileWidget) return null;
    try { return window.turnstile.getResponse(turnstileWidget); }
    catch (e) { return null; }
  }

  function resetTurnstile() {
    if (turnstileWidget) { try { window.turnstile.reset(turnstileWidget); } catch (e) {} }
    updateCounter();
  }

  /* ============================================================
     查投稿状态
     ============================================================ */

  statusBtn.addEventListener('click', function () {
    var id = statusId.value.trim().toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(id)) {
      statusResult.innerHTML = '<p class="note">编号是六位大写字母或数字。</p>';
      return;
    }
    statusResult.innerHTML = '<p class="note">查…</p>';
    fetch('/api/guest/status?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { statusResult.innerHTML = '<p class="note">' + escapeHtml(j.error || '查询失败') + '</p>'; return; }
        if (j.status === 'pending') {
          statusResult.innerHTML = '<p style="color:var(--ink)">编号 ' + id +
            '：等待审核中。维护者看过后会发布。</p>';
        } else if (j.status === 'published') {
          statusResult.innerHTML = '<p style="color:var(--go)">编号 ' + id + '：已发布！' +
            (j.prUrl ? ' <a href="' + escapeHtml(j.prUrl) + '" target="_blank" rel="noopener">查看提交</a>' : '') +
            '</p>';
        } else if (j.status === 'rejected') {
          statusResult.innerHTML = '<p style="color:var(--warn)">编号 ' + id + '：没有通过审核。' +
            (j.note ? '<br>原因：' + escapeHtml(j.note) : '') + '</p>';
        } else {
          statusResult.innerHTML = '<p class="note">没找到编号 ' + id + '，检查一下有没有输错。</p>';
        }
      })
      .catch(function (e) {
        statusResult.innerHTML = '<p class="note">查询失败：' + escapeHtml(e.message) + '</p>';
      });
  });

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

      // 游客模式一开始就能用第 2~4 步（不用等登录）
      step2.hidden = false;
      step3.hidden = false;
      step4.hidden = false;
      step2.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // 顺手拉一下「我投过的稿」
      stepMine.hidden = false;
      loadMine();
    }).catch(function (e) {
      alert('登录状态有问题：' + e.message + '\n请重新登录。');
      state.token = null;
    });
  }

  /* ============================================================
     我投过的稿：查自己 PR 的审核状态
     ============================================================ */

  function loadMine() {
    if (!state.token || !state.login) return;

    mineList.innerHTML = '<p class="note">正在查…</p>';

    window.SubmitGitHub.listMyPRs(state.token, state.login)
      .then(function (list) {
        renderMine(list);
      })
      .catch(function (e) {
        // 查不到不影响投稿，只是看不到历史记录而已 —— 别弹窗吓人
        mineList.innerHTML = '<p class="note">查不到投稿记录：' + escapeHtml(e.message) + '</p>';
      });
  }

  var STATUS_TEXT = {
    open:   { label: '待审核', cls: 'open' },
    merged: { label: '已合并', cls: 'merged' },
    closed: { label: '已关闭', cls: 'closed' }
  };

  function renderMine(list) {
    if (!list.length) {
      mineList.innerHTML = '<p class="note">你还没有投过稿。上面挑个学院开始吧。</p>';
      return;
    }

    // 新的在上（按 PR 编号排，编号越大越新）
    list.sort(function (a, b) { return b.number - a.number; });

    var html = '<ul class="mine">';
    list.forEach(function (pr) {
      var s = STATUS_TEXT[pr.status] || STATUS_TEXT.closed;
      var when = fmtDate(pr.updatedAt);
      var cnt = pr.count ? ('<b>' + pr.count + '</b> 件') : '';
      html += '<li class="mine-item">' +
        '<a class="mine-link" href="' + pr.url + '" target="_blank" rel="noopener">' +
          '<span class="mine-college">' + escapeHtml(pr.college) + '</span>' +
          '<span class="mine-meta">' + cnt + ' · #' + pr.number + ' · ' + when + '</span>' +
        '</a>' +
        '<span class="mine-status ' + s.cls + '">' + s.label + '</span>' +
      '</li>';
    });
    html += '</ul>';

    // 状态说明，省得用户猜「已关闭」是什么意思
    html += '<p class="note small">' +
      '「待审核」= 维护者还没看；「已合并」= 作品已经上线；' +
      '「已关闭」= PR 被关掉了（可能是你撤回，也可能没通过）。' +
      '状态点右上角「刷新」更新。</p>';

    mineList.innerHTML = html;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  refreshMine.addEventListener('click', loadMine);

  logoutBtn.addEventListener('click', function () {
    // 内存里的 token 清掉就没了（没存 localStorage）
    state.token = null;
    state.login = null;
    state.avatar = null;
    state.items = [];
    renderFiles();
    whoami.hidden = true;
    loginBtn.hidden = false;
    stepMine.hidden = true;      // 记录是按登录用户查的，退出就没意义了
    // 游客模式下这几步仍然可用，不要一起藏掉
    if (state.mode === 'gh') step2.hidden = step3.hidden = step4.hidden = true;
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

    var needAuth = state.mode === 'gh' && !state.token;
    var canSubmit = !needAuth && Boolean(state.college) &&
                    ready > 0 && working === 0 && !state.submitting;

    // 游客模式还要过了验证码才能提交
    if (canSubmit && state.mode === 'guest') {
      canSubmit = Boolean(getTurnstileToken());
    }

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

    // 两条路的共同前置：学院 + 至少一张图 + 名字合法
    if (state.mode === 'gh' && (!state.token || !state.college)) return;
    if (state.mode === 'guest' && !state.college) return;

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
    logTitle.textContent = state.mode === 'guest' ? '正在提交…' : '正在提交…';
    logSteps.innerHTML = '';
    logResult.innerHTML = '';
    logBox.scrollIntoView({ behavior: 'smooth', block: 'start' });

    var lines = [];
    function onStep(text) {
      if (lines.length) lines[lines.length - 1].el.className = 'done';
      var li = document.createElement('li');
      li.className = 'now';
      li.innerHTML = '<span class="dot"></span><span></span>';
      li.querySelector('span:last-child').textContent = text;
      logSteps.appendChild(li);
      lines.push({ el: li });
      logBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function done() { if (lines.length) lines[lines.length - 1].el.className = 'done'; }

    var job = {
      dir: state.college.dir,
      collegeName: state.college.name,
      items: ready.map(function (i) {
        return { name: i.outName + extOf(i.info.mime), blob: i.blob, info: i.info };
      }),
      note: extraNote.value.trim()
    };

    var pending = state.mode === 'guest'
      ? submitGuest(job, ready, onStep, done)
      : window.SubmitGitHub.submit(state.token, state.login, job, onStep);

    pending
      .then(function (res) {
        done();
        logTitle.className = 'ok';
        logTitle.textContent = '投稿成功！';

        if (state.mode === 'guest') {
          logResult.innerHTML =
            '<p>投稿编号 <b style="color:var(--ink);font-size:17px">' + res.id + '</b></p>' +
            '<p style="color:var(--muted);font-size:13px;margin-top:8px">' +
            '已经送到审核队列，维护者看过后就会发布。' +
            '用这个编号可以在下面「查投稿状态」里看进度。</p>';
          // 游客模式下把编号直接填好，省得用户记
          statusId.value = res.id;
          stepStatus.hidden = false;
        } else {
          logResult.innerHTML =
            '<p>Pull Request 已经建好：<a href="' + res.prUrl + '" target="_blank" rel="noopener">#' +
            res.prNumber + '</a></p>' +
            '<p style="color:var(--muted);font-size:13px;margin-top:8px">' +
            '维护者合并后，作品会出现在展览馆里。你可以在 GitHub 上跟踪这个 PR 的进度。</p>';
        }

        state.items.forEach(function (i) { if (i.url) URL.revokeObjectURL(i.url); });
        state.items = [];
        renderFiles();
        extraNote.value = '';

        // GitHub 模式下刷「我投过的稿」；游客模式重置验证码
        if (state.mode === 'gh') loadMine();
        else resetTurnstile();
      })
      .catch(function (e) {
        done();
        logTitle.className = 'bad';
        logTitle.textContent = '提交失败';
        logResult.innerHTML = '<p class="err">' + escapeHtml(e.message) + '</p>' +
          (state.mode === 'guest' ? '' :
           '<p style="color:var(--muted);font-size:13px;margin-top:8px">' +
           '已经上传的部分会留在你的仓库分支里，可以重试（会新建一个分支）。</p>');
        if (state.mode === 'guest') resetTurnstile();
      })
      .then(function () {
        state.submitting = false;
        updateCounter();
      });
  });

  // 游客投稿：把处理好的图打包成 multipart 交给 Worker
  function submitGuest(job, ready, onStep, done) {
    onStep('打包图片…');
    var fd = new FormData();
    fd.append('college', job.dir);
    if (job.note) fd.append('note', job.note);
    // 文件名要单独带一份：FormData 里的 File 用的是处理前的临时名
    job.items.forEach(function (it, i) {
      fd.append('files', new File([it.blob], it.name, { type: it.info.mime }));
    });
    var ts = getTurnstileToken();
    if (!ts) return Promise.reject(new Error('请先完成人机验证'));
    fd.append('tsToken', ts);

    onStep('上传到审核队列…');
    return fetch('/api/guest/submit', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        if (!x.r.ok || !x.j.ok) throw new Error(x.j.error || ('HTTP ' + x.r.status));
        return x.j;   // { ok, id }
      });
  }

  function extOf(mime) {
    return mime === 'image/webp' ? '.webp' : '.jpg';
  }

  /* ============================================================
     启动
     ============================================================ */

  // 游客模式的配置（Turnstile site key + 有没有配好）
  fetch('/api/guest/config').then(function (r) { return r.json(); }).then(function (c) {
    guestCfg = c;
    if (!c.ready) {
      modeGuest.setAttribute('aria-pressed', 'false');
      modeGuest.disabled = true;
      modeGuest.querySelector('span').textContent = '暂不可用';
    }
  }).catch(function () {
    // 本地用 file:// 打开会走到这里，不影响看界面
  });

  // GitHub 登录那条路配好了没
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    if (!c.ready) {
      loginBtn.disabled = true;
      loginBtn.textContent = '服务端还没配好 OAuth（见 README）';
    }
  }).catch(function () {});

  // 默认走游客模式：国内用户常常连不上 GitHub，别一上来就逼他们登录。
  // 第 2~4 步一开始就可见，不用等任何授权。
  step2.hidden = false;
  step3.hidden = false;
  step4.hidden = false;
  applyMode('guest');        // 内部会设置 state.mode 并同步界面

  updateCounter();
})();
