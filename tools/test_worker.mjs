import { MemR2 } from "./memr2.mjs";
import crypto from "node:crypto";

const DIR = "D:\\dev\\submit.宇宙奶龙大学.com";
const BASE = "http://127.0.0.1:8790";
const COLLEGE = "美术与设计学院";
const COLLEGE2 = "人文学院";

const ghCalls = [];
const sctCalls = [];      // Server酱 推送调用记录
// 假 GitHub 的「学院目录内容」。测试可以改它来模拟重名/空目录。
let dirListing = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";

  // ---- Server酱：记录请求，假装成功 ----
  if (url.includes("ft07.com")) {
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) {}
    sctCalls.push({ url, method, body,
      userAgent: (init && init.headers && (init.headers["User-Agent"] || init.headers["user-agent"])) || null,
      contentType: (init && init.headers && (init.headers["Content-Type"] || init.headers["content-type"])) || null });
    return new Response(JSON.stringify({ code: 0, message: "", data: {} }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }

  if (url.includes("api.github.com")) {
    // 小号身份（fork 的 owner 从这里反查）
    if (new URL(url).pathname === "/user") {
      return new Response(JSON.stringify({ login: "boringtip" }),
        { headers: { "Content-Type": "application/json" } });
    }
    const hdrs = (init && init.headers) || {};
    ghCalls.push({ t: "gh", method,
      url: url.replace("https://api.github.com", ""),
      auth: hdrs.Authorization,
      userAgent: hdrs["User-Agent"] || hdrs["user-agent"] || null,
      body: (init && init.body) ? String(init.body) : null });
    const H = { "Content-Type": "application/json" };
    const p = new URL(url).pathname;

    // GitHub 会因为缺 User-Agent 直接返回 403
    // ("Request forbidden by administrative rules")。
    // 这里直接当成失败，让测试能抓住漏加头的 bug。
    if (!(hdrs["User-Agent"] || hdrs["user-agent"])) {
      return new Response(JSON.stringify({
        message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header."
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    if (method === "GET" && /\/git\/ref\/heads\//.test(p))
      return new Response(JSON.stringify({ object: { sha: "basesha123" } }), { headers: H });
    if (method === "GET" && /\/contents\/.*list\.txt$/.test(p))
      return new Response(JSON.stringify({
        content: Buffer.from("旧A.webp\n旧B.webp\n").toString("base64"),
        sha: "listsha999" }), { headers: H });
    // 目录列举：findNameClash 用它查重名。
    // 默认返回一个「已经有 我的画.webp」的目录 ——
    // 这样才能测出重名拦截；要模拟空目录就设 dirListing = []。
    if (method === "GET" && p.includes("/contents/") && !/\/contents\/[^?]*\./.test(p)) {
      return new Response(JSON.stringify(dirListing), { headers: H });
    }
    if (method === "GET" && /\/contents\//.test(p))
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: H });
    if (method === "POST" && p.endsWith("/git/refs"))
      return new Response(JSON.stringify({ ok: true }), { headers: H });
    // PATCH git/refs：冲突恢复时强制对齐 fork 的 main 用
    if (method === "PATCH" && p.includes("/git/refs")) {
      return new Response(JSON.stringify({ ref: "refs/heads/main", object: { sha: "a".repeat(40) } }),
        { headers: H });
    }
    if (method === "PUT" && p.includes("/contents/"))
      return new Response(JSON.stringify({ ok: true }), { headers: H });
    // merge-upstream：approve 之前同步 fork 用它（缺了会导致 list.txt 基于旧版本，
    // PR 里出现删除别人的行）
    if (method === "POST" && p.endsWith("/merge-upstream"))
      return new Response(null, { status: 204, headers: H });
    // compare：推送时用来比对分支相对 main 改了什么
    if (method === "GET" && p.includes("/compare/")) {
      return new Response(JSON.stringify({
        total_commits: 2,
        files: [
          { filename: "works/美术与设计学院/我的画.webp", status: "added" },
          { filename: "works/美术与设计学院/第二张.png", status: "added" },
          { filename: "works/美术与设计学院/list.txt", status: "modified" }
        ]
      }), { headers: H });
    }
    if (method === "POST" && p.endsWith("/pulls"))
      return new Response(JSON.stringify({
        html_url: "https://github.com/Thomas455/nailong-university/pull/999",
        number: 999 }), { headers: H });
    if (method === "PUT" && p.endsWith("/merges"))
      return new Response(JSON.stringify({ sha: "mergesha" }), { headers: H });
    return new Response(JSON.stringify({ message: "unhandled " + method + " " + p }),
      { status: 404, headers: H });
  }
  return realFetch(input, init);
};


/* 模拟「管理页已绑定小号」—— 走真实的加密逻辑把 token 写进 R2 */
async function bindBot(env, token, login) {
  // 复刻 bot.js 的逻辑：AES-GCM + SHA-256(Client Secret) 作密钥
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(env.GITHUB_CLIENT_SECRET));
  const key = await crypto.subtle.importKey('raw', digest,
    { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  await env.SUBMIT_BUCKET.put("bot/token.enc", out);
  await env.SUBMIT_BUCKET.put("bot/meta.json",
    JSON.stringify({ login, boundAt: Date.now() }));
}

function makeEnv(over) {
  const bucket = new MemR2();
  return Object.assign({
    ASSETS: { fetch: async () => new Response("<html>static</html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } }) },
    SUBMIT_BUCKET: bucket,
    RATE_BUCKET: bucket,
    GITHUB_CLIENT_ID: "Iv1.testclientid",
    GITHUB_CLIENT_SECRET: "testsecret-do-not-use",
    ADMIN_LOGIN: "Thomas455",
    SCT_SENDKEY: "sctp12345tFAKEFAKEFAKE",
    RATE_LIMIT: "1800"
  }, over || {});
}

const mod = await import("file:///" + DIR.replace(/\\/g, "/") + "/src/worker.js");
const worker = mod.default;

async function call(env, path, opts = {}) {
  const r = await worker.fetch(new Request(BASE + path, opts), env);
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json: j, text: txt };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

function fdOf(fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files)
    fd.append("files", new File([new Uint8Array(PNG)], f.name, { type: f.type || "image/png" }));
  return fd;
}

const out = { steps: [], passed: 0, failed: 0 };
function ok(name, cond, extra) {
  if (cond) { out.passed++; out.steps.push("PASS  " + name); }
  else { out.failed++; out.steps.push("FAIL  " + name + (extra ? "  << " + extra : "")); }
}

const login = "Thomas455";
const ts = String(Date.now());
const sign = crypto.createHmac("sha256", "testsecret-do-not-use")
  .update(login + "." + ts).digest("hex");
const cookie = `admin_session=${login}.${ts}.${sign}`;

/* ===== 0. 投稿页的 GitHub 登录接口必须存在（回归测试）
   曾经因为重构把它标成 410，导致投稿页点登录直接报错。===== */
{
  const G = makeEnv();
  let gr = await call(G, "/api/login?nonce=abc123");
  ok("/api/login 不再是 410", gr.status !== 410, "status=" + gr.status);
  ok("  是 302 跳转", gr.status === 302, "status=" + gr.status);
  ok("  跳向 GitHub 授权页", true);

  // 直接读 Location 头，确认指向 github.com 且带了 public_repo
  const raw = await worker.fetch(new Request(BASE + "/api/login?nonce=abc123"), G);
  const loc = raw.headers.get("Location") || "";
  ok("  Location 指向 GitHub", loc.includes("github.com/login/oauth/authorize"), loc.slice(0, 60));
  ok("  要了 public_repo 权限", loc.includes("public_repo"));
  ok("  带上了 state 参数", /[?&]state=/.test(loc));
  const sc = raw.headers.get("Set-Cookie") || "";
  ok("  设了 submit_state cookie", sc.includes("submit_state="), sc.slice(0, 40));

  // /api/callback 缺参数时应该报 state 校验失败，而不是 410/500
  const cb = await worker.fetch(new Request(BASE + "/api/callback?code=x&state=y"), G);
  const cbTxt = await cb.text();
  ok("/api/callback 不是 410/500", cb.status === 200, "status=" + cb.status);
  ok("  提示 state 校验失败", cbTxt.includes("state"), cbTxt.slice(0, 120));
}

/* ===== 1. 配置接口不泄密 ===== */
const E = makeEnv();
let r = await call(E, "/api/guest/config");
ok("guest/config 200", r.status === 200);
ok("  告知用的是算术题验证", r.json && r.json.captcha === "math");
ok("  不含 BOT_TOKEN", r.text.indexOf("ghp_FAKE") === -1);
ok("  不含 GITHUB_CLIENT_SECRET", r.text.indexOf("testsecret") === -1);
ok("  不含 ADMIN_LOGIN", r.text.indexOf("Thomas455") === -1);
ok("  不含 GITHUB_CLIENT_SECRET", r.text.indexOf("testsecret") === -1);

/* ===== 2. 未登录一律 401 ===== */
r = await call(E, "/api/admin/session");
ok("admin/session 未登录 → false", r.json && r.json.loggedIn === false);
ok("review/list 未登录 401", (await call(E, "/api/review/list")).status === 401);
ok("review/list 伪造 cookie 401",
  (await call(E, "/api/review/list", { headers: { Cookie: "admin_session=a.b.c" } })).status === 401);
const fdNA = new FormData(); fdNA.append("id", "ABC123");
ok("review/approve 未登录 401",
  (await call(E, "/api/review/approve", { method: "POST", body: fdNA })).status === 401);
ok("review/push 未登录 401",
  (await call(E, "/api/review/push", { method: "POST", body: fdNA })).status === 401);
ok("review/reject 未登录 401",
  (await call(E, "/api/review/reject", { method: "POST", body: fdNA })).status === 401);
ok("review/image 未登录 401",
  (await call(E, "/api/review/image?id=ABC123&name=x.png")).status === 401);
ok("未授权时零 GitHub 写操作",
  ghCalls.filter(c => c.t === "gh" && (c.method === "POST" || c.method === "PUT")).length === 0);

/* ===== 3. 会话安全 ===== */
r = await call(E, "/api/admin/session", { headers: { Cookie: cookie } });
ok("有效签名 cookie → true", r.json && r.json.loggedIn === true);
ok("  返回登录名", r.json && r.json.login === login);
const badSig = crypto.createHmac("sha256", "wrong").update("hacker." + ts).digest("hex");
r = await call(E, "/api/admin/session", { headers: { Cookie: `admin_session=hacker.${ts}.${badSig}` } });
ok("签名错被拒", r.json && r.json.loggedIn === false);
r = await call(E, "/api/admin/session", { headers: { Cookie: `admin_session=hacker.${ts}.${sign}` } });
ok("签名对但不在白名单 → 拒", r.json && r.json.loggedIn === false);
const E6 = makeEnv({ ADMIN_LOGIN: "" });
r = await call(E6, "/api/admin/session", { headers: { Cookie: cookie } });
ok("ADMIN_LOGIN 没配 → 全拒", r.json && r.json.loggedIn === false);
ok("  这时列表也读不了",
  (await call(E6, "/api/review/list", { headers: { Cookie: cookie } })).status === 401);
const oldTs = String(Date.now() - 13 * 3600 * 1000);
const oldSign = crypto.createHmac("sha256", "testsecret-do-not-use")
  .update(login + "." + oldTs).digest("hex");
r = await call(E, "/api/admin/session", { headers: { Cookie: `admin_session=${login}.${oldTs}.${oldSign}` } });
ok("过期会话被拒", r.json && r.json.loggedIn === false);

/* 拿到一道题并算出正确答案（测试里要模拟真人答题） */
async function solve(env) {
  const r = await call(env, "/api/guest/challenge");
  if (!r.json || !r.json.ok) return null;
  // 题面形如 "3 + 4 = ?" 或 "9 − 2 = ?" 或 "3 × 5 = ?"
  const m = /(\d+)\s*([+−×])\s*(\d+)/.exec(r.json.question);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[3]);
  const ans = m[2] === "+" ? a + b : (m[2] === "−" ? a - b : a * b);
  return { challenge: r.json.challenge, answer: String(ans), question: r.json.question };
}
/* ===== 4. 输入校验（各自独立桶避免频控串场）===== */
let V = makeEnv();
r = await call(V, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: "../../etc/passwd", captchaAnswer: "1", captchaChallenge: "x" }, [{ name: "x.webp" }]) });
ok("路径穿越式学院名被拒", r.status === 400, "got " + r.status);

V = makeEnv();
r = await call(V, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: "不存在的学院", captchaAnswer: "1", captchaChallenge: "x" }, [{ name: "x.webp" }]) });
ok("不存在的学院被拒", r.status === 400, "got " + r.status);

