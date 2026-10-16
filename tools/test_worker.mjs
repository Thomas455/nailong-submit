import { MemR2 } from "./memr2.mjs";
import crypto from "node:crypto";

const DIR = "D:\\dev\\submit.宇宙奶龙大学.com";
const BASE = "http://127.0.0.1:8790";
const COLLEGE = "美术与设计学院";
const COLLEGE2 = "人文学院";

const ghCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const method = (init && init.method) || "GET";

  if (url.includes("challenges.cloudflare.com")) {
    ghCalls.push({ t: "turnstile" });
    return new Response(JSON.stringify({ success: true }),
      { headers: { "Content-Type": "application/json" } });
  }

  if (url.includes("api.github.com")) {
    ghCalls.push({ t: "gh", method,
      url: url.replace("https://api.github.com", ""),
      auth: init && init.headers && init.headers.Authorization });
    const H = { "Content-Type": "application/json" };
    const p = new URL(url).pathname;

    if (method === "GET" && /\/git\/ref\/heads\//.test(p))
      return new Response(JSON.stringify({ object: { sha: "basesha123" } }), { headers: H });
    if (method === "GET" && /\/contents\/.*list\.txt$/.test(p))
      return new Response(JSON.stringify({
        content: Buffer.from("旧A.webp\n旧B.webp\n").toString("base64"),
        sha: "listsha999" }), { headers: H });
    if (method === "GET" && /\/contents\//.test(p))
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: H });
    if (method === "POST" && p.endsWith("/git/refs"))
      return new Response(JSON.stringify({ ok: true }), { headers: H });
    if (method === "PUT" && p.includes("/contents/"))
      return new Response(JSON.stringify({ ok: true }), { headers: H });
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
    BOT_TOKEN: "ghp_FAKE_BOT_TOKEN",
    TURNSTILE_SITE_KEY: "0x4AAAA-test-site-key",
    TURNSTILE_SECRET: "0x4AAAA-test-secret",
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
ok("  暴露 site key（前端要用）", r.json && r.json.turnstileSiteKey === "0x4AAAA-test-site-key");
ok("  不含 BOT_TOKEN", r.text.indexOf("ghp_FAKE") === -1);
ok("  不含 TURNSTILE_SECRET", r.text.indexOf("0x4AAAA-test-secret") === -1);
ok("  不含 ADMIN_LOGIN", r.text.indexOf("Thomas455") === -1);
ok("  不含 GITHUB_CLIENT_SECRET", r.text.indexOf("testsecret") === -1);

/* ===== 2. 未登录一律 401 ===== */
r = await call(E, "/api/admin/session");
ok("admin/session 未登录 → false", r.json && r.json.loggedIn === false);
ok("review/list 未登录 401", (await call(E, "/api/review/list")).status === 401);
ok("review/list 伪造 cookie 401",
  (await call(E, "/api/review/list", { headers: { Cookie: "admin_session=a.b.c" } })).status === 401);
const fdNA = new FormData(); fdNA.append("id", "ABC123");
ok("review/publish 未登录 401",
  (await call(E, "/api/review/publish", { method: "POST", body: fdNA })).status === 401);
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

/* ===== 4. 输入校验（各自独立桶避免频控串场）===== */
let V = makeEnv();
r = await call(V, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: "../../etc/passwd", tsToken: "t" }, [{ name: "x.webp" }]) });
ok("路径穿越式学院名被拒", r.status === 400, "got " + r.status);

V = makeEnv();
r = await call(V, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: "不存在的学院", tsToken: "t" }, [{ name: "x.webp" }]) });
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
  method: "POST", body: fdOf({ college: COLLEGE, tsToken: "t" }, []) });
ok("没带图被拒", r.status === 400, "got " + r.status);

/* ===== 5. 完整投稿 → 待审 → 发布 ===== */
const W = makeEnv();
r = await call(W, "/api/guest/submit", {
  method: "POST",
  body: fdOf({ college: COLLEGE, note: "测试留言", tsToken: "t" },
             [{ name: "我的画.webp" }, { name: "第二张.png" }]) });
ok("游客投稿成功", r.status === 200 && r.json && r.json.ok === true, r.text.slice(0, 150));
const ID = r.json && r.json.id;
ok("编号 6 位且无易混字符",
  typeof ID === "string" && /^[0-9A-Z]{6}$/.test(ID) && !/[IO01]/.test(ID), String(ID));

r = await call(W, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: COLLEGE, tsToken: "t" }, [{ name: "y.webp" }]) });
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

ghCalls.length = 0;
const fdPub = new FormData();
fdPub.append("id", ID);
fdPub.append("note", "内容没问题，发布");
r = await call(W, "/api/review/publish", { method: "POST", headers: { Cookie: cookie }, body: fdPub });
ok("发布成功", r.status === 200 && r.json && r.json.ok === true, r.text.slice(0, 200));

const w = ghCalls.filter(c => c.t === "gh" && (c.method === "POST" || c.method === "PUT"));
ok("  建了分支", w.some(c => c.url.includes("/git/refs")));
ok("  传了 2 张图",
  w.filter(c => c.method === "PUT" && c.url.includes("/contents/") &&
    c.url.indexOf("list.txt") === -1).length === 2);
ok("  写了 list.txt", w.some(c => c.url.includes("list.txt")));
ok("  建了 PR", w.some(c => c.url.endsWith("/pulls")));
ok("  全用小号 token",
  w.length > 0 && w.every(c => c.auth === "Bearer ghp_FAKE_BOT_TOKEN"));

r = await call(W, "/api/guest/status?id=" + ID);
ok("发布后 = published", r.json && r.json.status === "published", JSON.stringify(r.json));
ok("  带 PR 链接", r.json && typeof r.json.prUrl === "string");
ok("  带 PR 编号", r.json && r.json.prNumber === 999);
ok("  带审核备注给投稿人", r.json && /没问题/.test(r.json.note || ""),
  JSON.stringify(r.json));

r = await call(W, "/api/review/list", { headers: { Cookie: cookie } });
ok("处理后队列空", r.json && (r.json.items || []).length === 0);

/* ===== 6. 拒绝流程 ===== */
const X = makeEnv();
r = await call(X, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: COLLEGE2, tsToken: "t" }, [{ name: "y.webp" }]) });
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

/* ===== 7. 未配置时挡住 ===== */
const Y = makeEnv({ BOT_TOKEN: "" });
r = await call(Y, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: COLLEGE, tsToken: "t" }, [{ name: "z.webp" }]) });
ok("BOT_TOKEN 没配 → 503", r.status === 503, "got " + r.status);

const Z = makeEnv({ TURNSTILE_SECRET: "" });
r = await call(Z, "/api/guest/submit", {
  method: "POST", body: fdOf({ college: COLLEGE, tsToken: "t" }, [{ name: "z.webp" }]) });
ok("Turnstile 没配 → 503", r.status === 503, "got " + r.status);

console.log("__RESULT__" + JSON.stringify(out));