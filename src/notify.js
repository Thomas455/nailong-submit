/* ============================================================================
   Server酱³ 推送通知

   有人投稿时给你发一条微信消息。

   ---- 接口格式（来自官方文档）----
     POST https://<uid>.push.ft07.com/send/<sendkey>.send
     Body (application/json): { title, desp, tags, short }

   ⚠️ 参数名是 **`tags`（复数）**，不是 `tag`。多个标签用竖线 `|` 分隔。

   ---- 为什么 uid/sendkey 走环境变量 ----
   它们等于「谁能给你发消息」的钥匙 —— 泄露了别人就能骚扰你。
   所以只从环境变量读，**绝不写进代码、绝不进 git**。

   ---- 失败不影响投稿 ----
   推送失败只打日志，绝不让投稿请求跟着失败 ——
   通知是锦上添花，不是主流程。

   ---- 环境变量 ----
     SCT_SENDKEY  Server酱 的 sendkey（sctp<uid>t... 开头的是 Server酱³）
                  ⚠️ 等于「谁能给你发消息」的钥匙，泄露了别人就能骚扰你
   ============================================================================ */

// 防刷校验要复用学院名单和 json 助手
import { COLLEGES } from './config.js';
import { json } from './admin.js';

// 通知里带上的固定标签。文档要求标签用竖线分隔（参数名 tags）。
const TAG = 'submit of 奶龙';

/**
 * 发一条推送。不抛异常 —— 任何失败都吞掉并打日志。
 */
export async function notify(env, { title, desp, short }) {
  const sendkey = String(env.SCT_SENDKEY || '').trim();

  if (!sendkey) {
    // 没配 sendkey 就直接跳过 —— 原来连日志都不打，结果线上看到
    // 「投稿 200 但一条推送记录都没有」，完全分不清是没配还是没收到。
    // 记一条 skipped，之后在 Logs 里搜 SCT 就能一眼看出来。
    logSend(env, {
      ok: false, status: 0, code: 'NO_SENDKEY',
      message: '没配 SCT_SENDKEY，推送已跳过',
      title: title || '', short: short || '', url: ''
    });
    return { ok: false, skipped: true };
  }

  // URL 拼法照官方 SDK（serverchan-sdk）：
  //   sctp 开头的（Server酱³）→ https://<整串 sendkey>.push.ft07.com/send
  //   老的 → https://sctapi.ftqq.com/<sendkey>.send
  // ⚠️ sctp 那种是把**整串 sendkey**当子域名，不是只取 uid。
  //   我最初写成「uid.push.ft07.com/send/<sendkey>.send」，那和 SDK 不一致。
  const url = sendkey.startsWith('sctp')
    ? `https://${sendkey}.push.ft07.com/send`
    : `https://sctapi.ftqq.com/${encodeURIComponent(sendkey)}.send`;

  const body = {
    title: title || '新投稿',
    desp: desp || '',
    tags: TAG,          // ← 文档里是 tags（复数）
    short: short || ''
  };

  try {
    // 8 秒超时：推送服务挂了不能拖住投稿请求
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        // 官方 SDK 用的是 charset=utf-8，这里跟它一致
        'Content-Type': 'application/json;charset=utf-8',
        // ⚠️ User-Agent 显式带上。Workers 虽然会自动带 Cloudflare-Workers，
        //    但不能指望 —— 本项目之前就在 GitHub API 上因为漏这个头被 403 过
        //    （"Request forbidden by administrative rules"）。
        'User-Agent': 'nailong-submit-worker'
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    clearTimeout(timer);

    const txt = await r.text().catch(() => '');

    // 文档的返回体形如 { code: 0, message: '', data: { ... } }
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (e) {}

    const okFlag = r.ok && (!j || typeof j.code !== 'number' || j.code === 0);

    // ⚠️ **成功也要记一笔。**
    // 以前只在失败时打日志，于是「到底发没发出去」只能靠有没有收到微信来倒推 ——
    // 线上日志里看到投稿 200 但一条推送记录都没有，根本分不清是
    // 「没配 sendkey 被静默跳过」还是「发出去了只是没收到」。
    logSend(env, {
      ok: okFlag,
      status: r.status,
      code: (j && typeof j.code === 'number') ? j.code : null,
      message: (j && j.message) || txt.slice(0, 200),
      title: body.title,
      short: body.short,
      url: url.replace(sendkey, '<sendkey>')    // ⚠️ 绝不把 sendkey 写进日志
    });

    if (!okFlag) return { ok: false, status: r.status, code: (j && j.code) || null, message: (j && j.message) || '' };
    return { ok: true };
  } catch (e) {
    logSend(env, {
      ok: false, status: 0, code: null,
      message: String(e && e.message),
      title: body.title, short: body.short,
      url: url.replace(sendkey, '<sendkey>')
    });
    return { ok: false, error: String(e && e.message) };
  }
}

/* ============================================================
   推送日志

   去哪儿看：Cloudflare Dashboard → Worker nailong-submit → Logs
   搜 `SCT` 能看到每一次推送（成功和失败都记）。
   结构化输出，直接按 ok 字段筛：搜 `"ok":false` 只看失败的。

   顺带支持往自建日志服务发一份（可选，要配 WORKER_LOG_URL）。
   ⚠️ 绝不记录 sendkey —— Workers 日志会被 Cloudflare 保留，写进去等于泄露。
   ============================================================ */