V = makeEnv();
const fdEvil = new FormData();
fdEvil.append("college", COLLEGE); fdEvil.append("tsToken", "t");
fdEvil.append("files", new File([new TextEncoder().encode("#!/bin/sh\nrm -rf /")],
  "evil.webp", { type: "image/webp" }));
r = await call(V, "/api/guest/submit", { method: "POST", body: fdEvil });
ok("脚本改名成 .webp → 被拒", r.status === 400, "got " + r.status);

V = makeEnv();
const fdSvg = new FormData();
fdSvg.append("college", COLLEGE); fdSvg.append("tsToken", "t");
fdSvg.append("files", new File([new TextEncoder().encode('<svg onload="alert(1)"/>')],
  "x.svg", { type: "image/svg+xml" }));
r = await call(V, "/api/guest/submit", { method: "POST", body: fdSvg });
ok("SVG 被拒（防 XSS）", r.status === 400, "got " + r.status);

V = makeEnv();
r = await call(V, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: COLLEGE, captchaAnswer: "1", captchaChallenge: "x" }, []) });
ok("没带图被拒", r.status === 400, "got " + r.status);

/* ===== 5. 完整投稿 → 待审 → 发布 ===== */
const W = makeEnv();
// 先拿一道题，答对才让投稿通过（模拟真人答题）
const wCap = await solve(W);
ok("出题接口返回题目", Boolean(wCap && wCap.question), wCap && wCap.question);
r = await call(W, "/api/guest/submit", {
  method: "POST",
  body: fdOf({ college: COLLEGE, note: "测试留言",
               captchaAnswer: wCap.answer, captchaChallenge: wCap.challenge },
              [{ name: "我的画.webp" }, { name: "第二张.png" }]) });
