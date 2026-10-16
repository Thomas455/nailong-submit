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
  var btnPublish = $('btnPublish'), btnPublishDirect = $('btnPublishDirect'), btnReject = $('btnReject');

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
        } else {
          gate.hidden = false;
          board.hidden = true;
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

  function render(items) {
    queueEl.innerHTML = '';
    emptyEl.hidden = items.length > 0;

    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'q-item';
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
      li.appendChild(top);

      if (it.note) {
        var n = document.createElement('div');
        n.className = 'q-note';
        n.textContent = it.note;
        li.appendChild(n);
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
     动作：发布 / 直接提交 / 拒绝
     ============================================================ */

  function act(kind) {
    if (!current) return;
    var id = current.id;
    var label = kind === 'publish' ? '发布' : (kind === 'direct' ? '直接提交' : '拒绝');
    if (!confirm('确定' + label + '投稿 ' + id + '？')) return;

    var buttons = [btnPublish, btnPublishDirect, btnReject];
    buttons.forEach(function (b) { b.disabled = true; });
    dMsg.textContent = label + '中…';

    var fd = new FormData();
    fd.append('id', id);
    fd.append('note', adminNote.value.trim());
    if (kind === 'direct') fd.append('skipPR', '1');

    var url = kind === 'reject' ? '/api/review/reject' : '/api/review/publish';

    fetch(url, { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        buttons.forEach(function (b) { b.disabled = false; });
        if (!j.ok) {
          if (r_unauthorized(j)) { closeDrawer(); return; }
          dMsg.innerHTML = '<span style="color:var(--warn)">' + esc(j.error || '失败') + '</span>';
          return;
        }
        var msg = '已' + label + '。';
        if (j.prUrl) msg += ' <a href="' + esc(j.prUrl) + '" target="_blank" rel="noopener">' +
          '查看 PR #' + j.prNumber + '</a>';
        dMsg.innerHTML = '<span style="color:var(--go)">' + msg + '</span>';
        closeDrawer();
        load();          // 列表里那条已经没了
      })
      .catch(function (e) {
        buttons.forEach(function (b) { b.disabled = false; });
        dMsg.innerHTML = '<span style="color:var(--warn)">' + esc(e.message) + '</span>';
      });
  }

  btnPublish.addEventListener('click', function () { act('publish'); });
  btnPublishDirect.addEventListener('click', function () { act('direct'); });
  btnReject.addEventListener('click', function () { act('reject'); });

  $('reload').addEventListener('click', load);

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