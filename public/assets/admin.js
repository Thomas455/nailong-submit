/* ============================================================================
   管理页逻辑

   鉴权说明：**前端不做任何安全判断**。
   这里只是「没登录就显示登录按钮」，真正的拦截在服务端 ——
   每个 /api/review/* 接口都会验签名 cookie，不通过直接 401。
   所以即便有人绕过这个文件直接调接口，也拿不到待审列表。
   ============================================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var gate = $('gate'), board = $('board'), queueEl = $('queue');
  var emptyEl = $('empty'), whoEl = $('who'), gateMsg = $('gateMsg');
  var drawer = $('drawer'), drawerBg = $('drawerBg'), drawerClose = $('drawerClose');
  var dTitle = $('dTitle'), dBody = $('dBody'), dMsg = $('dMsg'), adminNote = $('adminNote');
  var btnApprove = $('btnApprove'), btnReject = $('btnReject');
  // 待推送区
  var stage = $('stage'), stageList = $('stageList'), stageMsg = $('stageMsg');
  // 小号绑定
  var botStatus = $('botStatus'), botBind = $('botBind'), botUnbind = $('botUnbind');

  /* ============================================================
     小号绑定（OAuth）

     为什么用 OAuth 而不是 fine-grained PAT：
     PAT 的「Only select repositories」只能选 token 拥有者自己的仓库，
     小号选不到主仓库 —— 这是产品限制，改设置也绕不开。
     OAuth 的 public_repo 按仓库类型授权，没这个限制。
     ============================================================ */

  function loadBot() {
    fetch('/api/bot/status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.bound && j.alive) {
          botStatus.innerHTML = '小号：<b style="color:var(--go)">' + esc(j.login) + '</b> 已绑定';
          botBind.hidden = true;
          botUnbind.hidden = false;
        } else if (j && j.bound) {
          botStatus.innerHTML = '<span style="color:var(--warn)">绑定的账号 ' +
            esc(j.login || '未知') + ' 的 token 已失效，需要重新绑定</span>';
          botBind.hidden = false;
          botUnbind.hidden = false;
        } else {
          botStatus.innerHTML = '<span style="color:var(--warn)">还没绑定小号 —— ' +
            '「审核通过」和「推送」都需要它</span>';
          botBind.hidden = false;
          botUnbind.hidden = true;
        }
      })
      .catch(function (e) {
        botStatus.innerHTML = '<span style="color:var(--warn)">检查绑定状态失败：' +
          esc(e.message) + '</span>';
      });
  }

  botBind.addEventListener('click', function () {
    var w = 620, h = 720;
    var pop = window.open('/api/bot/login?nonce=' + nonce12(),
      'nailong_bot_oauth',
      'width=' + w + ',height=' + h +
      ',left=' + Math.max(0, (screen.width - w) / 2) +
      ',top=' + Math.max(0, (screen.height - h) / 2));
    if (!pop) alert('弹窗被拦了，请允许本站弹窗后重试。');
  });

  botUnbind.addEventListener('click', function () {
    if (!confirm('解绑小号？解绑后「审核通过」和「推送」都不能用了。')) return;
    fetch('/api/bot/unbind', { method: 'POST', credentials: 'same-origin' })
      .then(function () { loadBot(); })
      .catch(function (e) { alert('解绑失败：' + e.message); });
  });

  // 回调页的结果
  try {
    if (window.BroadcastChannel) {
      new BroadcastChannel('nailong-bot-auth').onmessage = function (e) {
        var m = e.data;
        if (!m || m.type !== 'nailong-bot-auth') return;
        if (m.ok) { loadBot(); alert('小号 ' + m.login + ' 已绑定。'); }
        else { alert('绑定失败：\n' + (m.error || '未知错误')); }
      };
    }
  } catch (e) {}

  var current = null;     // 当前打开的投稿 { id, ... }

  /* ============================================================
     登录
     ============================================================ */

  $('adminLogin').addEventListener('click', function () {
    var nonce = nonce12();
    var w = 620, h = 720;
    var pop = window.open('/api/admin/login?nonce=' + encodeURIComponent(nonce),
      'nailong_admin_oauth',
      'width=' + w + ',height=' + h + ',left=' + Math.max(0, (screen.width - w) / 2) +
      ',top=' + Math.max(0, (screen.height - h) / 2));
    if (!pop) alert('弹窗被拦了，请允许本站弹窗后重试。');
  });

  function onAuth(msg) {
    if (!msg || msg.type !== 'nailong-admin-auth') return;
    if (msg.error) {
      gateMsg.innerHTML = '<b style="color:var(--warn)">' + esc(msg.error) + '</b>';
      return;
    }
    if (msg.ok) {
      // 服务端已经发了签名 cookie，这里刷新一下队列
      check();
    }
  }

  // 两条通道，和 worker 的 admin.js 对应
  try {
    if (window.BroadcastChannel) {
      new BroadcastChannel('nailong-admin-auth').onmessage = function (e) { onAuth(e.data); };
    }
  } catch (e) {}
  window.addEventListener('message', function (e) { onAuth(e.data); });

  function nonce12() {
    try {
      var a = new Uint8Array(8);
      crypto.getRandomValues(a);
      return Array.from(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) { return String(Math.random()).slice(2, 12); }
  }

  /* ============================================================
     会话与列表
     ============================================================ */

  function check() {
    fetch('/api/admin/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.loggedIn) {
          gate.hidden = true;
          board.hidden = false;
          whoEl.innerHTML = '管理员：<b></b>';
          whoEl.querySelector('b').textContent = j.login;
          load();
          loadStage();      // 待推送的分支
          loadBot();        // 小号绑定状态
        } else {
          gate.hidden = false;
          board.hidden = true;
          stage.hidden = true;
        }
      })
      .catch(function (e) {
        // 之前这里是空的 catch，出错就什么都不显示
        console.error('检查登录状态失败', e);
        gate.hidden = false;
        gateMsg.innerHTML = '<b style="color:var(--warn)">连不上服务端：' +
          escapeHtml(e.message) + '</b>';
      });
  }

  // 页面顶部的错误条。队列加载失败时用它显示 ——
  // 之前错误只写进抽屉里的 dMsg，而抽屉是关着的，用户什么都看不到。
  var listErr = $('listErr');

  function showListError(text) {
    if (!listErr) return;
    if (!text) {
      listErr.hidden = true;
      listErr.textContent = '';
      return;
    }
    listErr.hidden = false;
    listErr.textContent = text;
  }

  function load() {
    showListError('');
    queueEl.innerHTML = '<li class="q-loading">正在加载…</li>';
    fetch('/api/review/list', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          if (r_unauthorized(j)) return;
          showListError('加载待审列表失败：' + (j.error || '未知错误'));
          queueEl.innerHTML = '';
          return;
        }
        render(j.items || []);
      })
      .catch(function (e) {
        showListError('加载待审列表失败：' + e.message);
        queueEl.innerHTML = '';
      });
  }

  function r_unauthorized(j) {
    if (/未登录/.test(j.error || '')) {
      gate.hidden = false;
      board.hidden = true;
      return true;
    }
    return false;
  }

  /* ============================================================
     队列条目四种状态的显示文字
     ============================================================ */
  var STATE_TEXT = {
    pending: '待审核',
    approved: '已进 fork',
    pushed: '已上线',
    rejected: '已拒绝'
  };

  function render(items) {
    queueEl.innerHTML = '';
    emptyEl.hidden = items.length > 0;

    items.forEach(function (it) {
      var st = it.state || (it.pushed ? 'pushed' : (it.rejected ? 'rejected'
                : (it.approved ? 'approved' : 'pending')));
      var li = document.createElement('li');
      li.className = 'q-item st-' + st;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');

      var top = document.createElement('div');
      top.className = 'q-top';
      top.innerHTML =
        '<span class="q-id"></span>' +
        '<span class="q-college"></span>' +
        '<span class="q-count"></span>';
      top.querySelector('.q-id').textContent = it.id;
      top.querySelector('.q-college').textContent = it.collegeName;
      top.querySelector('.q-count').textContent =
        (it.files || []).length + ' 张';

      // 状态标签。四种状态都要看得见 —— 以前只有「已进 fork」，
      // 被拒绝的条目看起来和待审一模一样，管理员会重复处理。
      var flag = document.createElement('span');
      flag.className = 'q-flag';
      flag.textContent = STATE_TEXT[st] || st;
      top.insertBefore(flag, top.querySelector('.q-count'));
      li.appendChild(top);

      if (it.note) {
        var n = document.createElement('div');
        n.className = 'q-note';
        n.textContent = it.note;
        li.appendChild(n);
      }

      // 被拒绝的，把原因直接显示出来，不用点进去
      if (st === 'rejected' && it.rejected && it.rejected.adminNote) {
        var why = document.createElement('div');
        why.className = 'q-why';
        why.textContent = '拒绝原因：' + it.rejected.adminNote;
        li.appendChild(why);
      }

      // 已推送的，给个 PR 链接
      if (st === 'pushed' && it.pushed && it.pushed.prUrl) {
        var pr = document.createElement('a');
        pr.className = 'q-pr';
        pr.href = it.pushed.prUrl;
        pr.target = '_blank';
        pr.rel = 'noopener';
        pr.textContent = '查看 PR #' + it.pushed.prNumber;
        li.appendChild(pr);
      }

      var t = document.createElement('div');
      t.className = 'q-time';
      t.textContent = fmtTime(it.at);
      li.appendChild(t);

      var open = function () { openDrawer(it.id); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      queueEl.appendChild(li);
    });
  }

  /* ============================================================
     详情抽屉
     ============================================================ */

  function openDrawer(id) {
    current = { id: id };
    adminNote.value = '';
    dMsg.textContent = '';
    dTitle.textContent = '投稿 ' + id;
    dBody.innerHTML = '<p class="note">加载中…</p>';
    drawer.hidden = false;

    fetch('/api/review/detail?id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          if (r_unauthorized(j)) { closeDrawer(); return; }
          dBody.innerHTML = '<p class="note">' + esc(j.error || '加载失败') + '</p>';
          return;
        }
        renderDetail(j.item);
      })
      .catch(function (e) {
        dBody.innerHTML = '<p class="note">加载失败：' + esc(e.message) + '</p>';
      });
  }

  function renderDetail(it) {
    current = it;
    dTitle.textContent = '投稿 ' + it.id + ' · ' + it.collegeName;

    var totalKB = (it.files || []).reduce(function (a, f) { return a + (f.size || 0); }, 0);
    var html =
      '<div class="d-meta">' +
        '<span class="d-chip">学院 <b>' + esc(it.collegeName) + '</b></span>' +
        '<span class="d-chip">张数 <b>' + (it.files || []).length + '</b></span>' +
        '<span class="d-chip">合计 <b>' + fmtSize(totalKB) + '</b></span>' +
        '<span class="d-chip">时间 <b>' + fmtTime(it.at) + '</b></span>' +
      '</div>';

    if (it.note) {
      html += '<div class="d-note">' + esc(it.note) + '</div>';
    }

    html += '<div class="d-grid">';
    (it.previews || []).forEach(function (src, i) {
      var name = (it.files[i] || {}).name || '';
      html += '<figure class="d-shot" style="margin:0">' +
        '<img src="' + esc(src) + '" alt="' + esc(name) + '" loading="lazy">' +
        '<figcaption>' + esc(name) + '</figcaption></figure>';
    });
    html += '</div>';

    dBody.innerHTML = html;
  }

  function closeDrawer() {
    drawer.hidden = true;
    current = null;
  }

  drawerClose.addEventListener('click', closeDrawer);
  drawerBg.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
  });

  /* ============================================================
     动作：审核通过 / 拒绝
     ============================================================ */

  function act(kind) {
    if (!current) return;
    var id = current.id;

    if (kind === 'approve') {
      if (!confirm(
        '把投稿 ' + id + ' 写进小号的 fork？\n\n' +
        '这一步不动主仓库。写完之后你可以去 GitHub 上改名、删图、调顺序，' +
        '改满意了再点「推送到主仓库」。')) return;
    } else {
      if (!confirm('确定拒绝投稿 ' + id + '？')) return;
    }

    var buttons = [btnApprove, btnReject];
    buttons.forEach(function (b) { b.disabled = true; });
    dMsg.textContent = (kind === 'approve' ? '正在写入小号 fork…' : '正在拒绝…');

    var fd = new FormData();
    fd.append('id', id);
    fd.append('note', adminNote.value.trim());

    var url = kind === 'reject' ? '/api/review/reject' : '/api/review/approve';

    fetch(url, { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        buttons.forEach(function (b) { b.disabled = false; });
        if (!j.ok) {
          if (r_unauthorized(j)) { closeDrawer(); return; }
          dMsg.innerHTML = '<span style="color:var(--warn);white-space:pre-wrap">' +
            esc(j.error || '失败') + '</span>';
          return;
        }

        if (kind === 'approve') {
          // 审核通过 = 进了 fork。去「待推送」那一栏处理。
          dMsg.innerHTML = '<span style="color:var(--go)">已写入小号 fork。</span> ' +
            '<a href="' + esc(j.forkUrl) + '" target="_blank" rel="noopener">去看看 →</a>' +
            '<br><span style="font-size:12px;opacity:.8">' +
            '可以在这里改名、删图、调顺序，改完回下面「待推送到主仓库」推送。</span>';
          loadStage();          // 刷新待推送列表
        } else {
          dMsg.innerHTML = '<span style="color:var(--warn)">已拒绝。</span>';
        }

        load();                 // 刷新待审列表
      })
      .catch(function (e) {
        buttons.forEach(function (b) { b.disabled = false; });
        dMsg.innerHTML = '<span style="color:var(--warn)">' + esc(e.message) + '</span>';
      });
  }

  btnApprove.addEventListener('click', function () { act('approve'); });
  btnReject.addEventListener('click', function () { act('reject'); });

  /* ============================================================
     待推送区：已审核通过、还没提到主仓库的分支
     ============================================================ */
  function loadStage() {
    fetch('/api/review/pending-branches', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { return; }
        var items = j.items || [];
        stage.hidden = items.length === 0;

        // 现在所有内容都在 fork 的 main 上，所以分支是固定的，不用让用户选。
        var total = items.reduce(function (a, it) {
          return a + ((it.files && it.files.length) || 0);
        }, 0);
        stageList.innerHTML =
          '<li class="stage-item stage-summary">' +
            '<b>' + items.length + '</b> 条投稿、共 <b>' + total + '</b> 件作品，' +
            '都已在小号 fork 的 <code>main</code> 上' +
          '</li>' +
          items.slice(0, 20).map(function (it) {
            return '<li class="stage-item">' +
              '<span class="stage-branch">' + esc(it.collegeName || '') + '</span>' +
              '<span class="stage-meta">' + esc(it.id) + ' · ' +
                (it.files ? it.files.length : 0) + ' 张 · ' + fmtTime(it.at) + '</span>' +
              '</li>';
          }).join('') +
          (items.length > 20
            ? '<li class="stage-item"><span class="stage-meta">…还有 ' +
              (items.length - 20) + ' 条</span></li>'
            : '');
      })
      .catch(function (e) {
        stageMsg.innerHTML = '<span style="color:var(--warn)">读取待推列表失败：' +
          esc(e.message) + '</span>';
      });
  }

  $('btnPush').addEventListener('click', function () {
    if (!confirm('把 fork 的 main 上所有已审核通过的内容推送到主仓库（建一个 PR）？')) return;

    var b = $('btnPush');
    b.disabled = true;
    stageMsg.textContent = '正在推送…';

    var fd = new FormData();

    fetch('/api/review/push', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        b.disabled = false;
        if (!j.ok) {
          if (r_unauthorized(j)) return;
          stageMsg.innerHTML = '<span style="color:var(--warn);white-space:pre-wrap">' +
            esc(j.error || '失败') + '</span>';
          return;
        }
        stageMsg.innerHTML = '<span style="color:var(--go)">PR 建好了：</span> ' +
          '<a href="' + esc(j.prUrl) + '" target="_blank" rel="noopener">' +
          '#' + j.prNumber + '</a>' +
          '<br><span style="font-size:12px;opacity:.8">' +
          j.commits + ' 次提交 · ' + j.filesChanged + ' 个文件' +
          (j.colleges && j.colleges.length ? ' · ' + esc(j.colleges.join('、')) : '') +
          '</span>';
        loadStage();
      })
      .catch(function (e) {
        b.disabled = false;
        stageMsg.innerHTML = '<span style="color:var(--warn)">' + esc(e.message) + '</span>';
      });
  });

  $('reloadStage').addEventListener('click', loadStage);
  $('reload').addEventListener('click', function () { load(); loadStage(); });

  /* ============================================================
     工具
     ============================================================ */
  function fmtTime(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtSize(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  check();
})();