ok("游客投稿成功（答对算术题）", r.status === 200 && r.json && r.json.ok === true, r.text.slice(0, 150));
const ID = r.json && r.json.id;
ok("编号 6 位且无易混字符",
  typeof ID === "string" && /^[0-9A-Z]{6}$/.test(ID) && !/[IO01]/.test(ID), String(ID));

// 答错要被拒，并要求换题
const W2 = makeEnv();
const badCap = await solve(W2);
r = await call(W2, "/api/guest/submit", {
  method: "POST",
  body: fdOf({ college: COLLEGE,
               captchaAnswer: String(Number(badCap.answer) + 1),
               captchaChallenge: badCap.challenge },
              [{ name: "x.webp" }]) });
ok("答错算术题被拒", r.status === 400, "got " + r.status);
ok("  并要求换新题", r.json && r.json.needNewChallenge === true, JSON.stringify(r.json));

// 完全不带答案也要被拒
const W3 = makeEnv();
r = await call(W3, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: COLLEGE }, [{ name: "x.webp" }]) });
ok("不带答案被拒", r.status === 400, "got " + r.status);

// 篡改 challenge 也必须被拒（签名的意义就在这）
const W4 = makeEnv();
const fCap = await solve(W4);
const tampered = fCap.challenge.replace(/\|(\d+)$/, "|999");
r = await call(W4, "/api/guest/submit", {
  method: "POST",
  body: fdOf({ college: COLLEGE, captchaAnswer: "999", captchaChallenge: tampered },
              [{ name: "x.webp" }]) });
ok("篡改 challenge 被拒", r.status === 400, "got " + r.status);

// 频控：同 IP 第二次提交（这次要答对题，否则测的是验证码而不是频控）
const cap2 = await solve(W);
r = await call(W, "/api/guest/submit", {
  method: "POST",
  body: fdOf({ college: COLLEGE,
               captchaAnswer: cap2.answer, captchaChallenge: cap2.challenge },
              [{ name: "y.webp" }]) });
ok("同 IP 第二次被频控", r.status === 429, "got " + r.status);

r = await call(W, "/api/guest/status?id=" + ID);
ok("状态 = pending", r.json && r.json.status === "pending", JSON.stringify(r.json));
r = await call(W, "/api/guest/status?id=ZZZZZZ");
ok("未知编号 = unknown", r.json && r.json.status === "unknown");
r = await call(W, "/api/guest/status?id=bad!");
ok("编号格式非法 400", r.status === 400);

r = await call(W, "/api/review/list", { headers: { Cookie: cookie } });
ok("管理员能读队列", r.status === 200 && r.json.ok, r.text.slice(0, 150));
ok("  队列里有这条",
  r.json && (r.json.items || []).some(i => i.id === ID),
  JSON.stringify(r.json && r.json.items || []));
ok("  响应不含凭据", r.text.indexOf("ghp_FAKE") === -1);

r = await call(W, "/api/review/detail?id=" + ID, { headers: { Cookie: cookie } });
ok("能看详情", r.status === 200 && r.json.ok);
ok("  2 个预览图链接",
  r.json && r.json.item.previews && r.json.item.previews.length === 2);