function logSend(env, rec) {
  const safe = {
    ok: rec.ok,
    status: rec.status || 0,
    code: rec.code,
    short: rec.short || '',
    title: rec.title || '',
    msg: (rec.message || '').slice(0, 160)
  };

  try {
    console.log('SCT', JSON.stringify(safe));
  } catch (e) { /* 日志本身失败不影响推送 */ }

  const url = env.WORKER_LOG_URL;
  if (!url) return;
  try {
    fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'User-Agent': 'nailong-submit-worker' },
        env.WORKER_LOG_TOKEN ? { Authorization: 'Bearer ' + env.WORKER_LOG_TOKEN } : {}
      ),
      body: JSON.stringify(Object.assign({ at: Date.now(), env: 'submit' }, safe))
    }).catch(() => {});
  } catch (e) { /* 静默 */ }
}

/* ============================================================
   两种投稿的文案

   游客投稿：匿名，只给编号和学院
   登录投稿：有 GitHub 用户名，可信度高一些，PR 作者就是本人
   ============================================================ */

export function guestSubmissionNote(m, id) {
  const files = (m.files || []).map((f) => f.name);
  const lines = [];

  lines.push('**有新的游客投稿等你审核**');
  lines.push('');
  lines.push(`- 编号：\`${id}\``);
  lines.push(`- 学院：${m.collegeName}`);
  lines.push(`- 作品：${files.length} 件（${files.join('、')}）`);

  if (m.note) {
    lines.push('');
    lines.push('投稿留言：');
    lines.push('> ' + String(m.note).split(/\r?\n/).join('\n> '));
  }

  lines.push('');
  lines.push('去管理页处理：');
  lines.push('https://submit.xn--psszg58cydsdq780c.com/admin');

  return {
    title: `【游客投稿】${m.collegeName} · ${files.length} 件`,
    desp: lines.join('\n'),
    short: `${m.collegeName} 投了 ${files.length} 件作品`
  };
}

export function ghSubmissionNote(m, login) {
  const files = (m.files || []).map((f) => f.name);
  const lines = [];

  lines.push('**有新的 GitHub 登录投稿**');
  lines.push('');
  lines.push(`- 投稿人：[@${login}](https://github.com/${login})`);
  lines.push(`- 学院：${m.collegeName}`);
  lines.push(`- 作品：${files.length} 件（${files.join('、')}）`);

  if (m.note) {
    lines.push('');
    lines.push('投稿留言：');
    lines.push('> ' + String(m.note).split(/\r?\n/).join('\n> '));
  }

  lines.push('');
  lines.push('这次提交已经在你自己的 fork 上提了 PR，合并即可上线。');

  return {
    title: `【登录投稿】${login} · ${m.collegeName}`,
    desp: lines.join('\n'),
    short: `${login} 投了 ${files.length} 件作品`
  };
}

/* ============================================================
   给浏览器用的入口

   github.js 跑在浏览器里，没有 Server酱 的密钥（也不该有）。
   所以它 POST 到这个接口，由 Worker 代发。

   ⚠️ 这个接口是**公开的**（投稿页会调它），所以必须防刷：
      · 校验学院名必须在下拉名单里（不能随便填）
      · 校验 login 长得像 GitHub 用户名
      · 校验文件名格式
      · 单条消息长度上限
   否则别人可以拿它当「任意消息发送器」骚扰你。
   ============================================================ */
export async function notifyRoute(url, request, env) {
  if (url.pathname !== '/api/notify/gh-submission' || request.method !== 'POST') {
    return null;
  }

  // 只有登录投稿才需要发（游客那边服务端自己发）
  const ctype = request.headers.get('Content-Type') || '';
  if (ctype.indexOf('application/json') < 0) {
    return jsonErr('请求格式不对', 415);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonErr('请求格式不对', 400);
  }
  if (!body || typeof body !== 'object') return jsonErr('请求格式不对', 400);

  const login = String(body.login || '');
  const job = body.job || {};
  const collegeName = String(job.collegeName || '');
  const note = String(job.note || '');
  const files = Array.isArray(body.files) ? body.files.map(String) : [];

  // ---- 防刷校验 ----
  // GitHub 用户名：字母数字连字符，1~39 位
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(login)) {
    return jsonErr('参数不合法', 400);
  }
  // 学院名必须在名单里（和 guest.js 共用同一份）
  if (!COLLEGES.some((c) => c.name === collegeName)) {
    return jsonErr('学院名不合法', 400);
  }
  // 文件名：限制数量和长度，挡「传 10 万个超长字符串」这种滥用
  if (files.length > 20) return jsonErr('作品过多', 400);
  if (files.some((f) => f.length > 120)) return jsonErr('文件名过长', 400);
  // 留言长度
  if (note.length > 500) return jsonErr('留言过长', 400);

  const r = await notify(env, ghSubmissionNote(
    { collegeName, note, files: files.map((name) => ({ name })) }, login));

  // 一律返回 200：不给调用方反馈「推送成功没有」，
  // 免得被拿来当探测接口用。
  return new Response('{"ok":true}', {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}