const pv = r.json.item.previews[0];
r = await call(W, pv, { headers: { Cookie: cookie } });
ok("  预览图带 cookie 取到", r.status === 200, "got " + r.status);
r = await call(W, "/api/review/detail?id=../../rl", { headers: { Cookie: cookie } });
ok("详情挡路径穿越", r.status === 400 || r.status === 404, "got " + r.status);

// 模拟管理页已绑定小号（真实流程是 OAuth 换 token 后加密存 R2）
await bindBot(W, "ghp_FAKE_BOT_TOKEN", "boringtip");

ghCalls.length = 0;

// ---- 审核通过 = 写进小号自己的 fork ----
const fdApprove = new FormData();
fdApprove.append("id", ID);
fdApprove.append("note", "内容没问题");
r = await call(W, "/api/review/approve", { method: "POST", headers: { Cookie: cookie }, body: fdApprove });
ok("审核通过（写进小号 fork）", r.status === 200 && r.json && r.json.ok === true, r.text.slice(0, 300));

const w = ghCalls.filter(c => c.t === "gh" && (c.method === "POST" || c.method === "PUT"));
// 同步必须发生在**写文件之前** —— 否则 list.txt 会基于旧版本，PR 里会删掉别人的行
const syncIdx = ghCalls.findIndex(c => c.url.includes("/merge-upstream"));
const firstWrite = ghCalls.findIndex(c => c.method === "PUT" && c.url.includes("/contents/"));
ok("  先同步 fork 再写文件",
  syncIdx >= 0 && firstWrite >= 0 && syncIdx < firstWrite,
  "sync@" + syncIdx + " firstWrite@" + firstWrite);
ok("  写进的是 fork（URL 里是小号 boringtip）",
  w.length > 0 && w.every(c => c.url.indexOf("/repos/boringtip/") === 0),
  JSON.stringify(w.map(c => c.url.slice(0, 70))));
// 新模型：不再建分支，直接提交到 fork 的 main
ok("  没有新建 guest 分支", !ghCalls.some(c => c.url.includes("/git/refs")),
  JSON.stringify(ghCalls.filter(c => c.url.includes("/git/refs")).map(c => c.url)));
ok("  文件写在 main 上",
  w.some(c => c.method === "PUT" && /[?&]branch=main/.test(c.url) || String(c.body || "").indexOf('"branch":"main"') >= 0) ||
  ghCalls.some(c => c.method === "PUT" && c.body && String(c.body).indexOf('"branch":"main"') >= 0),
  "检查 PUT 的 body 里 branch 是不是 main");
ok("  传了 2 张图",
  w.filter(c => c.method === "PUT" && c.url.includes("/contents/") &&
    c.url.indexOf("list.txt") === -1).length === 2);
ok("  改了 list.txt", w.some(c => c.url.includes("list.txt")));
ok("  还没建 PR（那是「推送」那一步）", !w.some(c => c.url.endsWith("/pulls")));
ok("  每次请求都带 User-Agent",
  w.length > 0 && w.every(c => c.userAgent && String(c.userAgent).length > 0),
  JSON.stringify(w.map(c => c.userAgent)));
ok("  返回了 fork 链接（main）", Boolean(r.json && r.json.forkUrl));
ok("  返回的分支就是 main", r.json && r.json.branch === "main", r.json && r.json.branch);

r = await call(W, "/api/review/pending-branches", { headers: { Cookie: cookie } });
ok("待推送列表里有这条",
  r.json && (r.json.items || []).some(x => x.id === ID),
  JSON.stringify(r.json && r.json.items));

// ---- 推送 = fork 的 main → 主仓库 main ----
ghCalls.length = 0;
r = await call(W, "/api/review/push", { method: "POST", headers: { Cookie: cookie }, body: new FormData() });
ok("推送建 PR 成功", r.status === 200 && r.json && r.json.ok === true, r.text.slice(0, 300));

const pw = ghCalls.filter(c => c.t === "gh");
ok("  比对了差异", pw.some(c => c.url.includes("/compare/")));
const prCall = pw.find(c => c.url.endsWith("/pulls"));
ok("  建了 PR（提到主仓库）",
  Boolean(prCall) && prCall.url.indexOf("/repos/Thomas455/") >= 0,
  prCall && prCall.url);
ok("  PR 的 head 是 fork 的 main（boringtip:main）",
  prCall && String(prCall.body || "").indexOf('"head":"boringtip:main"') >= 0,
  prCall && String(prCall.body || "").slice(0, 200));
ok("  PR 的 base 是主仓库 main",
  prCall && String(prCall.body || "").indexOf('"base":"main"') >= 0);
ok("  带上了 PR 链接", r.json && typeof r.json.prUrl === "string");
ok("  带上了改动统计", r.json && r.json.commits >= 0 && r.json.filesChanged >= 0,
  JSON.stringify({ c: r.json && r.json.commits, f: r.json && r.json.filesChanged }));
ok("  识别出涉及的学院", r.json && (r.json.colleges || []).length > 0,
  JSON.stringify(r.json && r.json.colleges));

// 投稿人能查到
r = await call(W, "/api/guest/status?id=" + ID);
ok("推送后投稿状态 = pushed", r.json && r.json.status === "pushed", JSON.stringify(r.json));
ok("  投稿人拿到 PR 链接", r.json && typeof r.json.prUrl === "string");

r = await call(W, "/api/review/list", { headers: { Cookie: cookie } });
// 新设计里「审核通过」不删条目，只打 approved 标记（方便你回头看）。
// 它会一直留在列表里，直到你清理 —— 这里断言标记已生效。
ok("审核通过的条目仍留在列表（带已通过标记）",
  r.json && (r.json.items || []).some(x => x.id === ID && x.approved && x.approved.branch),
  JSON.stringify((r.json && r.json.items || []).map(x => ({ id: x.id, ap: !!x.approved }))));

/* ===== 6. 拒绝流程 ===== */
const X = makeEnv();
const cap3 = await solve(X);
r = await call(X, "/api/guest/submit", {
  method: "POST",
  body: fdOf({ college: COLLEGE2,
               captchaAnswer: cap3.answer, captchaChallenge: cap3.challenge },
              [{ name: "y.webp" }]) });
ok("第二条投稿成功", r.status === 200, r.text.slice(0, 120));
const ID2 = r.json.id;
const fdRej = new FormData();
fdRej.append("id", ID2); fdRej.append("note", "内容不合适");
ghCalls.length = 0;
r = await call(X, "/api/review/reject", { method: "POST", headers: { Cookie: cookie }, body: fdRej });
ok("拒绝成功", r.status === 200 && r.json.ok, r.text.slice(0, 150));
ok("  拒绝不调 GitHub", ghCalls.filter(c => c.t === "gh").length === 0);
r = await call(X, "/api/guest/status?id=" + ID2);
ok("  投稿人看到 rejected", r.json && r.json.status === "rejected", JSON.stringify(r.json));
ok("  投稿人看到拒绝原因", r.json && /不合适/.test(r.json.note || ""));

// ---- 拒绝后管理页要能看出来（回归测试）----
r = await call(X, "/api/review/list", { headers: { Cookie: cookie } });
const rejectedItem = (r.json && r.json.items || []).find(x => x.id === ID2);
ok("拒绝后仍留在管理页列表里", Boolean(rejectedItem));
ok("  状态标成 rejected（以前只读 _approved，拒绝的看起来和待审一样）",
  rejectedItem && rejectedItem.state === "rejected", rejectedItem && rejectedItem.state);
ok("  rejected 字段有内容", rejectedItem && rejectedItem.rejected &&
  typeof rejectedItem.rejected.at === "number", JSON.stringify(rejectedItem && rejectedItem.rejected));
ok("  approved 已被清掉（拒绝=撤回通过）",
  rejectedItem && !rejectedItem.approved, JSON.stringify(rejectedItem && rejectedItem.approved));

/* ===== 7. 没绑小号 / 没配存储时的行为 ===== */

// 没绑小号 → approve 要明确提示，而不是报一堆 GitHub 错误
const NB = makeEnv();
const capNB = await solve(NB);
const fdNB = new FormData();
fdNB.append("id", "AAAAAA");
fdNB.append("college", COLLEGE);
fdNB.append("captchaAnswer", capNB.answer);
fdNB.append("captchaChallenge", capNB.challenge);
fdNB.append("files", new File([new Uint8Array(PNG)], "x.webp", { type: "image/webp" }));
r = await call(NB, "/api/guest/submit", { method: "POST", body: fdNB });
const idNB = r.json && r.json.id;
ok("没绑小号也能先投稿（游客投稿不依赖小号）", r.status === 200, "got " + r.status);

if (idNB) {
  const fdA = new FormData();
  fdA.append("id", idNB);
  r = await call(NB, "/api/review/approve", { method: "POST", headers: { Cookie: cookie }, body: fdA });
  ok("  但「审核通过」会提示先绑定小号",
    r.json && /绑定小号/.test(r.json.error || ""), JSON.stringify(r.json));
}

// 真的没配存储时才挡
const NOSTORE = { ...makeEnv(), SUBMIT_BUCKET: undefined };
r = await call(NOSTORE, "/api/guest/config");
ok("没配存储时 config 返回 ready:false", r.json && r.json.ready === false);
r = await call(NOSTORE, "/api/guest/challenge");
ok("没配存储时出题接口 503", r.status === 503, "got " + r.status);

/* ===== 8. Server酱 推送 ===== */

// 游客投稿应触发推送
const E2 = makeEnv();
const capE2 = await solve(E2);
sctCalls.length = 0;
const fdSct = new FormData();
fdSct.append("college", COLLEGE);
fdSct.append("note", "测试推送");
fdSct.append("captchaAnswer", capE2.answer);
fdSct.append("captchaChallenge", capE2.challenge);
fdSct.append("files", new File([new Uint8Array(PNG)], "作品.webp", { type: "image/webp" }));
r = await call(E2, "/api/guest/submit", { method: "POST", body: fdSct });
ok("投稿成功（推送不影响结果）", r.status === 200, "got " + r.status);

// 推送是 fire-and-forget，等它一下
await new Promise((r2) => setTimeout(r2, 300));
ok("游客投稿触发了推送", sctCalls.length === 1, "sctCalls=" + sctCalls.length);

if (sctCalls.length) {
  const s = sctCalls[0];
  ok("  用 POST", s.method === "POST", s.method);
  // URL 拼法照**官方 API 文档**（doc.sc3.ft07.com/zh/serverchan3/server/api）：
  //     https://<uid>.push.ft07.com/send/<sendkey>.send
  //   uid 从 sendkey 里用 /^sctp(\d+)t/ 提取。
  //
  // ⚠️ 这条断言以前写反了 —— 它断言的是「整串 sendkey 当子域名」，
  //    而那正是官方在 SDK 1.0.7 修正掉的 1.0.6 过时写法
  //    （commit 767d366「修正 1.0.6 遗留的 sctp URL 拼接」）。
  //    也就是说测试当时在给 bug 背书。两种拼法都有泛域名解析、
  //    都不报网络错，只是返回 code:10003 sendkey not found。
  ok("  URL = https://<uid>.push.ft07.com/send/<sendkey>.send",
    s.url === "https://12345.push.ft07.com/send/sctp12345tFAKEFAKEFAKE.send", s.url);
  ok("  子域名是提取出的 uid 数字（不是整串 sendkey）",
    s.url.indexOf("sctp12345tFAKEFAKEFAKE.push") < 0, s.url);
  ok("  带上了 User-Agent（漏了会被服务端 403）",
    s.userAgent === "nailong-submit-worker", String(s.userAgent));
  ok("  Content-Type 带 charset=utf-8（和官方 SDK 一致）",
    s.contentType === "application/json;charset=utf-8", String(s.contentType));
  ok("  标签参数名是 tags（文档里是复数）",
    s.body && typeof s.body.tags === "string", JSON.stringify(Object.keys(s.body || {})));
  ok("  标签值 = 'submit of 奶龙'",
    s.body && s.body.tags === "submit of 奶龙", s.body && s.body.tags);
  ok("  有标题和正文", Boolean(s.body && s.body.title && s.body.desp));
  ok("  正文里有投稿编号", s.body && /`[0-9A-Z]{6}`/.test(s.body.desp || ""),
    s.body && String(s.body.desp).slice(0, 80));
  ok("  正文里有学院名", s.body && String(s.body.desp).includes(COLLEGE));
  ok("  没有泄露 uid/sendkey 到正文",
    s.body && !String(s.body.desp).includes("12345") &&
    !String(s.body.desp).includes("sctp"),
    s.body && String(s.body.desp).slice(0, 60));
}

/* ===== 9. 推送日志：成功也要记，且绝不泄露 sendkey ===== */
// 抓 console 输出，确认每次推送都留了痕。
// 以前只在失败时打日志，于是线上看到「投稿 200 但一条推送记录都没有」，
// 完全分不清是「没配 sendkey」还是「发出去了但没收到微信」。
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(" ")); };

// 成功路径
{
  const LG = makeEnv();
  sctCalls.length = 0;
  logs.length = 0;
  const capL = await solve(LG);
  const fdL = new FormData();
  fdL.append("college", COLLEGE);
  fdL.append("captchaAnswer", capL.answer);
  fdL.append("captchaChallenge", capL.challenge);
  fdL.append("files", new File([new Uint8Array(PNG)], "log.webp", { type: "image/webp" }));
  r = await call(LG, "/api/guest/submit", { method: "POST", body: fdL });
  await new Promise((x) => setTimeout(x, 300));

  const sctLog = logs.filter((x) => x.indexOf("SCT") === 0);
  ok("推送成功后写了日志", sctLog.length > 0, "共 " + logs.length + " 条日志");
  if (sctLog.length) {
    ok("  日志里有 ok:true", sctLog.join(" ").indexOf('"ok":true') >= 0, sctLog[0].slice(0, 140));
    ok("  日志带上了学院名", sctLog.join(" ").indexOf(COLLEGE) >= 0, sctLog[0].slice(0, 140));
    ok("  ★ 日志里绝不能出现 sendkey",
      sctLog.join(" ").indexOf("sctp12345tFAKEFAKEFAKE") < 0,
      sctLog.join(" ").slice(0, 160));
    ok("  ★ 日志里绝不能出现裸 uid", sctLog.join(" ").indexOf("12345") < 0,
      sctLog.join(" ").slice(0, 160));
  }
}

// 没配 sendkey 的路径也要留痕
{
  const NS = { ...makeEnv(), SCT_SENDKEY: "" };
  sctCalls.length = 0;
  logs.length = 0;
  const capN = await solve(NS);
  const fdN = new FormData();
  fdN.append("college", COLLEGE);
  fdN.append("captchaAnswer", capN.answer);
  fdN.append("captchaChallenge", capN.challenge);
  fdN.append("files", new File([new Uint8Array(PNG)], "n.webp", { type: "image/webp" }));
  r = await call(NS, "/api/guest/submit", { method: "POST", body: fdN });
  ok("没配 sendkey 也能投稿", r.status === 200, "got " + r.status);
  await new Promise((x) => setTimeout(x, 300));
  ok("  不会真的请求推送服务", sctCalls.length === 0, "sctCalls=" + sctCalls.length);
  ok("  ★ 但会记一条 skipped 日志（以前完全静默，线上查不出原因）",
    logs.some((x) => x.indexOf("NO_SENDKEY") >= 0), "logs=" + logs.length);
}

console.log = origLog;

// 没配 SCT 时应该静默跳过，不影响投稿
const NO_SCT = { ...makeEnv(), SCT_SENDKEY: "" };
const capNS = await solve(NO_SCT);
sctCalls.length = 0;
const fdNS = new FormData();
fdNS.append("college", COLLEGE);
fdNS.append("captchaAnswer", capNS.answer);
fdNS.append("captchaChallenge", capNS.challenge);
fdNS.append("files", new File([new Uint8Array(PNG)], "y.webp", { type: "image/webp" }));
r = await call(NO_SCT, "/api/guest/submit", { method: "POST", body: fdNS });
ok("没配 Server酱 也能投稿", r.status === 200, "got " + r.status);
await new Promise((r2) => setTimeout(r2, 200));
ok("  且不会真的去请求推送服务", sctCalls.length === 0, "sctCalls=" + sctCalls.length);

// 浏览器那条路：/api/notify/gh-submission
sctCalls.length = 0;
r = await call(E, "/api/notify/gh-submission", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "some-student", job: { collegeName: COLLEGE, note: "作品不错" }, files: ["a.webp"] })
});
ok("登录投稿的通知接口接受请求", r.status === 200, "got " + r.status + " " + r.text.slice(0, 80));
await new Promise((r2) => setTimeout(r2, 200));
ok("  并发出推送", sctCalls.length === 1, "sctCalls=" + sctCalls.length);
if (sctCalls.length) {
  ok("  带上投稿人", String(sctCalls[0].body.desp).includes("some-student"));
  ok("  标签正确", sctCalls[0].body.tags === "submit of 奶龙");
}

// 防刷：参数不合法的一律拒
const bad = [
  ["login 不合法", { login: "bad name!!", job: { collegeName: COLLEGE }, files: [] }],
  ["学院不在名单", { login: "someone", job: { collegeName: "不存在的学院" }, files: [] }],
  ["文件太多", { login: "someone", job: { collegeName: COLLEGE }, files: new Array(30).fill("a.webp") }],
  ["文件名过长", { login: "someone", job: { collegeName: COLLEGE }, files: ["x".repeat(200)] }],
  ["留言过长", { login: "someone", job: { collegeName: COLLEGE, note: "y".repeat(600) }, files: [] }]
];
for (const [label, payload] of bad) {
  r = await call(E, "/api/notify/gh-submission", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  ok("防刷：" + label + " 被拒", r.status === 400, "got " + r.status);
}

/* ===== 10. bot 接口的鉴权（回归测试）=====
   之前 /api/bot/status 和 /api/bot/unbind 都是零鉴权：
     · 任何人 POST /unbind 就能删掉小号绑定 →「审核通过/推送」瘫痪
     · 任何人 GET /status 就能读出小号的 GitHub 用户名
   review.js 的 7 个接口都有 requireAdmin，就这里漏了。 */

// 未登录读不到绑定状态
r = await call(E, "/api/bot/status");
ok("bot/status 未登录 401", r.status === 401, "got " + r.status);

// 未登录不能解绑 —— 而且真的没删掉
await bindBot(E, "ghp_FAKE_BOT_TOKEN", "boringtip");
r = await call(E, "/api/bot/unbind", { method: "POST" });
ok("bot/unbind 未登录 401", r.status === 401, "got " + r.status);

// 确认 token 还在（不是只回了个 401，底下真删了）
r = await call(E, "/api/bot/status", { headers: { Cookie: cookie } });
ok("  未登录的解绑没有真删掉绑定",
  r.json && r.json.bound === true, JSON.stringify(r.json));

// 未登录时前端拿不到小号用户名
r = await call(E, "/api/bot/status");
ok("  未登录读不到小号用户名",
  r.status === 401 || !(r.json && r.json.login),
  JSON.stringify(r.json));

// 伪造 cookie 也不行
r = await call(E, "/api/bot/status", { headers: { Cookie: "admin_session=a.b.c" } });
ok("bot/status 伪造 cookie 401", r.status === 401, "got " + r.status);
r = await call(E, "/api/bot/unbind", { method: "POST", headers: { Cookie: "admin_session=a.b.c" } });
ok("bot/unbind 伪造 cookie 401", r.status === 401, "got " + r.status);

// 登录后正常工作
r = await call(E, "/api/bot/status", { headers: { Cookie: cookie } });
ok("bot/status 登录后正常", r.status === 200 && r.json && r.json.bound === true,
  r.status + " " + r.text.slice(0, 80));

// 登录后能真的解绑
r = await call(E, "/api/bot/unbind", { method: "POST", headers: { Cookie: cookie } });
ok("bot/unbind 登录后能解绑", r.status === 200 && r.json && r.json.ok === true,
  r.status + " " + r.text.slice(0, 80));
r = await call(E, "/api/bot/status", { headers: { Cookie: cookie } });
ok("  解绑后状态变成未绑定", r.json && r.json.bound === false, JSON.stringify(r.json));

/* ===== 11. 通知接口的频控（回归测试）=====
   /api/notify/gh-submission 原来无频控：任何人一条 curl 就能让你收到
   带自定义留言的通知，而 Server酱 免费档每天只有 5 条 ——
   被刷光之后正常投稿的通知也发不出去。 */

// 第一次放行
const RL = makeEnv();
const ghPayload = {
  login: "some-student",
  job: { collegeName: COLLEGE, note: "作品不错" },
  files: ["a.webp"]
};
r = await call(RL, "/api/notify/gh-submission", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(ghPayload)
});
ok("通知接口第一次放行", r.status === 200, "got " + r.status);

// 同一个 IP 紧接着再发 → 应该被频控挡下
r = await call(RL, "/api/notify/gh-submission", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(ghPayload)
});
ok("★ 同一 IP 第二次被频控挡下（原来完全没拦）", r.status === 429, "got " + r.status);

// 换个桶 = 换个 IP，应该独立计数
const RL2 = makeEnv();
r = await call(RL2, "/api/notify/gh-submission", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(ghPayload)
});
ok("  换个 IP 不受影响", r.status === 200, "got " + r.status);

// 非法请求（400）不该占用额度 —— 先灌一条坏的，再灌一条好的
const RL3 = makeEnv();
r = await call(RL3, "/api/notify/gh-submission", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "bad name!!", job: { collegeName: COLLEGE }, files: [] })
});
ok("  非法请求先被 400 拒（不算刷）", r.status === 400, "got " + r.status);
r = await call(RL3, "/api/notify/gh-submission", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(ghPayload)
});
ok("★ 被 400 拒掉的请求不占用频控额度", r.status === 200, "got " + r.status);

/* ===== 12. 文件名重名检查 =====
   两处，存储不同、后果也不同，但都要拦：
   · 投稿时同批次重名 —— R2 同一个 key，后写**静默覆盖**前写；
   · 审核时目标目录撞名 —— GitHub 的 PUT 不带 sha，已存在会 **422**，
     中途失败还会在 fork 留下先上传的半成品，重试也不自愈
     （实测确认过：不带 sha PUT 已存在文件 → 422，内容不变）。 */

// ---- 12a. 同一次提交内部重名 ----
{
  const D1 = makeEnv();
  const capD = await solve(D1);
  dirListing = [];
  const fdDup = new FormData();
  fdDup.append("college", COLLEGE);
  fdDup.append("captchaAnswer", capD.answer);
  fdDup.append("captchaChallenge", capD.challenge);
  // 两张都叫「我的画」，只是后缀不同 —— 消毒后扩展名由魔数决定，
  // 所以会撞成同一个文件名
  fdDup.append("files", new File([new Uint8Array(PNG)], "我的画.png", { type: "image/png" }));
  fdDup.append("files", new File([new Uint8Array(PNG)], "我的画.jpg", { type: "image/jpeg" }));
  r = await call(D1, "/api/guest/submit", { method: "POST", body: fdDup });
  ok("★ 同一次提交里文件名重复 → 拒绝", r.status === 400, "got " + r.status);
  ok("  错误信息说清了是重名",
    r.json && /重名/.test(r.json.error || ""), JSON.stringify(r.json));

  // 改成不同名字应该放过
  const D2 = makeEnv();
  const capD2 = await solve(D2);
  const fdOk = new FormData();
  fdOk.append("college", COLLEGE);
  fdOk.append("captchaAnswer", capD2.answer);
  fdOk.append("captchaChallenge", capD2.challenge);
  fdOk.append("files", new File([new Uint8Array(PNG)], "我的画A.png", { type: "image/png" }));
  fdOk.append("files", new File([new Uint8Array(PNG)], "我的画B.png", { type: "image/png" }));
  r = await call(D2, "/api/guest/submit", { method: "POST", body: fdOk });
  ok("  名字不同则正常通过", r.status === 200, "got " + r.status);

  // 大小写不同也算重名（GitHub/Windows/macOS 上是同一个文件）
  const D3 = makeEnv();
  const capD3 = await solve(D3);
  const fdCase = new FormData();
  fdCase.append("college", COLLEGE);
  fdCase.append("captchaAnswer", capD3.answer);
  fdCase.append("captchaChallenge", capD3.challenge);
  fdCase.append("files", new File([new Uint8Array(PNG)], "MyArt.png", { type: "image/png" }));
  fdCase.append("files", new File([new Uint8Array(PNG)], "myart.png", { type: "image/png" }));
  r = await call(D3, "/api/guest/submit", { method: "POST", body: fdCase });
  ok("★ 只有大小写不同也算重名", r.status === 400, "got " + r.status);
}

// ---- 12b. 目标目录里已有同名文件 → 审核时拒绝 ----
{
  const A = makeEnv();
  await bindBot(A, "ghp_FAKE_BOT_TOKEN", "boringtip");
  const capA = await solve(A);
  dirListing = [];
  const fdA = new FormData();
  fdA.append("college", COLLEGE);
  fdA.append("captchaAnswer", capA.answer);
  fdA.append("captchaChallenge", capA.challenge);
  fdA.append("files", new File([new Uint8Array(PNG)], "撞名作品.png", { type: "image/png" }));
  r = await call(A, "/api/guest/submit", { method: "POST", body: fdA });
  const idA = r.json && r.json.id;
  ok("先投一条（此时目录是空的）", r.status === 200 && !!idA, r.text.slice(0, 120));

  if (idA) {
    // 目录里现在有同名文件了
    dirListing = [{ name: "撞名作品.png", type: "file", sha: "x" }];
    ghCalls.length = 0;
    const fdAp = new FormData();
    fdAp.append("id", idA);
    fdAp.append("note", "ok");
    r = await call(A, "/api/review/approve", {
      method: "POST", headers: { Cookie: cookie }, body: fdAp
    });

    ok("★ 目标目录已有同名文件 → 审核被拒",
      r.status === 409, "got " + r.status + " " + r.text.slice(0, 140));
    ok("  错误信息点明了是重名",
      r.json && /已经有叫/.test(r.json.error || ""), JSON.stringify(r.json).slice(0, 160));
    ok("  带了 nameClash 标记（前端好区分处理）",
      r.json && r.json.nameClash === true);
    ok("  ★ 一个文件都没写进去（否则就是覆盖）",
      !ghCalls.some((c) => c.method === "PUT" && c.url.includes("/contents/")),
      JSON.stringify(ghCalls.filter((c) => c.method === "PUT").map((c) => c.url)));

    // 被拒的这条不能算「已审核通过」，否则推送时会重放
    r = await call(A, "/api/review/list", { headers: { Cookie: cookie } });
    const it = (r.json && r.json.items || []).find((x) => x.id === idA);
    ok("  ★ 没写 _approved.json（不会被当成待推送重放）",
      it && !it.approved, JSON.stringify(it && it.approved));

    // list.txt 也不该动
    ok("  list.txt 没被改",
      !ghCalls.some((c) => c.method === "PUT" && c.url.includes("list.txt")));
  }

  // 目录里换成别的名字 → 应该放过
  if (idA) {
    dirListing = [{ name: "别的作品.png", type: "file", sha: "x" }];
    ghCalls.length = 0;
    const fdOk2 = new FormData();
    fdOk2.append("id", idA);
    r = await call(A, "/api/review/approve", {
      method: "POST", headers: { Cookie: cookie }, body: fdOk2
    });
    ok("  目录里是别的名字则正常通过", r.status === 200 && r.json && r.json.ok === true,
      r.status + " " + r.text.slice(0, 140));
  }
}

// ---- 12c. list.txt 不算重名（它本来就在目录里）----
{
  const B = makeEnv();
  await bindBot(B, "ghp_FAKE_BOT_TOKEN", "boringtip");
  const capB = await solve(B);
  dirListing = [{ name: "list.txt", type: "file", sha: "x" }];
  const fdB = new FormData();
  fdB.append("college", COLLEGE);
  fdB.append("captchaAnswer", capB.answer);
  fdB.append("captchaChallenge", capB.challenge);
  fdB.append("files", new File([new Uint8Array(PNG)], "新作品.png", { type: "image/png" }));
  r = await call(B, "/api/guest/submit", { method: "POST", body: fdB });
  const idB = r.json && r.json.id;
  if (idB) {
    r = await call(B, "/api/review/approve", {
      method: "POST", headers: { Cookie: cookie },
      body: (() => { const x = new FormData(); x.append("id", idB); return x; })()
    });
    ok("目录里的 list.txt 不会被当成重名", r.status === 200, r.status + " " + r.text.slice(0, 120));
  }
  dirListing = [];
}

console.log("__RESULT__" + JSON.stringify(out));
